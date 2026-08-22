use anyhow::{Context, Result, bail};
use duck_geocoder::geoparquet::{CoveringBbox, geo_metadata_json, geoparquet_geometry_type};
use duck_geocoder::overture::{build_admin_sql, build_admin_stats_sql};
use std::path::PathBuf;
use std::process::Command;

/// `extract_overture divisions` で落としたファイルから、行政区域データセットを作る。
///
/// S3には触らないので、粒度や列の付け方を変えたくなったら何度でもやり直せる。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (input, output) = match args.as_slice() {
        [_, input, output] => (input.clone(), PathBuf::from(output)),
        _ => bail!(
            "usage: overture_divisions_to_geoparquet <divisions.parquet> <output.parquet>\n\
             例:\n  \
             overture_divisions_to_geoparquet ../data/overture/divisions_jp.parquet \\\n    \
             ../data/output/overture_admin_jp.parquet"
        ),
    };
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let output_str = output.to_str().context("出力パスがUTF-8ではありません")?;

    // 収録範囲とジオメトリ種別は決め打ちせず、実データから取る。
    let stats = query_stats(&build_admin_stats_sql(&input))?;
    let geometry_types = stats
        .geometry_types
        .iter()
        .map(|name| geoparquet_geometry_type(name).map(str::to_string))
        .collect::<Result<Vec<_>>>()?;
    println!(
        "収録範囲: [{}, {}, {}, {}] / ジオメトリ: {}",
        stats.xmin,
        stats.ymin,
        stats.xmax,
        stats.ymax,
        geometry_types.join(", "),
    );

    // 書き出す列に合わせた covering の宣言。build_admin_sql が bbox 構造体列を
    // そのまま引き継ぐので、その位置を指す。
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

    run_duckdb(&build_admin_sql(&input, output_str, &geo))?;
    println!("書き出しました: {}", output.display());
    println!("配信用の最適化には optimize_geoparquet を通すこと。");
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
        .context("行政区域にあたる行が1件も見つかりません")
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
