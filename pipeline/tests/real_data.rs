use duck_geocoder::{
    decode_sjis, extract_epsg_from_isj_metadata_xml, isj_block, isj_oaza, n03,
    read_zip_entry_bytes,
};
use std::path::Path;

/// このリポジトリの `data/` は手動ダウンロードしたファイルを置く場所で、
/// git管理はしていない。ファイルが無い環境 (fresh clone 直後など) では
/// テストを失敗させず、その旨を表示してスキップする。
macro_rules! require_fixture {
    ($path:expr) => {{
        let path = Path::new($path);
        if !path.exists() {
            eprintln!(
                "skipping: {} not found (see README for manual download instructions)",
                path.display()
            );
            return;
        }
        path
    }};
}

#[test]
fn n03_kanagawa_parses_all_features() {
    let path = require_fixture!("../data/ksj/N03/N03-20260101_14_GML.zip");

    let geojson_bytes = read_zip_entry_bytes(path, ".geojson").unwrap();
    let geojson_str = String::from_utf8(geojson_bytes).unwrap();
    let rows = n03::parse_geojson(&geojson_str).unwrap();

    assert_eq!(rows.len(), 1247);
    assert!(rows.iter().all(|r| r.pref_name == "神奈川県"));
    assert!(rows.iter().any(|r| r.city_name.as_deref() == Some("横浜市")
        && r.ward_name.as_deref() == Some("鶴見区")
        && r.admin_id == "14101"));
}

#[test]
fn isj_oaza_kanagawa_parses_all_rows() {
    let path = require_fixture!("../data/isj/oaza/14000-19.0b.zip");

    let csv_bytes = read_zip_entry_bytes(path, ".csv").unwrap();
    let csv_text = decode_sjis(&csv_bytes);
    let xml_bytes = read_zip_entry_bytes(path, ".xml").unwrap();
    let xml_text = decode_sjis(&xml_bytes);
    let source_epsg = extract_epsg_from_isj_metadata_xml(&xml_text).unwrap();
    assert_eq!(source_epsg, 4612, "oaza-level metadata should declare JGD2000");

    let rows = isj_oaza::parse_csv(&csv_text, source_epsg).unwrap();

    assert_eq!(rows.len(), 4927);
    let first = rows
        .iter()
        .find(|r| r.city_name == "横浜市鶴見区" && r.oaza_name == "本町通一丁目")
        .expect("known row should be present");
    assert!((first.geometry.x() - 139.680165).abs() < 1e-6);
    assert!((first.geometry.y() - 35.502643).abs() < 1e-6);
}

#[test]
fn isj_block_kanagawa_parses_all_rows() {
    let path = require_fixture!("../data/isj/block/14000-24.0a.zip");

    let csv_bytes = read_zip_entry_bytes(path, ".csv").unwrap();
    let csv_text = decode_sjis(&csv_bytes);
    let xml_bytes = read_zip_entry_bytes(path, ".xml").unwrap();
    let xml_text = decode_sjis(&xml_bytes);
    let source_epsg = extract_epsg_from_isj_metadata_xml(&xml_text).unwrap();
    assert_eq!(source_epsg, 4612, "block-level metadata should declare JGD2000");

    let rows = isj_block::parse_csv(&csv_text, source_epsg).unwrap();

    assert_eq!(rows.len(), 571233);
    assert!(rows
        .iter()
        .any(|r| r.city_name == "横浜市鶴見区" && r.oaza_name == "上の宮二丁目" && r.block_number == "6"));
}
