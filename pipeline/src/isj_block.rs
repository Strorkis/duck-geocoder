use crate::geoparquet;
use crate::wgs84_transformer;
use anyhow::{Context, Result};
use geo_types::Point;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
struct CsvRow {
    #[serde(rename = "都道府県名")]
    pref_name: String,
    #[serde(rename = "市区町村名")]
    city_name: String,
    #[serde(rename = "大字・丁目名")]
    oaza_name: String,
    #[serde(rename = "小字・通称名")]
    koaza_name: String,
    #[serde(rename = "街区符号・地番")]
    block_number: String,
    #[serde(rename = "緯度")]
    lat: f64,
    #[serde(rename = "経度")]
    lon: f64,
    #[serde(rename = "住居表示フラグ")]
    residential_display_flag: String,
    #[serde(rename = "代表フラグ")]
    representative_flag: String,
}

/// 位置参照情報 (街区レベル) の1行。
#[derive(Debug)]
pub struct Row {
    /// 都道府県名
    pub pref_name: String,
    /// 市区町村名
    pub city_name: String,
    /// 大字・丁目名 (oaza-levelファイルの「大字町丁目名」とは表記が異なる)
    pub oaza_name: String,
    /// 小字・通称名
    pub koaza_name: String,
    /// 街区符号・地番
    pub block_number: String,
    /// 住居表示フラグ
    pub residential_display_flag: String,
    /// 代表フラグ
    pub representative_flag: String,
    /// WGS84 (EPSG:4326) に変換済み。元データの座標系は同梱のメタデータXMLから
    /// 読み取った `source_epsg` (このファイルではJGD2000/EPSG:4612)。
    pub geometry: Point<f64>,
}

/// 位置参照情報 (街区レベル) の CSV (UTF-8 に変換済み) をパースする。
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
            pref_name: row.pref_name,
            city_name: row.city_name,
            oaza_name: row.oaza_name,
            koaza_name: row.koaza_name,
            block_number: row.block_number,
            residential_display_flag: row.residential_display_flag,
            representative_flag: row.representative_flag,
            geometry: Point::new(lon, lat),
        })
        .collect())
}

/// パースした行をGeoParquetとして書き出す。
pub fn write_geoparquet(rows: Vec<Row>, output: &Path) -> Result<()> {
    let mut pref_name = Vec::with_capacity(rows.len());
    let mut city_name = Vec::with_capacity(rows.len());
    let mut oaza_name = Vec::with_capacity(rows.len());
    let mut koaza_name = Vec::with_capacity(rows.len());
    let mut block_number = Vec::with_capacity(rows.len());
    let mut residential_display_flag = Vec::with_capacity(rows.len());
    let mut representative_flag = Vec::with_capacity(rows.len());
    let mut geometries = Vec::with_capacity(rows.len());
    for row in rows {
        pref_name.push(row.pref_name);
        city_name.push(row.city_name);
        oaza_name.push(row.oaza_name);
        koaza_name.push(row.koaza_name);
        block_number.push(row.block_number);
        residential_display_flag.push(row.residential_display_flag);
        representative_flag.push(row.representative_flag);
        geometries.push(row.geometry);
    }

    let (geometry, bbox, file_bbox) =
        geoparquet::geometry_columns(&geometries, |p| [p.x(), p.y(), p.x(), p.y()])?;

    let columns = vec![
        geoparquet::utf8_column("pref_name", pref_name.into_iter()),
        geoparquet::utf8_column("city_name", city_name.into_iter()),
        geoparquet::utf8_column("oaza_name", oaza_name.into_iter()),
        geoparquet::utf8_column("koaza_name", koaza_name.into_iter()),
        geoparquet::utf8_column("block_number", block_number.into_iter()),
        geoparquet::utf8_column(
            "residential_display_flag",
            residential_display_flag.into_iter(),
        ),
        geoparquet::utf8_column("representative_flag", representative_flag.into_iter()),
    ];

    geoparquet::write(
        output,
        columns,
        "geometry",
        geometry,
        bbox,
        &["Point".to_string()],
        file_bbox,
        geoparquet::Provenance::default(),
    )
    .with_context(|| format!("書き出しに失敗しました: {}", output.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\"都道府県名\",\"市区町村名\",\"大字・丁目名\",\"小字・通称名\",\"街区符号・地番\",\"座標系番号\",\"Ｘ座標\",\"Ｙ座標\",\"緯度\",\"経度\",\"住居表示フラグ\",\"代表フラグ\",\"更新前履歴フラグ\",\"更新後履歴フラグ\"\n\"神奈川県\",\"横浜市鶴見区\",\"上の宮二丁目\",\"\",\"6\",\"9\",\"-53821.1\",\"-17911.6\",\"35.514716\",\"139.635860\",\"1\",\"1\",\"0\",\"0\"\n";

    #[test]
    fn parses_row_and_builds_point_as_lon_lat() {
        let rows = parse_csv(SAMPLE, 4612).unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.city_name, "横浜市鶴見区");
        assert_eq!(row.oaza_name, "上の宮二丁目");
        assert_eq!(row.koaza_name, "");
        assert_eq!(row.block_number, "6");
        assert!((row.geometry.x() - 139.635860).abs() < 1e-6);
        assert!((row.geometry.y() - 35.514716).abs() < 1e-6);
    }

    #[test]
    fn rejects_malformed_row() {
        let bad = "\"都道府県名\"\n\"神奈川県\",\"余計な列\"\n";
        assert!(parse_csv(bad, 4612).is_err());
    }
}
