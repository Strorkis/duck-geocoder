use anyhow::{Result, bail};
use duck_geocoder::isj_block;
use duck_geocoder::{decode_sjis, extract_epsg_from_isj_metadata_xml, read_zip_entry_bytes};
use std::path::PathBuf;

/// 位置参照情報 (街区レベル) の CSV (Shift-JIS) を読み、
/// GeoParquet に変換する。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (input, output) = match args.as_slice() {
        [_, input, output] => (PathBuf::from(input), PathBuf::from(output)),
        _ => bail!("usage: isj_block_to_geoparquet <input.zip> <output.parquet>"),
    };

    let csv_bytes = read_zip_entry_bytes(&input, ".csv")?;
    let csv_text = decode_sjis(&csv_bytes);

    let xml_bytes = read_zip_entry_bytes(&input, ".xml")?;
    let xml_text = decode_sjis(&xml_bytes);
    let source_epsg = extract_epsg_from_isj_metadata_xml(&xml_text)?;

    let rows = isj_block::parse_csv(&csv_text, source_epsg)?;
    isj_block::write_geoparquet(rows, &output)?;
    Ok(())
}
