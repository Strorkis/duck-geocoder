use crate::geoparquet;
use crate::wgs84_transformer;
use anyhow::{Context, Result, bail};
use geo_types::{LineString, MultiPolygon, Polygon};
use proj::Proj;
use std::path::Path;

/// 国土数値情報 行政区域データ (N03) の1行。
#[derive(Debug)]
pub struct Row {
    /// N03_001 (都道府県名)
    pub pref_name: String,
    /// N03_002 (支庁・振興局名)
    pub subprefecture_name: Option<String>,
    /// N03_003 (郡・政令都市名)
    pub county_name: Option<String>,
    /// N03_004 (市区町村名)
    pub city_name: Option<String>,
    /// N03_005 (行政区名)
    pub ward_name: Option<String>,
    /// N03_007 (行政区域コード)。
    /// 列名を `admin_id` にしているのは、行政区域データセットの出所が
    /// 複数ありうるため (Overture Mapsのdivisionsから作る場合はUUIDが入る)。
    /// UIはこれを不透明な識別子としてしか使わない。
    pub admin_id: String,
    /// WGS84 (EPSG:4326) に変換済み。
    /// 元データの座標系はGeoJSONの `crs` フィールドから実行時に読み取っている
    /// (このファイルではJGD2011/EPSG:6668だが決め打ちしていない)。
    pub geometry: MultiPolygon<f64>,
}

/// MultiPolygonの外接矩形 `[xmin, ymin, xmax, ymax]`。全頂点を舐めて求める。
fn multi_polygon_bbox(mp: &MultiPolygon<f64>) -> [f64; 4] {
    mp.0.iter()
        .flat_map(|p| std::iter::once(p.exterior()).chain(p.interiors()))
        .flat_map(|ring| ring.coords())
        .fold(
            [f64::MAX, f64::MAX, f64::MIN, f64::MIN],
            |[xmin, ymin, xmax, ymax], c| {
                [xmin.min(c.x), ymin.min(c.y), xmax.max(c.x), ymax.max(c.y)]
            },
        )
}

/// GeoJSON の `crs` フィールド (例: "urn:ogc:def:crs:EPSG::6668") からEPSGコードを取り出す。
fn extract_epsg(foreign_members: Option<&geojson::JsonObject>) -> Result<u32> {
    let name = foreign_members
        .context("geojson has no crs (foreign_members is empty)")?
        .get("crs")
        .and_then(|c| c.get("properties"))
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
        .context("crs.properties.name not found in geojson")?;

    name.rsplit(':')
        .next()
        .context("could not parse EPSG code from crs name")?
        .parse::<u32>()
        .with_context(|| format!("crs name is not a valid EPSG code: {name:?}"))
}

/// MultiPolygon の全頂点を変換する。
fn transform_multi_polygon(mp: MultiPolygon<f64>, proj: &Proj) -> Result<MultiPolygon<f64>> {
    let polygons =
        mp.0.into_iter()
            .map(|polygon| {
                let (exterior, interiors) = polygon.into_inner();
                let exterior = transform_ring(exterior, proj)?;
                let interiors = interiors
                    .into_iter()
                    .map(|ring| transform_ring(ring, proj))
                    .collect::<Result<Vec<_>>>()?;
                Ok(Polygon::new(exterior, interiors))
            })
            .collect::<Result<Vec<_>>>()?;
    Ok(MultiPolygon(polygons))
}

fn transform_ring(ring: LineString<f64>, proj: &Proj) -> Result<LineString<f64>> {
    let mut points: Vec<(f64, f64)> = ring.into_iter().map(|c| (c.x, c.y)).collect();
    proj.convert_array(&mut points)
        .context("failed to transform polygon ring to WGS84")?;
    Ok(LineString::from(points))
}

/// N03 の GeoJSON (UTF-8 文字列) をパースして Row の列に変換する。
pub fn parse_geojson(geojson_str: &str) -> Result<Vec<Row>> {
    let geojson: geojson::GeoJson = geojson_str.parse()?;
    let collection = match geojson {
        geojson::GeoJson::FeatureCollection(fc) => fc,
        _ => bail!("expected a FeatureCollection"),
    };

    let source_epsg = extract_epsg(collection.foreign_members.as_ref())?;

    let mut rows_with_source_geometry: Vec<(Row, MultiPolygon<f64>)> = collection
        .features
        .into_iter()
        .map(|feature| {
            let props = feature.properties.clone().unwrap_or_default();
            let get_string = |key: &str| -> Option<String> {
                props
                    .get(key)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            };

            let geojson_geometry = feature.geometry.context("feature is missing geometry")?;
            let geometry = geo_types::Geometry::<f64>::try_from(geojson_geometry)?;
            let multi_polygon = match geometry {
                geo_types::Geometry::MultiPolygon(mp) => mp,
                geo_types::Geometry::Polygon(p) => MultiPolygon(vec![p]),
                other => bail!("unexpected geometry type: {other:?}"),
            };

            let row = Row {
                pref_name: get_string("N03_001").context("missing N03_001 (pref name)")?,
                subprefecture_name: get_string("N03_002"),
                county_name: get_string("N03_003"),
                city_name: get_string("N03_004"),
                ward_name: get_string("N03_005"),
                admin_id: get_string("N03_007").context("missing N03_007 (admin code)")?,
                geometry: MultiPolygon(vec![]),
            };
            Ok((row, multi_polygon))
        })
        .collect::<Result<Vec<_>>>()?;

    let [west, south, east, north] = rows_with_source_geometry.iter().fold(
        [f64::MAX, f64::MAX, f64::MIN, f64::MIN],
        |[west, south, east, north], (_, mp)| {
            let [w, s, e, n] = multi_polygon_bbox(mp);
            [west.min(w), south.min(s), east.max(e), north.max(n)]
        },
    );

    let proj = wgs84_transformer(source_epsg, (west, south, east, north))?;

    rows_with_source_geometry
        .drain(..)
        .map(|(mut row, mp)| {
            row.geometry = transform_multi_polygon(mp, &proj)?;
            Ok(row)
        })
        .collect()
}

