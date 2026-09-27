use anyhow::{Context, Result, bail};
use duck_geocoder::geoparquet::{CoveringBbox, geo_metadata_json, geoparquet_geometry_type};
use duck_geocoder::lod;
use duck_geocoder::repack;
use std::path::PathBuf;
use std::process::Command;

/// 都市ごとのPLATEAU建物から、**全国の高い建物だけ**を1ファイルにまとめる。
///
/// 引いた表示で「そこに建物データがあるか」を見せるためのもの。建物に簡略化は
/// 効かない (ズーム12でフットプリントは1px未満) ので、**高さで選ぶ**。
/// 実物のLOD0フットプリントなので近似が入らない。
///
/// **都市ごとのファイルは束ねない。** 理由は [`duck_geocoder::lod`] にある
/// (2,914万行はrepackに約32GBを要求する / 306ファイルのフッターで600往復超)。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (glob, output, min_height) = match args.as_slice() {
        [_, glob, output] => (glob.clone(), PathBuf::from(output), DEFAULT_MIN_HEIGHT_M),
        [_, glob, output, height] => (
            glob.clone(),
            PathBuf::from(output),
            height
                .parse::<u32>()
                .with_context(|| format!("高さが数値として読めません: {height:?}"))?,
        ),
        _ => bail!(
            "usage: build_tall_buildings <入力のglob> <出力.parquet> [最低の高さm]\n\n\
             既定は {DEFAULT_MIN_HEIGHT_M}m。全国2,914万棟のうち、\n\
             45m以上が26,155棟、60m以上が7,803棟、90m以上が3,597棟。\n\n\
             例:\n  \
             build_tall_buildings '../data/output/plateau/plateau_bldg_*.parquet' \\\n    \
             ../data/output/plateau/plateau_bldg_tall.parquet"
        ),
    };

    // 収録範囲とジオメトリ種別は決め打ちせず、実データから取る。
    let stats = query_stats(&lod::build_tall_buildings_stats_sql(&glob, min_height))?;
    let geometry_types = stats
        .geometry_types
        .iter()
        .map(|name| geoparquet_geometry_type(name).map(str::to_string))
        .collect::<Result<Vec<_>>>()?;
    println!(
        "{min_height}m以上 / 収録範囲 [{}, {}, {}, {}] / ジオメトリ {}",
        stats.xmin,
        stats.ymin,
        stats.xmax,
        stats.ymax,
        geometry_types.join(", "),
    );

    let covering = CoveringBbox {
        column: "bbox".to_string(),
        xmin: "xmin".to_string(),
        ymin: "ymin".to_string(),
        xmax: "xmax".to_string(),
        ymax: "ymax".to_string(),
    };
    let geo = geo_metadata_json(
        "geometry",
        &covering,
        &geometry_types,
        [stats.xmin, stats.ymin, stats.xmax, stats.ymax],
    )?;

    // 一度書いてから並べ替える。**全国に散らばる点なので空間パックが効く。**
    let staged = output.with_extension("parquet.staged");
    let staged_str = staged.to_str().context("出力パスがUTF-8ではありません")?;
    run_duckdb(&lod::build_tall_buildings_sql(
        &glob, staged_str, min_height, &geo,
    ))?;

    let packed = repack::repack(&staged, &output, None)?;
    std::fs::remove_file(&staged).ok();

    println!(
        "{}\n  {} 棟 / row group {} 行 x {} 個 / {:.1} MB",
        output.display(),
        packed.rows,
        packed.row_group_size,
        packed.row_groups,
        packed.output_bytes as f64 / 1024.0 / 1024.0,
    );
    Ok(())
}

/// 収録する高さの下限。
///
/// **60mにした理由。** 全国2,914万棟のうち7,803棟に絞れて1MB前後に収まり、かつ
/// ドローンの障害物として意味のある高さ (航空法の150m制限に対して、地表付近の
/// 飛行で避けなければならない構造物) が残る。45mでは26,155棟で3倍を超える。
const DEFAULT_MIN_HEIGHT_M: u32 = 60;

#[derive(serde::Deserialize)]
struct Stats {
    xmin: f64,
    ymin: f64,
    xmax: f64,
    ymax: f64,
    geometry_types: Vec<String>,
}

fn query_stats(sql: &str) -> Result<Stats> {
    let output = Command::new("duckdb")
        .args(["-json", "-c", sql])
        .output()
        .context("duckdb コマンドを実行できません (mise install は済んでいますか?)")?;
    if !output.status.success() {
        bail!(
            "duckdb が失敗しました: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let rows: Vec<Stats> =
        serde_json::from_slice(&output.stdout).context("duckdb の出力を読めません")?;
    rows.into_iter()
        .next()
        .context("統計の行が1件も返りません (高さを満たす建物が無い?)")
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
