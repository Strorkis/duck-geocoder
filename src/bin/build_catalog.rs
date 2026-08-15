use anyhow::{Result, bail};
use duck_geocoder::catalog::build_catalog;
use std::path::PathBuf;

/// data/output/ 配下のGeoParquetを走査し、カタログJSONを書き出す。
/// UIはこのJSONを読んで、どのデータセットが利用可能かを知る。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (input_dir, output) = match args.as_slice() {
        [_, input_dir, output] => (PathBuf::from(input_dir), PathBuf::from(output)),
        _ => bail!("usage: build_catalog <parquet-dir> <catalog.json>"),
    };

    let catalog = build_catalog(&input_dir)?;

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&output, serde_json::to_string_pretty(&catalog)?)?;

    println!(
        "{} 件のデータセットを {} に書き出しました",
        catalog.datasets.len(),
        output.display()
    );
    Ok(())
}
