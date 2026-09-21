use anyhow::{Context, Result, bail};
use duck_geocoder::geoparquet::{CoveringBbox, geo_metadata_json, geoparquet_geometry_type};
use duck_geocoder::overture::{
    DEFAULT_RELEASE, ROAD_CLASSES, build_roads_sql, build_roads_stats_sql,
};
use std::path::PathBuf;
use std::process::Command;

/// `extract_overture roads` で落としたファイルから、道路データセットを作る。
///
/// **`class` ごとに1ファイルに分ける。** 全国の幹線は87万区間あり、まとめると
/// `optimize_geoparquet` が全行をメモリに載せるところで落ちる。
/// 分けても配信側は `read_parquet([...])` で1つのビューに束ねられるので、
/// 画面上は1レイヤーのまま扱える。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (input, divisions, out_dir) = match args.as_slice() {
        [_, input, divisions, out_dir] => (input.clone(), divisions.clone(), PathBuf::from(out_dir)),
        _ => bail!(
            "usage: overture_roads_to_geoparquet <roads.parquet> <出力ディレクトリ>\n\
             例:\n  \
             overture_roads_to_geoparquet ../data/overture/roads_jp.parquet \\\n    \
             ../data/output/overture"
        ),
    };
    std::fs::create_dir_all(&out_dir)?;

    let vintage = format!(
        "Overture {}",
        std::env::var("OVERTURE_RELEASE").unwrap_or_else(|_| DEFAULT_RELEASE.to_string())
    );

    for class in ROAD_CLASSES {
        let output = out_dir.join(format!("overture_roads_{class}.parquet"));
        let output_str = output.to_str().context("出力パスがUTF-8ではありません")?;

        // 収録範囲とジオメトリ種別は決め打ちせず、class ごとに実データから取る。
        let stats = query_stats(&build_roads_stats_sql(&input, &divisions, class), class)?;
        let geometry_types = stats
            .geometry_types
            .iter()
            .map(|name| geoparquet_geometry_type(name).map(str::to_string))
            .collect::<Result<Vec<_>>>()?;
        println!(
            "{class}: 収録範囲 [{}, {}, {}, {}] / ジオメトリ {}",
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

        run_duckdb(&build_roads_sql(&input, &divisions, class, output_str, &geo, &vintage))?;
        println!("書き出しました: {}", output.display());
    }
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

fn query_stats(sql: &str, class: &str) -> Result<Stats> {
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
        .with_context(|| format!("class={class} の行が1件も見つかりません"))
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
