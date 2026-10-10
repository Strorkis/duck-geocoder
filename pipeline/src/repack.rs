//! GeoParquetを、HTTP越しに部分読みしやすい形に並べ替えて書き直す。
//!
//! 変換直後のファイルは元データの並び順のまま全行が1つのrow groupに入っているため、
//! Parquetのrow group統計が何も絞り込めない。逆ジオコーディングのような点クエリでも
//! ジオメトリ列を丸ごと読むことになり、静的ホスティングでは実用にならない。
//!
//! **中身は変えない。** 行の並び替えとrow groupの分割、それに圧縮だけを行う。
//! 列構成・行数・`geo` メタデータはそのまま引き継ぐ。
//!
//! `optimize_geoparquet` (単体で回すとき) と、都市ごとのループから呼ぶとき
//! ([`crate::plateau`] の変換) の**両方から使う**ので lib に置いてある。
//! 変換したあとに別のコマンドを流す形だと、パックしていないファイルが
//! ディスクに積み上がる。
use crate::geoparquet::{CoveringBbox, covering_bbox};
use crate::spatial_pack::{self, Bbox};
use anyhow::{Context, Result, bail};
use arrow::array::{Array, Float64Array, RecordBatch, StructArray, UInt8Array, UInt32Array};
use arrow::compute::{concat_batches, take_record_batch};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::arrow_writer::ArrowWriter;
use parquet::basic::{Compression, ZstdLevel};
use parquet::file::metadata::KeyValue;
use parquet::file::properties::WriterProperties;
use std::fs::File;
use std::path::Path;

/// 並べ替えの結果。**呼び出し側が報告に使う**ので数字を返す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Packed {
    pub rows: usize,
    pub row_group_size: usize,
    pub row_groups: usize,
    pub input_bytes: u64,
    pub output_bytes: u64,
}

/// 1ファイルを並べ替えて書き直す。入力と同じパスを渡せば上書きできる。
///
/// `row_group_size` を `None` にすると、1行あたりのバイト数から自動で決める。
///
/// **全行をメモリに読む。** 空間的な並べ替えは全行のbboxが揃わないと決められないので、
/// ストリーミングはできない。港区の建物 (5.1万行) で実測56MB。
pub fn repack(input: &Path, output: &Path, row_group_size: Option<usize>) -> Result<Packed> {
    repack_with(input, output, row_group_size, Layout::LevelFirst, &[])
}

/// `lod` 列 (段) があるときの並べ方。段が無いファイルではどちらも同じ。
///
/// **読み込み1回の重さで決まる。** 配信元 (R2) は1回ごとに約0.45秒待たされ、転送は約2MB/秒
/// なので、1回余計に読むのは 約0.9MB 余計に読むのと同じ重さになる。DuckDB-WASM は1回ずつ
/// 順に読み、続けて読む間は読み取りを4倍ずつ伸ばす (16KB → 64KB → 256KB → …)。
/// 離れた場所を読むたびに 16KB からやり直しになるので、**要るものを隣り合わせに置く**のが効く。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// 段ごとに分け、段の中を場所で並べる。**線の粗い段**向け — 引いた表示で、
    /// 広い範囲の粗い段だけを続けて読む。
    LevelFirst,
    /// 場所 ([`CELL_TARGET_BYTES`] ぶんの広さ) ごとに分け、場所の中を段で並べる。**建物**向け —
    /// 寄った表示では同じ場所の全段を続けて読み、引いた表示では要らない段だけを飛ばす。
    /// 段ごとに分けると、寄った表示で段の数だけ離れた場所を読みに行き、段の中の行グループが
    /// 区全体に広がって範囲で読み飛ばせなくなっていた (2026-10-08、ズーム16で 18MB・58回)。
    ///
    /// **bbox の列を先頭に置く。** DuckDB は範囲の条件に使う bbox を先に読み、当たった
    /// 行グループの残りの列を読む。bbox が後ろにあると、読むたびに行グループの頭へ戻る。
    /// 測った結果は docs/pipeline.md の「建物の並べ方」。
    CellFirst,
}

/// [`Layout::CellFirst`] の場所1つぶんの目標バイト数 (全段の合計)。
/// 0.5〜4MB で比べて、寄った表示の往復と量の釣り合いがいちばん良かった。
pub const CELL_TARGET_BYTES: usize = 1024 * 1024;

