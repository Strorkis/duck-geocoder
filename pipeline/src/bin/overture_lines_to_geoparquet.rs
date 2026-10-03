use anyhow::{Context, Result, bail};
use duck_geocoder::geoparquet::{CoveringBbox, geo_metadata_json, geoparquet_geometry_type};
use duck_geocoder::overture::{
    DEFAULT_RELEASE, OvertureLine, build_lines_sql, build_lines_stats_sql,
};
use std::path::PathBuf;
use std::process::Command;

/// `extract_overture power|water` で落としたファイルから、日本の送電線・川のデータセットを作る。
///
/// 道路 ([`overture_roads_to_geoparquet`]) と同じ流れで、**国外を市区町村との交差で落とす**。
/// このあと `optimize_geoparquet` で並べ直し、`add_coarse_lod` で引いた表示用の段を足す。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (line, input, divisions, out_dir) = match args.as_slice() {
        [_, kind, input, divisions, out_dir] => (
            OvertureLine::parse(kind)?,
            input.clone(),
            divisions.clone(),
            PathBuf::from(out_dir),
        ),
        _ => bail!(
            "usage: overture_lines_to_geoparquet <power|water> <取り出したparquet> \
             <divisions_jp.parquet> <出力ディレクトリ>\n\
             例:\n  \
             overture_lines_to_geoparquet power ../data/overture/power_jp.parquet \\\n    \
             ../data/overture/divisions_jp.parquet ../data/output/overture"
        ),
    };
    std::fs::create_dir_all(&out_dir)?;
    let vintage = std::env::var("OVERTURE_RELEASE").unwrap_or_else(|_| DEFAULT_RELEASE.to_string());

    let output = out_dir.join(line.file_name());
    let output_str = output.to_str().context("出力パスがUTF-8ではありません")?;

    // 収録範囲とジオメトリ種別は決め打ちせず、実データから取る。
    let stats = query_stats(&build_lines_stats_sql(&input, &divisions))?;
    let geometry_types = stats
        .geometry_types
        .iter()
        .map(|name| geoparquet_geometry_type(name).map(str::to_string))
        .collect::<Result<Vec<_>>>()?;
    println!(
        "{line:?}: 収録範囲 [{}, {}, {}, {}] / ジオメトリ {}",
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
    run_duckdb(&build_lines_sql(
        &input, &divisions, output_str, &geo, &vintage,
    ))?;
    println!("書き出しました: {}", output.display());
    println!("続けて optimize_geoparquet と add_coarse_lod を通すこと。");
    Ok(())
}

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
        .context("日本の線が1件も見つかりません")
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
