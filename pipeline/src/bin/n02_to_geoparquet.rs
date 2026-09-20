use anyhow::{Context, Result, bail};
use duck_geocoder::n02;
use duck_geocoder::read_zip_entry;

/// 国土数値情報 鉄道データ (N02) のzipに同梱されたGeoJSONをGeoParquetに変換する。
///
/// **zipには路線と駅の2つのGeoJSONが入っている**ので、どちらを出すかを引数で選ぶ。
/// `.geojson` だけで探すと両方に当たり、`read_zip_entry` がエラーにする。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (kind, input, output) = match args.as_slice() {
        [_, kind, input, output] => (kind.as_str(), input.clone(), output.clone()),
        _ => bail!("usage: n02_to_geoparquet <sections|stations> <input.zip> <output.parquet>"),
    };

    // Shift-JIS側にGeoJSONは無い (shp/dbfのみ) ので、UTF-8側だけが当たる。
    let entry_suffix = match kind {
        "sections" => "_RailroadSection.geojson",
        "stations" => "_Station.geojson",
        other => bail!("未知の種別です: {other:?} (sections か stations)"),
    };

    let geojson_bytes = read_zip_entry(input.as_ref(), |name| name.ends_with(entry_suffix))?;
    let geojson_str =
        String::from_utf8(geojson_bytes).context("N02 geojson is expected to be UTF-8")?;

    // **いつ時点のデータか**をメタデータXMLから読む。古いものを新しいと思って
    // 使う事故を防ぐため、配信するファイルに書いておく。
    let meta_bytes = read_zip_entry(input.as_ref(), |name| {
        name.contains("KS-META-") && name.ends_with(".xml")
    })?;
    let vintage = n02::extract_vintage(
        &String::from_utf8(meta_bytes).context("N02 metadata XML is expected to be UTF-8")?,
    )?;

    let rows = n02::parse_geojson(&geojson_str)?;
    let count = rows.len();

    match kind {
        "sections" => n02::write_sections(rows, output.as_ref(), Some(&vintage))?,
        "stations" => n02::write_stations(rows, output.as_ref(), Some(&vintage))?,
        _ => unreachable!("種別は上で絞ってある"),
    }

    println!("{count}件を書き出しました ({vintage}): {output}");
    Ok(())
}