/// [`repack`] の、`lod` 列の並べ方を選べる形。`extra` は KV に足すもの (同じキーは置き換える)。
pub fn repack_with(
    input: &Path,
    output: &Path,
    row_group_size: Option<usize>,
    layout: Layout,
    extra: &[(&str, &str)],
) -> Result<Packed> {
    let (batch, mut geo_metadata, covering) = read_all(input)?;
    geo_metadata.retain(|entry| !extra.iter().any(|(key, _)| *key == entry.key));
    for (key, value) in extra {
        geo_metadata.push(KeyValue::new(key.to_string(), value.to_string()));
    }
    let bboxes = read_bboxes(&batch, &covering)?;

    let input_bytes = std::fs::metadata(input)?.len();
    let row_group_size = row_group_size.unwrap_or_else(|| match layout {
        Layout::LevelFirst => spatial_pack::default_row_group_size(input_bytes, batch.num_rows()),
        Layout::CellFirst => {
            spatial_pack::row_group_size_for(CELL_TARGET_BYTES, input_bytes, batch.num_rows())
        }
    });

    let (order, segments) = match layout {
        Layout::LevelFirst => pack_by_level(&batch, &bboxes, row_group_size)?,
        Layout::CellFirst => pack_by_cell(&batch, &bboxes, row_group_size)?,
    };
    let indices = UInt32Array::from(order);
    let sorted = take_record_batch(&batch, &indices).context("行の並べ替えに失敗しました")?;
    let sorted = match layout {
        Layout::LevelFirst => sorted,
        Layout::CellFirst => column_first(&sorted, &covering.column)?,
    };

    // 書き込み中に落ちたときに元ファイルを壊さないよう、一時ファイル経由にする。
    let temporary = output.with_extension("parquet.writing");
    let row_groups = write(
        &temporary,
        &sorted,
        &geo_metadata,
        row_group_size,
        &segments,
    )?;
    std::fs::rename(&temporary, output)
        .with_context(|| format!("書き出したファイルを移せません: {}", output.display()))?;

    Ok(Packed {
        rows: sorted.num_rows(),
        row_group_size,
        row_groups,
        input_bytes,
        output_bytes: std::fs::metadata(output)?.len(),
    })
}

/// `lod` 列があれば**段ごとに空間パックして、段の小さい順に繋ぐ**。無ければ全行を
/// 1つの順序に並べる (これまでと同じ)。
///
/// 並べ替えた順序と、**段ごとの行数**を返す。行数は [`write`] が row group の
/// 区切りを段の境目に合わせるのに使う。
///
/// **段を混ぜてはいけない。** 混ぜると粗い行が全体に散らばり、
/// `WHERE lod = 0` でrow groupを読み飛ばせなくなる — 粗い段を置いた意味が消える。
/// 段の**中では**これまでと同じSTRパックが効くので、粗い段でも表示範囲で絞れる。
fn pack_by_level(
    batch: &RecordBatch,
    bboxes: &[Bbox],
    row_group_size: usize,
) -> Result<(Vec<u32>, Vec<usize>)> {
    let Some(levels) = read_levels(batch)? else {
        return Ok((
            spatial_pack::pack(bboxes, row_group_size)?,
            vec![bboxes.len()],
        ));
    };

    // 段ごとに行を集める。段の数は2〜3なので、素朴に回してよい。
    let mut distinct: Vec<u8> = levels.to_vec();
    distinct.sort_unstable();
    distinct.dedup();

    let mut order = Vec::with_capacity(bboxes.len());
    let mut segments = Vec::with_capacity(distinct.len());
    for level in distinct {
        let rows: Vec<u32> = (0..bboxes.len() as u32)
            .filter(|&i| levels[i as usize] == level)
            .collect();
        let subset: Vec<Bbox> = rows.iter().map(|&i| bboxes[i as usize]).collect();
        // パックが返すのは**部分集合の中での添字**なので、元の行番号に戻す。
        for packed in spatial_pack::pack(&subset, row_group_size)? {
            order.push(rows[packed as usize]);
        }
        segments.push(rows.len());
    }
    Ok((order, segments))
}

/// `name` の列を先頭に移す (ほかの列の順は変えない)。
fn column_first(batch: &RecordBatch, name: &str) -> Result<RecordBatch> {
    let schema = batch.schema();
    let first = schema
        .index_of(name)
        .with_context(|| format!("列がありません: {name}"))?;
    let mut indices = vec![first];
    indices.extend((0..schema.fields().len()).filter(|&i| i != first));
    Ok(batch.project(&indices)?)
}

