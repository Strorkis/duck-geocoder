use anyhow::{Context, Result, bail};
use duck_geocoder::n03;
use duck_geocoder::read_zip_entry;
use std::path::PathBuf;

/// 国土数値情報 行政区域データ (N03) の GML/Shapefile zip に同梱された
/// GeoJSON を読み、GeoParquet に変換する。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (input, output) = match args.as_slice() {
        [_, input, output] => (PathBuf::from(input), PathBuf::from(output)),
        _ => bail!("usage: n03_to_geoparquet <input.zip> <output.parquet>"),
    };

    // 全国版zipには、詳細な市区町村単位のgeojsonの他に、都道府県単位に統合した
    // 簡易版 (`*_prefecture.geojson`) も同梱されていることがあるため除外する。
    let geojson_bytes = read_zip_entry(&input, |name| {
        name.ends_with(".geojson") && !name.contains("_prefecture")
    })?;
    let geojson_str =
        String::from_utf8(geojson_bytes).context("N03 geojson is expected to be UTF-8")?;
    let rows = n03::parse_geojson(&geojson_str)?;
    n03::write_geoparquet(rows, &output)?;
    Ok(())
}