/// パースした行をGeoParquetとして書き出す。
pub fn write_geoparquet(rows: Vec<Row>, output: &Path) -> Result<()> {
    let mut pref_name = Vec::with_capacity(rows.len());
    let mut subprefecture_name = Vec::with_capacity(rows.len());
    let mut county_name = Vec::with_capacity(rows.len());
    let mut city_name = Vec::with_capacity(rows.len());
    let mut ward_name = Vec::with_capacity(rows.len());
    let mut admin_id = Vec::with_capacity(rows.len());
    let mut geometries = Vec::with_capacity(rows.len());
    for row in rows {
        pref_name.push(row.pref_name);
        subprefecture_name.push(row.subprefecture_name);
        county_name.push(row.county_name);
        city_name.push(row.city_name);
        ward_name.push(row.ward_name);
        admin_id.push(row.admin_id);
        geometries.push(row.geometry);
    }

    let (geometry, bbox, file_bbox) =
        geoparquet::geometry_columns(&geometries, multi_polygon_bbox)?;

    let columns = vec![
        geoparquet::utf8_column("pref_name", pref_name.into_iter()),
        geoparquet::utf8_nullable_column("subprefecture_name", subprefecture_name.into_iter()),
        geoparquet::utf8_nullable_column("county_name", county_name.into_iter()),
        geoparquet::utf8_nullable_column("city_name", city_name.into_iter()),
        geoparquet::utf8_nullable_column("ward_name", ward_name.into_iter()),
        geoparquet::utf8_column("admin_id", admin_id.into_iter()),
    ];

    geoparquet::write(
        output,
        columns,
        "geometry",
        geometry,
        bbox,
        &["MultiPolygon".to_string()],
        file_bbox,
    )
    .with_context(|| format!("書き出しに失敗しました: {}", output.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
    {
      "type": "FeatureCollection",
      "name": "N03-test",
      "crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::6668" } },
      "features": [
        { "type": "Feature", "properties": { "N03_001": "神奈川県", "N03_002": null, "N03_003": null, "N03_004": "横浜市", "N03_005": "鶴見区", "N03_007": "14101" }, "geometry": { "type": "MultiPolygon", "coordinates": [ [ [ [ 139.0, 35.0 ], [ 139.1, 35.0 ], [ 139.1, 35.1 ], [ 139.0, 35.0 ] ] ] ] } }
      ]
    }
    "#;

    #[test]
    fn parses_feature_properties_and_geometry() {
        let rows = parse_geojson(SAMPLE).unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.pref_name, "神奈川県");
        assert_eq!(row.subprefecture_name, None);
        assert_eq!(row.county_name, None);
        assert_eq!(row.city_name.as_deref(), Some("横浜市"));
        assert_eq!(row.ward_name.as_deref(), Some("鶴見区"));
        assert_eq!(row.admin_id, "14101");
        assert_eq!(row.geometry.0.len(), 1, "expected a single polygon ring");
        // JGD2011->WGS84 はこの地域では近似上シフト0 (EPSG:6698/1826)。
        let exterior = row.geometry.0[0].exterior();
        assert!((exterior.0[0].x - 139.0).abs() < 1e-6);
        assert!((exterior.0[0].y - 35.0).abs() < 1e-6);
    }

    #[test]
    fn rejects_non_feature_collection() {
        let err = parse_geojson(r#"{"type":"Point","coordinates":[1.0,2.0]}"#).unwrap_err();
        assert!(err.to_string().contains("FeatureCollection"));
    }

    #[test]
    fn rejects_missing_required_property() {
        let missing_pref_name = r#"
        {
          "type": "FeatureCollection",
          "crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::6668" } },
          "features": [
            { "type": "Feature", "properties": { "N03_007": "14101" }, "geometry": { "type": "MultiPolygon", "coordinates": [ [ [ [ 139.0, 35.0 ], [ 139.1, 35.0 ], [ 139.1, 35.1 ], [ 139.0, 35.0 ] ] ] ] } }
          ]
        }
        "#;
        let err = parse_geojson(missing_pref_name).unwrap_err();
        assert!(err.to_string().contains("N03_001"));
    }

    #[test]
    fn rejects_missing_crs() {
        let missing_crs = r#"
        {
          "type": "FeatureCollection",
          "features": [
            { "type": "Feature", "properties": { "N03_001": "神奈川県", "N03_007": "14101" }, "geometry": { "type": "MultiPolygon", "coordinates": [ [ [ [ 139.0, 35.0 ], [ 139.1, 35.0 ], [ 139.1, 35.1 ], [ 139.0, 35.0 ] ] ] ] } }
          ]
        }
        "#;
        assert!(parse_geojson(missing_crs).is_err());
    }
}
