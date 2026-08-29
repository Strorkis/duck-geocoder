use anyhow::{Context, Result, bail};
use duck_geocoder::admin_names::build_extract_sql;
use std::path::PathBuf;
use std::process::Command;

/// 行政区域データセットから、検索用の名称だけを抜き出した小さなParquetを作る。
///
/// UIはこれを読んで地名検索の候補を出す。行政区域そのものから引くと、
/// 名称の列がファイル全体に散らばっているためHTTP越しでは往復が多くなりすぎる
/// (詳細は `duck_geocoder::admin_names`)。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (input, output) = match args.as_slice() {
        [_, input, output] => (input.clone(), PathBuf::from(output)),
        _ => bail!(
            "usage: build_admin_names <admin.parquet> <output.parquet>\n\
             例:\n  \
             build_admin_names ../data/output/overture_admin_jp.parquet \\\n    \
             ../data/output/overture_admin_names_jp.parquet"
        ),
    };
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let output_str = output.to_str().context("出力パスがUTF-8ではありません")?;

    let status = Command::new("duckdb")
        .arg("-c")
        .arg(build_extract_sql(&input, output_str))
        .status()
        .context("duckdb コマンドを実行できません (mise install は済んでいますか?)")?;
    if !status.success() {
        bail!("duckdb が失敗しました: {status}");
    }

    let bytes = std::fs::metadata(&output)?.len();
    println!(
        "書き出しました: {} ({:.0} KB)",
        output.display(),
        bytes as f64 / 1024.0,
    );
    Ok(())
}
