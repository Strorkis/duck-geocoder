use anyhow::{Context, Result, bail};
use duck_geocoder::external::Snapshot;
use duck_geocoder::pmtiles;
use duck_geocoder::remote_zip::{FetchRange, HttpRange};
use std::path::PathBuf;

/// 外部の PMTiles のヘッダとメタデータを HTTP Range で取り、スナップショットにする。
///
/// **タイルは読まない。** 往復は3回 (長さ・ヘッダ・メタデータ)。カタログを作るときは
/// ネットワークに触らず、ここで書いたものを読む (`external.rs`)。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (url, out) = match args.as_slice() {
        [_, url, out] => (url.as_str(), PathBuf::from(out)),
        _ => bail!(
            "usage: describe_pmtiles <PMTilesのURL> <出力.json>\n\n\
             例:\n  describe_pmtiles \
             https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles \
             external/gsi-optimal-bvmap.json"
        ),
    };

    let source = HttpRange::new(url);
    let bytes = source.total_len()?;
    let header = pmtiles::parse_header(&source.fetch(0, pmtiles::HEADER_LEN - 1)?)?;
    if header.metadata_length == 0 {
        bail!("メタデータがありません: {url}");
    }
    let metadata = pmtiles::parse_metadata(
        &source.fetch(
            header.metadata_offset,
            header.metadata_offset + header.metadata_length - 1,
        )?,
        header.internal_compression,
    )?;

    let snapshot = Snapshot::new(url, bytes, &header, metadata);
    std::fs::write(&out, serde_json::to_string_pretty(&snapshot)? + "\n")
        .with_context(|| format!("書けません: {}", out.display()))?;
    println!(
        "{url}\n  {:.1} GB / ズーム {}〜{} / {} 層\n  -> {}",
        bytes as f64 / 1e9,
        header.min_zoom,
        header.max_zoom,
        snapshot.metadata.vector_layers.len(),
        out.display(),
    );
    Ok(())
}
