use anyhow::{Context, Result, bail};
use arrow::array::{Array, Float64Array, RecordBatch, StructArray, UInt32Array};
use arrow::compute::{concat_batches, take_record_batch};
use duck_geocoder::geoparquet::{CoveringBbox, covering_bbox};
use duck_geocoder::spatial_pack::{self, Bbox};
use parquet::arrow::ArrowWriter;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::basic::{Compression, ZstdLevel};
use parquet::file::properties::WriterProperties;
use parquet::format::KeyValue;
use std::fs::File;
use std::path::{Path, PathBuf};

/// GeoParquetを、HTTP越しに部分読みしやすい形に並べ替えて書き直す。
///
/// 変換直後のファイルは元データの並び順のまま全行が1つのrow groupに入っているため、
/// Parquetのrow group統計が何も絞り込めない。逆ジオコーディングのような点クエリでも
/// ジオメトリ列を丸ごと読むことになり、静的ホスティングでは実用にならない。
///
/// ここでは中身を変えずに、行の並び替えとrow groupの分割だけを行う。
/// 列構成・行数・`geo` メタデータはそのまま引き継ぐ。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (input, output, requested_size) = match args.as_slice() {
        [_, input, output] => (PathBuf::from(input), PathBuf::from(output), None),
        [_, input, output, size] => (
            PathBuf::from(input),
            PathBuf::from(output),
            Some(
                size.parse::<usize>()
                    .with_context(|| format!("row group size が数値として読めません: {size:?}"))?,
            ),
        ),
        _ => bail!(
            "usage: optimize_geoparquet <input.parquet> <output.parquet> [row_group_size]\n\
             row_group_size を省略すると、1行あたりのバイト数から自動で決める。\n\
             入力と同じパスを指定すれば上書きできる。\n\
             例:\n  \
             optimize_geoparquet ../data/output/n03_all.parquet ../data/output/n03_all.parquet"
        ),
    };

    // 全行をメモリに読んでから書くので、入力と出力が同じでも安全。
    // ただし書き込み中に落ちたときに元ファイルを壊さないよう、一時ファイル経由にする。
    let (batch, geo_metadata, covering) = read_all(&input)?;
    let bboxes = read_bboxes(&batch, &covering)?;

    let input_bytes = std::fs::metadata(&input)?.len();
    let row_group_size = requested_size
        .unwrap_or_else(|| spatial_pack::default_row_group_size(input_bytes, batch.num_rows()));

    let order = spatial_pack::pack(&bboxes, row_group_size)?;
    let indices = UInt32Array::from(order);
    let sorted = take_record_batch(&batch, &indices).context("行の並べ替えに失敗しました")?;

    let temporary = output.with_extension("parquet.writing");
    write(&temporary, &sorted, &geo_metadata, row_group_size)?;
    std::fs::rename(&temporary, &output)
        .with_context(|| format!("書き出したファイルを移せません: {}", output.display()))?;

    let output_bytes = std::fs::metadata(&output)?.len();
    println!(
        "{} -> {}\n  {} 行 / row group {} 行 x {} 個\n  {:.1} MB -> {:.1} MB",
        input.display(),
        output.display(),
        sorted.num_rows(),
        row_group_size,
        sorted.num_rows().div_ceil(row_group_size),
        input_bytes as f64 / 1024.0 / 1024.0,
        output_bytes as f64 / 1024.0 / 1024.0,
    );
    Ok(())
}

/// 入力を全行読み込み、`geo` を含むファイルレベルのメタデータも取り出す。
///
/// 空間的な並べ替えは全行のbboxが揃わないと決められないので、
/// ストリーミングはできない。
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

fn write(
    path: &Path,
    batch: &RecordBatch,
    key_value_metadata: &[KeyValue],
    row_group_size: usize,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = File::create(path).with_context(|| format!("作れません: {}", path.display()))?;

    // 変換直後のファイルは無圧縮 (arrow-rsの既定値) になっている。
    // 静的ホスティングでは転送量がそのままコストと待ち時間になるので圧縮する。
    let properties = WriterProperties::builder()
        .set_max_row_group_size(row_group_size)
        .set_compression(Compression::ZSTD(ZstdLevel::default()))
        .build();
    let mut writer = ArrowWriter::try_new(file, batch.schema(), Some(properties))?;

    // row group ちょうどの大きさで渡す。並べ替えで作った区切りと
    // 実際のrow groupの区切りをずらさないため。
    for offset in (0..batch.num_rows()).step_by(row_group_size) {
        let length = row_group_size.min(batch.num_rows() - offset);
        writer.write(&batch.slice(offset, length))?;
        writer.flush()?;
    }

    // `geo` をはじめとする元のメタデータを引き継ぐ。中身は解釈せずそのまま渡す。
    // ARROW:schema だけは書き手が改めて書くので、古いものを持ち込まない。
    for entry in key_value_metadata {
        if entry.key != "ARROW:schema" {
            writer.append_key_value_metadata(entry.clone());
        }
    }
    writer.close()?;
    Ok(())
}
