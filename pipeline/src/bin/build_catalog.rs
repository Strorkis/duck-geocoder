use anyhow::{Context, Result, bail};
use duck_geocoder::{catalog, stac};
use std::path::PathBuf;

/// 配信ディレクトリ配下のGeoParquetを走査し、STACの文書一式を書き出す。
///
/// 出力は入力と同じディレクトリに置く。**STACの相対リンクはその文書からの相対**
/// として解決されるので、実データと同じ起点に置く必要がある。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let dir = match args.as_slice() {
        [_, dir] => PathBuf::from(dir),
        _ => bail!(
            "usage: build_catalog <配信ディレクトリ>\n\n\
             例:\n  build_catalog ../data/output"
        ),
    };

    let datasets = catalog::build_catalog(&dir)?;
    let documents = stac::build(&datasets)?;

    // 作り直すたびに古いCollectionが残らないよう、一度消してから書く。
    // データセットを減らしたときに、消えたはずのCollectionが配信され続けるのを防ぐ。
    for stale in std::fs::read_dir(&dir)?.filter_map(|entry| entry.ok()) {
        let path = stale.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            std::fs::remove_file(&path)
                .with_context(|| format!("消せません: {}", path.display()))?;
        }
    }

    for document in &documents {
        let path = dir.join(&document.path);
        std::fs::write(&path, serde_json::to_string_pretty(&document.body)?)
            .with_context(|| format!("書けません: {}", path.display()))?;
    }

    let collections = documents
        .iter()
        .filter(|document| document.body["type"] == "Collection")
        .count();
    println!(
        "{} データセット / {} コレクション / {} ファイルを {} に書き出しました",
        datasets.len(),
        collections,
        documents.len(),
        dir.display(),
    );
    Ok(())
}