/// 全行を場所で並べて行グループ1つ分ずつの**場所**に区切り、場所の中を段の小さい順に並べる
/// ([`Layout::CellFirst`])。`lod` 列が無ければ [`pack_by_level`] と同じ。
///
/// 返す区切りは**場所ごと・段ごとの行数**。[`write`] がそこで行グループを切るので、
/// 1つの行グループには1つの段しか入らない (`WHERE lod <= 1` で残りを読み飛ばせる)。
fn pack_by_cell(
    batch: &RecordBatch,
    bboxes: &[Bbox],
    row_group_size: usize,
) -> Result<(Vec<u32>, Vec<usize>)> {
    let Some(levels) = read_levels(batch)? else {
        return pack_by_level(batch, bboxes, row_group_size);
    };
    let mut order = Vec::with_capacity(bboxes.len());
    let mut segments = Vec::new();
    for cell in spatial_pack::pack(bboxes, row_group_size)?.chunks(row_group_size) {
        let mut cell = cell.to_vec();
        // 安定な並べ替えなので、段の中では場所の並び (STR) が保たれる。
        cell.sort_by_key(|&row| levels[row as usize]);
        let mut start = 0;
        for end in 1..=cell.len() {
            let boundary =
                end == cell.len() || levels[cell[end] as usize] != levels[cell[start] as usize];
            if boundary {
                segments.push(end - start);
                start = end;
            }
        }
        order.extend(cell);
    }
    Ok((order, segments))
}

/// `lod` 列を行ごとの段として読む。無ければ `None`。
fn read_levels(batch: &RecordBatch) -> Result<Option<Vec<u8>>> {
    let Some(column) = batch.column_by_name(LOD_COLUMN) else {
        return Ok(None);
    };
    let levels = column
        .as_any()
        .downcast_ref::<UInt8Array>()
        .with_context(|| format!("`{LOD_COLUMN}` がUTINYINTではありません"))?;
    if levels.null_count() > 0 {
        bail!("`{LOD_COLUMN}` に欠損があります (段が決まらない行は置けない)");
    }
    Ok(Some((0..levels.len()).map(|i| levels.value(i)).collect()))
}

/// 段を表す列の名前。[`crate::lod`] が書く。
const LOD_COLUMN: &str = "lod";

/// 入力を全行読み込み、`geo` を含むファイルレベルのメタデータも取り出す。
fn read_all(path: &Path) -> Result<(RecordBatch, Vec<KeyValue>, CoveringBbox)> {
    let file = File::open(path).with_context(|| format!("開けません: {}", path.display()))?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)
        .with_context(|| format!("Parquetとして読めません: {}", path.display()))?;

    let key_value_metadata = builder
        .metadata()
        .file_metadata()
        .key_value_metadata()
        .cloned()
        .unwrap_or_default();
    let geo_json = key_value_metadata
        .iter()
        .find(|entry| entry.key == "geo")
        .and_then(|entry| entry.value.as_deref())
        .with_context(|| {
            format!(
                "GeoParquetの `geo` メタデータがありません: {}",
                path.display()
            )
        })?;
    let covering = covering_bbox(geo_json)?;

    let schema = builder.schema().clone();
    let reader = builder.build()?;
    let batches = reader
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("読み込みに失敗しました")?;
    let batch = concat_batches(&schema, &batches).context("バッチの結合に失敗しました")?;

    Ok((batch, key_value_metadata, covering))
}

/// covering bbox 列から、行ごとの外接矩形を取り出す。
fn read_bboxes(batch: &RecordBatch, covering: &CoveringBbox) -> Result<Vec<Bbox>> {
    let column = batch
        .column_by_name(&covering.column)
        .with_context(|| format!("covering が指す列がありません: {}", covering.column))?
        .as_any()
        .downcast_ref::<StructArray>()
        .with_context(|| format!("`{}` が構造体列ではありません", covering.column))?;

    let field = |name: &str| -> Result<&Float64Array> {
        let array = column
            .column_by_name(name)
            .with_context(|| format!("`{}` に {name} がありません", covering.column))?;
        if array.null_count() > 0 {
            bail!("`{}.{name}` に欠損があります", covering.column);
        }
        array
            .as_any()
            .downcast_ref::<Float64Array>()
            .with_context(|| format!("`{}.{name}` がDOUBLEではありません", covering.column))
    };

    let xmin = field(&covering.xmin)?;
    let ymin = field(&covering.ymin)?;
    let xmax = field(&covering.xmax)?;
    let ymax = field(&covering.ymax)?;

    Ok((0..batch.num_rows())
        .map(|i| Bbox {
            xmin: xmin.value(i),
            ymin: ymin.value(i),
            xmax: xmax.value(i),
            ymax: ymax.value(i),
        })
        .collect())
}

