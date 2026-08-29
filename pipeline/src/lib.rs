use anyhow::{Context, Result, bail};
use proj::{Area, Proj};
use std::fs::File;
use std::path::Path;

pub mod admin_names;
pub mod catalog;
pub mod geoparquet;
pub mod isj_block;
pub mod isj_oaza;
pub mod n03;
pub mod overture;
pub mod spatial_pack;

/// 指定したEPSGコードからWGS84 (EPSG:4326) への変換器を作る。
/// `bbox` (west, south, east, north) は変換対象データの範囲で、
/// PROJが地域に応じた適切な変換方式を選ぶためのヒントとして使われる
/// (例: JGD2000→JGD2011は地震の影響を受けた北日本の県で別の変換式になる)。
pub fn wgs84_transformer(source_epsg: u32, bbox: (f64, f64, f64, f64)) -> Result<Proj> {
    let (west, south, east, north) = bbox;
    let area = Area::new(west, south, east, north);
    let from = format!("EPSG:{source_epsg}");
    Proj::new_known_crs(&from, "EPSG:4326", Some(area))
        .with_context(|| format!("failed to build a transformer from {from} to EPSG:4326"))
}

/// 位置参照情報 (ISJ) のメタデータXML (JMP20スキーマ、UTF-8に変換済み) から、
/// 座標系のEPSGコードを読み取る。既知の文字列以外はエラーにする
/// (将来JGD2024などに変わった場合に気付かず誤変換しないため)。
pub fn extract_epsg_from_isj_metadata_xml(xml_text: &str) -> Result<u32> {
    let doc = roxmltree::Document::parse(xml_text).context("failed to parse metadata XML")?;
    let code_text = doc
        .descendants()
        .find(|n| n.has_tag_name("referenceSystemIdentifier"))
        .and_then(|n| n.children().find(|c| c.has_tag_name("code")))
        .and_then(|n| n.text())
        .context("referenceSystemIdentifier/code not found in metadata XML")?
        .trim();

    match code_text {
        "JGD2000 / (B, L)" => Ok(4612),
        "JGD2011 / (B, L)" => Ok(6668),
        other => bail!("unrecognized reference system identifier in metadata XML: {other:?}"),
    }
}

/// zipアーカイブの中から `matches` に一致する唯一のエントリを探し、その生バイト列を返す。
/// 一致するエントリが0件または2件以上の場合はエラーにする
/// (該当ファイルが複数あるzip、例えば国土数値情報の全国版は詳細版と都道府県単位に
/// 統合された簡易版の2種類のGeoJSONを同梱していることがあり、`matches` が曖昧だと
/// 意図しない方を黙って拾ってしまう)。
pub fn read_zip_entry(zip_path: &Path, matches: impl Fn(&str) -> bool) -> Result<Vec<u8>> {
    let file =
        File::open(zip_path).with_context(|| format!("failed to open {}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .with_context(|| format!("failed to read zip archive {}", zip_path.display()))?;

    let mut matching_names = Vec::new();
    for i in 0..archive.len() {
        let name = archive.by_index(i)?.name().to_string();
        if matches(&name) {
            matching_names.push(name);
        }
    }

    let name = match matching_names.as_slice() {
        [name] => name.clone(),
        [] => bail!("no matching entry found in {}", zip_path.display()),
        many => bail!(
            "multiple entries matched in {}: {many:?} (need a more specific predicate)",
            zip_path.display()
        ),
    };

    let mut entry = archive.by_name(&name)?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    std::io::copy(&mut entry, &mut buf)?;
    Ok(buf)
}

/// [`read_zip_entry`] の、名前が `extension` で終わることだけを条件にする版。
pub fn read_zip_entry_bytes(zip_path: &Path, extension: &str) -> Result<Vec<u8>> {
    read_zip_entry(zip_path, |name| name.ends_with(extension))
}

/// Shift-JISのバイト列をUTF-8の文字列にデコードする。
pub fn decode_sjis(bytes: &[u8]) -> String {
    encoding_rs::SHIFT_JIS.decode(bytes).0.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// テスト用に、指定したエントリだけを持つzipファイルを一時ディレクトリに作る。
    fn write_test_zip(name: &str, entries: &[(&str, &[u8])]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        let file = File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (entry_name, data) in entries {
            zip.start_file(*entry_name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    // 国土数値情報の全国版zipは、詳細な市区町村単位のgeojsonと、都道府県単位に
    // 統合した簡易版 (`*_prefecture.geojson`) の2つを同梱していることがある。
    // これに気づかず ends_with(".geojson") だけで探すと、意図しない方を黙って
    // 拾ってしまい、パース結果がおかしくなるのに気づけない、という実害があった。
    #[test]
    fn read_zip_entry_bytes_errors_on_ambiguous_match() {
        let path = write_test_zip(
            "duck_geocoder_test_ambiguous.zip",
            &[
                ("foo.geojson", b"detailed" as &[u8]),
                ("foo_prefecture.geojson", b"dissolved" as &[u8]),
            ],
        );

        let err = read_zip_entry_bytes(&path, ".geojson").unwrap_err();
        assert!(err.to_string().contains("multiple entries matched"));

        let bytes = read_zip_entry(&path, |name| {
            name.ends_with(".geojson") && !name.contains("_prefecture")
        })
        .unwrap();
        assert_eq!(bytes, b"detailed");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_zip_entry_bytes_errors_on_no_match() {
        let path = write_test_zip(
            "duck_geocoder_test_no_match.zip",
            &[("foo.csv", b"data" as &[u8])],
        );

        let err = read_zip_entry_bytes(&path, ".geojson").unwrap_err();
        assert!(err.to_string().contains("no matching entry"));

        std::fs::remove_file(&path).ok();
    }
}
