use anyhow::{Context, Result, bail};
use duck_geocoder::overture::{BoundingBox, DEFAULT_RELEASE, build_extract_sql};
use std::path::PathBuf;
use std::process::Command;

/// Overture Maps の建物データから指定範囲を切り出し、GeoParquetとして保存する。
///
/// 変換処理は不要 (Overtureは元からGeoParquet) なので、DuckDB CLI に任せる。
/// `duckdb` は mise.toml で管理しているものを使う。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (output, xmin, ymin, xmax, ymax) = match args.as_slice() {
        [_, output, xmin, ymin, xmax, ymax] => (PathBuf::from(output), xmin, ymin, xmax, ymax),
        _ => bail!(
            "usage: extract_overture <output.parquet> <xmin> <ymin> <xmax> <ymax>\n\
             例 (東京都港区あたり):\n  \
             extract_overture ../data/output/overture_buildings_minato.parquet \\\n    \
             139.73 35.63 139.78 35.68"
        ),
    };

    let bbox = BoundingBox::parse(xmin, ymin, xmax, ymax)?;
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let output_str = output.to_str().context("出力パスがUTF-8ではありません")?;
    let release =
        std::env::var("OVERTURE_RELEASE").unwrap_or_else(|_| DEFAULT_RELEASE.to_string());
    let sql = build_extract_sql(&release, bbox, output_str);

    // S3上の全件をスキャンするため、範囲が狭くても数分かかることがある。
    eprintln!("Overture {release} から建物を抽出しています (範囲: {bbox:?})...");

    let status = Command::new("duckdb")
        .arg("-c")
        .arg(&sql)
        .status()
        .context("duckdb コマンドを実行できません (mise install は済んでいますか?)")?;
    if !status.success() {
        bail!("duckdb が失敗しました: {status}");
    }

    println!("書き出しました: {}", output.display());
    Ok(())
}
