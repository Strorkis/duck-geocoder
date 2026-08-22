use anyhow::{Context, Result, bail};
use duck_geocoder::overture::{
    BoundingBox, DEFAULT_RELEASE, JAPAN_BBOX, build_divisions_extract_sql, build_extract_sql,
};
use std::path::PathBuf;
use std::process::Command;

/// Overture Maps から必要な範囲を切り出し、GeoParquetとして保存する。
///
/// 変換処理は不要 (Overtureは元からGeoParquet) なので、DuckDB CLI に任せる。
/// `duckdb` は mise.toml で管理しているものを使う。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let sql = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [_, "buildings", output, xmin, ymin, xmax, ymax] => {
            let bbox = BoundingBox::parse(xmin, ymin, xmax, ymax)?;
            eprintln!("Overture から建物を抽出しています (範囲: {bbox:?})...");
            build_extract_sql(&release(), bbox, &prepare(output)?)
        }
        [_, "divisions", output] => {
            eprintln!("Overture から日本の行政区域を抽出しています...");
            build_divisions_extract_sql(&release(), "JP", JAPAN_BBOX, &prepare(output)?)
        }
        _ => bail!(
            "usage:\n  \
             extract_overture buildings <output.parquet> <xmin> <ymin> <xmax> <ymax>\n  \
             extract_overture divisions <output.parquet>\n\n\
             例:\n  \
             extract_overture buildings ../data/output/overture_buildings_minato.parquet \\\n    \
             139.73 35.63 139.78 35.68\n  \
             extract_overture divisions ../data/overture/divisions_jp.parquet"
        ),
    };

    // S3上のファイルのフッターを一通り読むため、範囲が狭くても時間がかかることがある。
    let status = Command::new("duckdb")
        .arg("-c")
        .arg(&sql)
        .status()
        .context("duckdb コマンドを実行できません (mise install は済んでいますか?)")?;
    if !status.success() {
        bail!("duckdb が失敗しました: {status}");
    }
    Ok(())
}

fn release() -> String {
    std::env::var("OVERTURE_RELEASE").unwrap_or_else(|_| DEFAULT_RELEASE.to_string())
}

/// 出力先のディレクトリを用意し、SQLに埋め込める文字列にする。
fn prepare(output: &str) -> Result<String> {
    let path = PathBuf::from(output);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    println!("書き出し先: {}", path.display());
    Ok(output.to_string())
}