/// 書き出して、作った row group の数を返す。
///
/// `segments` は**段ごとの行数**。段の境目で必ず row group を切るので、
/// `WHERE lod = 0` が粗い段の row group だけを読める。
/// 切らないと、粗い段が少ないとき (高速道路は1,360行、row groupは6,374行) に
/// **粗い行が原寸の行と同じ row group に入り、読み飛ばしが効かなくなる。**
fn write(
    path: &Path,
    batch: &RecordBatch,
    key_value_metadata: &[KeyValue],
    row_group_size: usize,
    segments: &[usize],
) -> Result<usize> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = File::create(path).with_context(|| format!("作れません: {}", path.display()))?;

    // 変換直後のファイルは無圧縮 (arrow-rsの既定値) になっている。
    // 静的ホスティングでは転送量がそのままコストと待ち時間になるので圧縮する。
    let properties = WriterProperties::builder()
        .set_max_row_group_row_count(Some(row_group_size))
        .set_compression(Compression::ZSTD(ZstdLevel::default()))
        .build();
    let mut writer = ArrowWriter::try_new(file, batch.schema(), Some(properties))?;

    // row group ちょうどの大きさで渡す。並べ替えで作った区切りと
    // 実際のrow groupの区切りをずらさないため。
    let mut row_groups = 0;
    let mut start = 0;
    for &length in segments {
        for offset in (start..start + length).step_by(row_group_size) {
            let size = row_group_size.min(start + length - offset);
            writer.write(&batch.slice(offset, size))?;
            // **段の中でも境目でも、ここで必ず切る。**
            writer.flush()?;
            row_groups += 1;
        }
        start += length;
    }

    // `geo` をはじめとする元のメタデータを引き継ぐ。中身は解釈せずそのまま渡す。
    // ARROW:schema だけは書き手が改めて書くので、古いものを持ち込まない。
    for entry in key_value_metadata {
        if entry.key != "ARROW:schema" {
            writer.append_key_value_metadata(entry.clone());
        }
    }
    writer.close()?;
    Ok(row_groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::datatypes::{DataType, Field, Schema};
    use std::sync::Arc;

    /// 横一列に並んだ矩形。空間パックの中身はここでは問わない。
    fn bboxes(count: usize) -> Vec<Bbox> {
        (0..count)
            .map(|i| {
                let x = i as f64;
                Bbox {
                    xmin: x,
                    ymin: 0.0,
                    xmax: x + 1.0,
                    ymax: 1.0,
                }
            })
            .collect()
    }

    fn batch_with_levels(levels: Vec<Option<u8>>) -> RecordBatch {
        let schema = Schema::new(vec![Field::new(LOD_COLUMN, DataType::UInt8, true)]);
        RecordBatch::try_new(
            Arc::new(schema),
            vec![Arc::new(UInt8Array::from(levels)) as _],
        )
        .expect("バッチを作れる")
    }

    /// **段をまたいで並べ替えない。** 混ざると `WHERE lod = 0` で
    /// row groupを読み飛ばせなくなり、粗い段を置いた意味が消える。
    #[test]
    fn puts_the_coarse_level_first_and_never_mixes_levels() {
        let levels = vec![Some(1), Some(0), Some(1), Some(0), Some(1), Some(0)];
        let batch = batch_with_levels(levels.clone());
        let (order, segments) = pack_by_level(&batch, &bboxes(6), 2).unwrap();

        // 行が増えも減りもしないこと。
        assert_eq!(order.len(), 6);
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, vec![0, 1, 2, 3, 4, 5]);

        // 並べ替えたあとの段が 0,0,0,1,1,1 になること。
        let after: Vec<u8> = order.iter().map(|&i| levels[i as usize].unwrap()).collect();
        assert_eq!(after, vec![0, 0, 0, 1, 1, 1]);

        // 段の境目が報告されること。**ここで row group を切る。**
        assert_eq!(segments, vec![3, 3]);
    }

    /// **粗い段が row group より小さくても、独立した row group になること。**
    /// 高速道路は粗い段1,360行に対して row group が6,374行で、切らないと
    /// 原寸の行と同じ群に入って読み飛ばしが効かなくなる。
    #[test]
    fn gives_a_small_coarse_level_its_own_row_group() {
        let mut levels = vec![Some(0); 2];
        levels.extend(vec![Some(1); 10]);
        let batch = batch_with_levels(levels);

        let (_, segments) = pack_by_level(&batch, &bboxes(12), 8).unwrap();
        assert_eq!(segments, vec![2, 10]);

        // row group は 粗い(2) + 原寸(8 + 2) の3つに割れる。
        // 段を無視すると 12行 / 8 = 2群になり、粗い行が原寸に混ざる。
        let groups: usize = segments.iter().map(|n| n.div_ceil(8)).sum();
        assert_eq!(groups, 3);
    }

    /// 段が1つしか無くても壊れないこと (原寸だけのファイル)。
    #[test]
    fn handles_a_single_level() {
        let batch = batch_with_levels(vec![Some(1); 4]);
        let (order, segments) = pack_by_level(&batch, &bboxes(4), 2).unwrap();
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, vec![0, 1, 2, 3]);
        assert_eq!(segments, vec![4]);
    }

    /// **`lod` 列が無いファイルはこれまでと同じ結果になること。**
    /// 既にある配信物を作り直したときに並びが変わってはいけない。
    #[test]
    fn falls_back_to_packing_everything_together() {
        let schema = Schema::new(vec![Field::new("other", DataType::UInt8, false)]);
        let batch = RecordBatch::try_new(
            Arc::new(schema),
            vec![Arc::new(UInt8Array::from(vec![0u8; 8])) as _],
        )
        .unwrap();

        let boxes = bboxes(8);
        let (order, segments) = pack_by_level(&batch, &boxes, 3).unwrap();
        assert_eq!(order, spatial_pack::pack(&boxes, 3).unwrap());
        // 段が無いので区切りは全体で1つ。これまでと同じ切り方になる。
        assert_eq!(segments, vec![8]);
    }

    /// 段が決まらない行は置けない。黙って0番に寄せると粗い段に紛れ込む。
    #[test]
    fn rejects_rows_without_a_level() {
        let batch = batch_with_levels(vec![Some(0), None]);
        let error = pack_by_level(&batch, &bboxes(2), 1).unwrap_err();
        assert!(error.to_string().contains("欠損"), "{error}");
    }

    /// **場所ごとに区切り、場所の中を段で並べる** (建物)。行グループに段が混ざらないこと、
    /// 場所をまたいで行が動かないこと。
    #[test]
    fn cell_first_keeps_places_together_and_never_mixes_levels() {
        // 横一列の8行を、4行ずつの場所2つに。段は場所の中でばらばら。
        let levels = [2, 0, 1, 2, 1, 2, 0, 2];
        let batch = batch_with_levels(levels.iter().map(|&l| Some(l)).collect());
        let (order, segments) = pack_by_cell(&batch, &bboxes(8), 4).unwrap();

        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..8).collect::<Vec<u32>>());

        // 前半の場所 (行0〜3) と後半 (4〜7) は混ざらない。
        let first: Vec<u32> = order[..4].to_vec();
        assert!(first.iter().all(|&row| row < 4) || first.iter().all(|&row| row >= 4));

        // 場所の中は段の小さい順で、区切りは場所ごと・段ごと。
        let after: Vec<u8> = order.iter().map(|&row| levels[row as usize]).collect();
        let mut start = 0;
        for &length in &segments {
            let run = &after[start..start + length];
            assert!(
                run.iter().all(|&level| level == run[0]),
                "段が混ざった: {run:?}"
            );
            start += length;
        }
        assert_eq!(start, 8);
        for cell in after.chunks(4) {
            assert!(cell.windows(2).all(|pair| pair[0] <= pair[1]), "{cell:?}");
        }
    }

    /// 段が無ければ、場所ごとの並べ方もこれまでと同じ。
    #[test]
    fn cell_first_without_levels_is_the_plain_packing() {
        let schema = Schema::new(vec![Field::new("x", DataType::UInt8, true)]);
        let batch = RecordBatch::try_new(
            Arc::new(schema),
            vec![Arc::new(UInt8Array::from(vec![1, 2, 3])) as _],
        )
        .unwrap();
        assert_eq!(
            pack_by_cell(&batch, &bboxes(3), 2).unwrap(),
            pack_by_level(&batch, &bboxes(3), 2).unwrap()
        );
    }

    #[test]
    fn moves_the_bbox_column_to_the_front() {
        let schema = Schema::new(vec![
            Field::new("a", DataType::UInt8, true),
            Field::new("bbox", DataType::UInt8, true),
            Field::new("c", DataType::UInt8, true),
        ]);
        let column = || Arc::new(UInt8Array::from(vec![1])) as _;
        let batch =
            RecordBatch::try_new(Arc::new(schema), vec![column(), column(), column()]).unwrap();
        let moved = column_first(&batch, "bbox").unwrap();
        let names: Vec<&str> = moved
            .schema_ref()
            .fields()
            .iter()
            .map(|field| field.name().as_str())
            .collect();
        assert_eq!(names, ["bbox", "a", "c"]);
    }
}
