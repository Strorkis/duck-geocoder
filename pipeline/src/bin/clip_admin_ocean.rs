use anyhow::{Context, Result, bail};
use duck_geocoder::overture::build_clip_ocean_sql;
use std::path::PathBuf;
use std::process::Command;

/// 行政区域から海域を削る。`extract_overture divisions` と `ocean` の出力を受け取り、
/// 入力と同じ列のファイルを出す。
///
/// `overture_divisions_to_geoparquet` の手前に挟む工程として分けてある。こうすると
/// 収録範囲やジオメトリ種別のメタデータも、削ったあとの実データから取られる。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (divisions, ocean, output) = match args.as_slice() {
        [_, divisions, ocean, output] => (divisions.clone(), ocean.clone(), PathBuf::from(output)),
        _ => bail!(
            "usage: clip_admin_ocean <divisions.parquet> <ocean.parquet> <output.parquet>\n\
             例:\n  \
             clip_admin_ocean ../data/overture/divisions_jp.parquet \\\n    \
             ../data/overture/ocean_jp.parquet \\\n    \
             ../data/overture/divisions_jp_land.parquet"
        ),
    };
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let output_str = output.to_str().context("出力パスがUTF-8ではありません")?;

    eprintln!("海域を削っています...");
    let status = Command::new("duckdb")
        .arg("-c")
        .arg(build_clip_ocean_sql(&divisions, &ocean, output_str))
        .status()
        .context("duckdb コマンドを実行できません (mise install は済んでいますか?)")?;
    if !status.success() {
        bail!("duckdb が失敗しました: {status}");
    }

    println!("書き出しました: {}", output.display());
    println!("続けて overture_divisions_to_geoparquet を通すこと。");
    Ok(())
}
