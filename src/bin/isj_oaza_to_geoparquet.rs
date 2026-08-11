use anyhow::{bail, Result};
use duck_geocoder::isj_oaza::{self, Row};
use duck_geocoder::{decode_sjis, extract_epsg_from_isj_metadata_xml, read_zip_entry_bytes};
use geoparquet_batch_writer::GeoParquetBatchWriter;
use std::path::PathBuf;

/// 位置参照情報 (大字・町丁目レベル) の CSV (Shift-JIS) を読み、
/// GeoParquet に変換する。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (input, output) = match args.as_slice() {
        [_, input, output] => (PathBuf::from(input), PathBuf::from(output)),
        _ => bail!("usage: isj_oaza_to_geoparquet <input.zip> <output.parquet>"),
    };

    let csv_bytes = read_zip_entry_bytes(&input, ".csv")?;
    let csv_text = decode_sjis(&csv_bytes);

    let xml_bytes = read_zip_entry_bytes(&input, ".xml")?;
    let xml_text = decode_sjis(&xml_bytes);
    let source_epsg = extract_epsg_from_isj_metadata_xml(&xml_text)?;

    let rows = isj_oaza::parse_csv(&csv_text, source_epsg)?;

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut writer: GeoParquetBatchWriter<Row> =
        GeoParquetBatchWriter::new(&output, Default::default())?;
    for row in rows {
        writer.add_row(row)?;
    }
    writer.finish()?;
    Ok(())
}
