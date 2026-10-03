use anyhow::{Context, Result, bail};
use duck_geocoder::geoparquet::{self, VINTAGE_KEY};
use duck_geocoder::lod::{self, CoarseLevel};
use duck_geocoder::repack;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 既にある線のGeoParquetに、**引いた表示のための粗い段を足す**。
///
/// 新しいファイルは作らない。`lod = 0` の行 (統合して簡略化したもの) を
/// 同じファイルの先頭の行グループに置き、`lod = 1` に元の行をそのまま残す。
/// 理由と実測値は [`duck_geocoder::lod`] にある。
///
/// **入力を上書きする。** 段を足したファイルをもう一度通しても二重にはならない
/// (`lod` 列があれば拒む)。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let targets: Vec<PathBuf> = match args.as_slice() {
        [_, paths @ ..] if !paths.is_empty() => paths.iter().map(PathBuf::from).collect(),
        _ => bail!(
            "usage: add_coarse_lod <線のparquet>...\n\n\
             道路 (overture_roads_*.parquet) と鉄道 (n02_sections_all.parquet) に\n\
             引いた表示用の粗い段を足す。**入力を上書きする。**\n\n\
             例:\n  \
             add_coarse_lod ../data/output/overture/overture_roads_*.parquet \\\n    \
             ../data/output/ksj/n02_sections_all.parquet"
        ),
    };

    for target in &targets {
        add_coarse_lod(target)?;
    }
    Ok(())
}

/// ファイル名から、そのデータセットの統合の仕方を選ぶ。
///
/// **決め打ちの対応表にしてある。** 列構成を知らないファイルに当てると
/// SQLが黙って通って別の列を統合してしまうので、知らないものは断る。
fn coarse_level_for(path: &Path) -> Result<CoarseLevel<'static>> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("ファイル名が読めません")?;

    // 道路 (Overture)。**路線名で統合する。** 名前の無い区間 (ランプ・JCT連絡路) は
    // 粗い段に入れない。
    if name.starts_with("overture_roads_") {
        return Ok(CoarseLevel {
            merge_key: &["road_name"],
            folded: &[
                // 1ファイル1等級なのでどれを取っても同じだが、代表値を明示しておく。
                ("class", "mode(class)"),
                // **路線は統合した区間の和**。同じ路線名が重なるので畳む。
                (
                    "route_names",
                    "list_distinct(flatten(list(coalesce(route_names, []))))",
                ),
            ],
            require: Some("road_name IS NOT NULL"),
        });
    }

    // 鉄道 (国土数値情報 N02)。**路線名は事業者ごとに別物**なので、
    // 事業者と種別まで含めて統合する (「本線」が各社にある)。
    if name.starts_with("n02_sections") {
        return Ok(CoarseLevel {
            merge_key: &["line_name", "operator", "institution_type"],
            folded: &[
                ("railway_class", "mode(railway_class)"),
                ("railway_class_code", "mode(railway_class_code)"),
                ("institution_type_code", "mode(institution_type_code)"),
            ],
            require: None,
        });
    }

    // 送電線・川 (Overture)。**名前・種別・タイルで統合する。** 名前だけで束ねると、
    // 全国の送電線は8割が名前を持たないので引いた表示から消える (overture::LINE_TILE_ZOOM)。
    // 名前の無い線 (NULL) もタイルごとに1本にまとまるので、粗い段に全部の線が残る。
    if name.starts_with("overture_power_lines") || name.starts_with("overture_waterways") {
        return Ok(CoarseLevel {
            merge_key: &["name", "class", "tile"],
            folded: &[],
            require: None,
        });
    }

    bail!(
        "統合の仕方が分かりません: {name}\n\
         列構成ごとに決め打ちしてあります (add_coarse_lod.rs の coarse_level_for)。"
    )
}

fn add_coarse_lod(input: &Path) -> Result<()> {
    let level = coarse_level_for(input)?;

    // **二度足さない。** 段を持つファイルをもう一度通すと、粗い段そのものを
    // 統合した行が増えて重複する。
    if geoparquet::read_key_value(input, lod::LOD_KEY)?.is_some() {
        println!("{}: 既に段があるので飛ばします", input.display());
        return Ok(());
    }

    // 収録範囲と covering の宣言は**原本から引き継ぐ**。作り直すとずれる。
    let geo = geoparquet::read_key_value(input, "geo")?
        .with_context(|| format!("`geo` がありません: {}", input.display()))?;
    // 統合すると LineString が MultiLineString になるので、両方を宣言する。
    let geo = geoparquet::with_geometry_types(&geo, &["LineString", "MultiLineString"])?;
    let vintage = geoparquet::read_key_value(input, VINTAGE_KEY)?.unwrap_or_default();

    let input_str = input.to_str().context("入力パスがUTF-8ではありません")?;
    // 途中で落ちても原本を壊さないよう、一時ファイルに書いてから置き換える。
    let staged = input.with_extension("parquet.lod");
    let staged_str = staged.to_str().context("出力パスがUTF-8ではありません")?;

    run_duckdb(&lod::build_with_coarse_lod_sql(
        input_str, staged_str, &level, &geo, &vintage,
    ))?;

    // **段ごとに並べ替える。** ここで粗い行が先頭の行グループに集まる。
    let packed = repack::repack(&staged, input, None)?;
    std::fs::remove_file(&staged).ok();

    println!(
        "{}\n  {} 行 / row group {} 行 x {} 個 / {:.1} MB",
        input.display(),
        packed.rows,
        packed.row_group_size,
        packed.row_groups,
        packed.output_bytes as f64 / 1024.0 / 1024.0,
    );
    Ok(())
}

fn run_duckdb(sql: &str) -> Result<()> {
    let status = Command::new("duckdb")
        .arg("-c")
        .arg(sql)
        .status()
        .context("duckdb コマンドを実行できません")?;
    if !status.success() {
        bail!("duckdb が失敗しました: {status}");
    }
    Ok(())
}
