use crate::wgs84_transformer;
use anyhow::Result;
use geo_types::Point;
use geoparquet_batch_writer::GeoParquetRowData;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct CsvRow {
    #[serde(rename = "都道府県コード")]
    pref_code: String,
    #[serde(rename = "都道府県名")]
    pref_name: String,
    #[serde(rename = "市区町村コード")]
    city_code: String,
    #[serde(rename = "市区町村名")]
    city_name: String,
    #[serde(rename = "大字町丁目コード")]
    oaza_code: String,
    #[serde(rename = "大字町丁目名")]
    oaza_name: String,
    #[serde(rename = "緯度")]
    lat: f64,
    #[serde(rename = "経度")]
    lon: f64,
    #[serde(rename = "原典資料コード")]
    origin_code: String,
    #[serde(rename = "大字・字・丁目区分コード")]
    classification_code: String,
}

/// 位置参照情報 (大字・町丁目レベル) の1行。
#[derive(Debug, GeoParquetRowData)]
pub struct Row {
    /// 都道府県コード
    pub pref_code: String,
    /// 都道府県名
    pub pref_name: String,
    /// 市区町村コード
    pub city_code: String,
    /// 市区町村名
    pub city_name: String,
    /// 大字町丁目コード
    pub oaza_code: String,
    /// 大字町丁目名
    pub oaza_name: String,
    /// 原典資料コード
    pub origin_code: String,
    /// 大字・字・丁目区分コード
    pub classification_code: String,
    /// WGS84 (EPSG:4326) に変換済み。元データの座標系は同梱のメタデータXMLから
    /// 読み取った `source_epsg` (このファイルではJGD2000/EPSG:4612)。
    #[geo(geometry)]
    pub geometry: Point<f64>,
}

/// 位置参照情報 (大字・町丁目レベル) の CSV (UTF-8 に変換済み) をパースする。
/// `source_epsg` は同梱のメタデータXMLから読み取った、緯度・経度が準拠する座標系。
pub fn parse_csv(csv_text: &str, source_epsg: u32) -> Result<Vec<Row>> {
    let mut reader = csv::Reader::from_reader(csv_text.as_bytes());
    let csv_rows: Vec<CsvRow> = reader
        .deserialize()
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut points: Vec<(f64, f64)> = csv_rows.iter().map(|r| (r.lon, r.lat)).collect();
    if !points.is_empty() {
        let (west, east) = points
            .iter()
            .fold((f64::MAX, f64::MIN), |(w, e), p| (w.min(p.0), e.max(p.0)));
        let (south, north) = points
            .iter()
            .fold((f64::MAX, f64::MIN), |(s, n), p| (s.min(p.1), n.max(p.1)));
        let proj = wgs84_transformer(source_epsg, (west, south, east, north))?;
        proj.convert_array(&mut points)?;
    }

    Ok(csv_rows
        .into_iter()
        .zip(points)
        .map(|(row, (lon, lat))| Row {
            pref_code: row.pref_code,
            pref_name: row.pref_name,
            city_code: row.city_code,
            city_name: row.city_name,
            oaza_code: row.oaza_code,
            oaza_name: row.oaza_name,
            origin_code: row.origin_code,
            classification_code: row.classification_code,
            geometry: Point::new(lon, lat),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\"都道府県コード\",\"都道府県名\",\"市区町村コード\",\"市区町村名\",\"大字町丁目コード\",\"大字町丁目名\",\"緯度\",\"経度\",\"原典資料コード\",\"大字・字・丁目区分コード\"\n\"14\",\"神奈川県\",\"14101\",\"横浜市鶴見区\",\"141010001001\",\"本町通一丁目\",\"35.502643\",\"139.680165\",\"0\",\"3\"\n";

    #[test]
    fn parses_row_and_builds_point_as_lon_lat() {
        let rows = parse_csv(SAMPLE, 4612).unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.pref_name, "神奈川県");
        assert_eq!(row.city_name, "横浜市鶴見区");
        assert_eq!(row.oaza_name, "本町通一丁目");
        // Point は (経度, 緯度) の順であること。JGD2000->WGS84はこの地域では近似上シフト0。
        assert!((row.geometry.x() - 139.680165).abs() < 1e-6);
        assert!((row.geometry.y() - 35.502643).abs() < 1e-6);
    }

    #[test]
    fn rejects_malformed_row() {
        let bad = "\"都道府県コード\",\"都道府県名\"\n\"14\"\n";
        assert!(parse_csv(bad, 4612).is_err());
    }
}
