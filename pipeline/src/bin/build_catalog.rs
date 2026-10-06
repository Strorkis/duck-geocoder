use anyhow::{Context, Result, bail};
use duck_geocoder::{catalog, external, stac, stac_i18n};
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
    // 外部の配信物 (地理院のベクトルタイルなど) はスナップショットから載せる。
    // **ここではネットワークに触らない** (`describe_pmtiles` で先に取っておく)。
    let built = stac::build(
        &datasets,
        external::EXTERNAL_TILESETS,
        external::EXTERNAL_RASTERS,
    )?;
    let documents = &built.documents;

    // Item は stac-geoparquet 1つにまとめる (Collection ごとに行グループを分ける)。
    // **古い文書を消すより先に書く** — ここで失敗したら、手元の一式は前のまま残る。
    let items_path = dir.join(duck_geocoder::stac_geoparquet::ITEMS_FILE);
    duck_geocoder::stac_geoparquet::write(&items_path, &built.items)?;

    // 作り直すたびに古い文書が残らないよう、一度消してから書く。データセットを減らしたときに、
    // 消えたはずのCollectionが配信され続けるのを防ぐ。**サブカタログのディレクトリの中も消す**
    // (以前は起点直下だけを消していて、`*-items.json` をやめたあとも残った)。
    let mut stale_dirs = vec![dir.clone()];
    for entry in std::fs::read_dir(&dir)?.filter_map(|entry| entry.ok()) {
        if entry.path().is_dir() {
            stale_dirs.push(entry.path());
        }
    }
    for stale_dir in &stale_dirs {
        for stale in std::fs::read_dir(stale_dir)?.filter_map(|entry| entry.ok()) {
            let path = stale.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                std::fs::remove_file(&path)
                    .with_context(|| format!("消せません: {}", path.display()))?;
            }
        }
    }

    for document in documents {
        let path = dir.join(&document.path);
        // 外部の配信物だけのサブカタログ (gsi/) は、実データが無いのでディレクトリも無い。
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("作れません: {}", parent.display()))?;
        }
        // アプリが起動時に読むまとめは詰めて書く (整形すると約1.5倍になる)。
        // 文書ごとの JSON は人も読むので整形する。
        let bundle =
            [stac_i18n::BUNDLE_FILE, stac_i18n::BUNDLE_FILE_EN].contains(&document.path.as_str());
        let text = if bundle {
            serde_json::to_string(&document.body)?
        } else {
            serde_json::to_string_pretty(&document.body)?
        };
        std::fs::write(&path, text).with_context(|| format!("書けません: {}", path.display()))?;
    }

    // 日本語の Collection だけを数える (英語版は同じ Collection の別の文書)。
    let collections = documents
        .iter()
        .filter(|document| {
            document.body["type"] == "Collection" && !document.path.ends_with(".en.json")
        })
        .count();
    println!(
        "{} データセット / {} コレクション / JSON {} ファイルと {} (Item {} 件) を {} に書き出しました",
        datasets.len(),
        collections,
        documents.len(),
        duck_geocoder::stac_geoparquet::ITEMS_FILE,
        built.items.len(),
        dir.display(),
    );
    Ok(())
}
