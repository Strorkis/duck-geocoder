//! 国土数値情報 鉄道データ (N02) を読む。
//!
//! zipには**路線と駅の2つのGeoJSONが入っている**。詳細版と簡易版のような
//! 同じものの別表現ではなく別のデータなので、`read_zip_entry` に渡す述語は
//! `RailroadSection.geojson` / `Station.geojson` まで絞ること。
//!
//! **駅のジオメトリも線**。点ではなくホームの延長を表す短い線分になっている
//! (製品仕様上、駅は鉄道路線の一部分として整備されている)。代表点に潰さず
//! そのまま配る。
use crate::geoparquet;
use crate::wgs84_transformer;
use anyhow::{Context, Result, bail};
use arrow::array::ArrayRef;
use arrow::datatypes::Field;
use geo_types::LineString;
use proj::Proj;
use std::path::Path;

/// 鉄道区分コード (N02_001)。
///
/// **コードリストはzipに同梱されていない。** PLATEAUのCityGMLが `codelists/*.xml` を
/// 持っているのとは違い、N02は配布元のコードリストページにしかないので、ここに写す。
/// <https://nlftp.mlit.go.jp/ksj/gml/codelist/RailwayClassCd.html>
///
/// 鉄道事業法が適用される鉄道は11〜17、軌道法が適用される軌道は21〜25。
const RAILWAY_CLASS: &[(&str, &str)] = &[
    ("11", "普通鉄道JR"),
    ("12", "普通鉄道"),
    ("13", "鋼索鉄道"),
    ("14", "懸垂式鉄道"),
    ("15", "跨座式鉄道"),
    ("16", "案内軌条式鉄道"),
    ("17", "無軌条鉄道"),
    ("21", "軌道"),
    ("22", "懸垂式モノレール"),
    ("23", "跨座式モノレール"),
    ("24", "案内軌条式"),
    ("25", "浮上式"),
];

/// 事業者種別コード (N02_002)。
/// <https://nlftp.mlit.go.jp/ksj/gml/codelist/InstitutionTypeCd.html>
const INSTITUTION_TYPE: &[(&str, &str)] = &[
    ("1", "JRの新幹線"),
    ("2", "JR在来線"),
    ("3", "公営鉄道"),
    ("4", "民営鉄道"),
    ("5", "第三セクター"),
];

/// コードを名前に解決する。**未知のコードはエラーにする。**
///
/// 黙って「不明」で通すと、コードリストが増えたときに気付けない
/// (2025年度データに17 無軌条鉄道は出てこないが、定義は残っている)。
fn resolve(table: &[(&str, &str)], code: &str, field: &str) -> Result<String> {
    table
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, name)| name.to_string())
        .with_context(|| format!("未知の{field}コードです: {code:?}"))
}

/// 鉄道データの1行。路線と駅で共通の属性に、駅だけが持つものを足した形。
#[derive(Debug)]
pub struct Row {
    /// N02_001 (鉄道区分コード)。生の値も残す。UIが名前で出せないときに使う。
    pub railway_class_code: String,
    /// 鉄道区分コードを解決した名前。
    pub railway_class: String,
    /// N02_002 (事業者種別コード)。
    pub institution_type_code: String,
    /// 事業者種別コードを解決した名前。
    pub institution_type: String,
    /// N02_003 (路線名)。
    pub line_name: String,
    /// N02_004 (運営会社)。
    pub operator: String,
    /// N02_005 (駅名)。路線には無い。
    pub station_name: Option<String>,
    /// N02_005c (駅コード)。
    pub station_code: Option<String>,
    /// N02_005g (駅グループコード)。同じ駅の別路線ぶんをまとめる。
    pub station_group_code: Option<String>,
    /// WGS84 (EPSG:4326) に変換済み。
    /// 元データの座標系はGeoJSONの `crs` から実行時に読み取っている。
    pub geometry: LineString<f64>,
}

/// メタデータXML (JMP20スキーマ) から、**いつ時点のデータか**を読む。
///
/// `<title>` に「国土数値情報（鉄道）　N02-25」のようにデータセットの識別子が入り、
/// 先頭の `<date>` がその版の日付になっている。**ファイル名からは読まない** —
/// 展開先の名前は変えられるので、中身から取る。
///
/// 返すのは「N02-25 (2026-03-06)」のような文字列。
/// **こちらで年度に直したりしない。**配布元が名乗っている形をそのまま持ち回る。
pub fn extract_vintage(xml_text: &str) -> Result<String> {
    let doc = roxmltree::Document::parse(xml_text).context("メタデータXMLを読めません")?;

    let title = doc
        .descendants()
        .find(|n| n.has_tag_name("title"))
        .and_then(|n| n.text())
        .context("メタデータXMLに title がありません")?
        .trim();

    // 全角スペースで区切られた最後の要素が識別子 (N02-25)。
    let identifier = title
        .split(['\u{3000}', ' '])
        .rfind(|part| !part.is_empty())
        .context("title からデータセット識別子を取り出せません")?;

    let date = doc
        .descendants()
        .find(|n| n.has_tag_name("date") && n.children().any(|c| c.has_tag_name("date")))
        .and_then(|n| n.children().find(|c| c.has_tag_name("date")))
        .and_then(|n| n.text())
        .map(str::trim);

    Ok(match date {
        Some(date) => format!("{identifier} ({date})"),
        None => identifier.to_string(),
    })
}

/// LineStringの外接矩形 `[xmin, ymin, xmax, ymax]`。
fn line_string_bbox(ls: &LineString<f64>) -> [f64; 4] {
    ls.coords().fold(
        [f64::MAX, f64::MAX, f64::MIN, f64::MIN],
        |[xmin, ymin, xmax, ymax], c| [xmin.min(c.x), ymin.min(c.y), xmax.max(c.x), ymax.max(c.y)],
    )
}

fn transform_line_string(ls: LineString<f64>, proj: &Proj) -> Result<LineString<f64>> {
    let mut points: Vec<(f64, f64)> = ls.into_iter().map(|c| (c.x, c.y)).collect();
    proj.convert_array(&mut points)
        .context("failed to transform line to WGS84")?;
    Ok(LineString::from(points))
}

/// N02 の GeoJSON (UTF-8 文字列) をパースして Row の列に変換する。
/// 路線・駅のどちらにも使える (駅だけが持つ項目は `None` になる)。
pub fn parse_geojson(geojson_str: &str) -> Result<Vec<Row>> {
    let geojson: geojson::GeoJson = geojson_str.parse()?;
    let collection = match geojson {
        geojson::GeoJson::FeatureCollection(fc) => fc,
        _ => bail!("expected a FeatureCollection"),
    };

    let source_epsg = crate::extract_epsg_from_geojson(collection.foreign_members.as_ref())?;

    let mut rows_with_source_geometry: Vec<(Row, LineString<f64>)> = collection
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
            let line = match geometry {
                geo_types::Geometry::LineString(ls) => ls,
                other => bail!("unexpected geometry type: {other:?}"),
            };

            let railway_class_code =
                get_string("N02_001").context("missing N02_001 (railway class)")?;
            let institution_type_code =
                get_string("N02_002").context("missing N02_002 (institution type)")?;

            let row = Row {
                railway_class: resolve(RAILWAY_CLASS, &railway_class_code, "鉄道区分")?,
                railway_class_code,
                institution_type: resolve(INSTITUTION_TYPE, &institution_type_code, "事業者種別")?,
                institution_type_code,
                line_name: get_string("N02_003").context("missing N02_003 (line name)")?,
                operator: get_string("N02_004").context("missing N02_004 (operator)")?,
                station_name: get_string("N02_005"),
                station_code: get_string("N02_005c"),
                station_group_code: get_string("N02_005g"),
                geometry: LineString::new(vec![]),
            };
            Ok((row, line))
        })
        .collect::<Result<Vec<_>>>()?;

    let [west, south, east, north] = rows_with_source_geometry.iter().fold(
        [f64::MAX, f64::MAX, f64::MIN, f64::MIN],
        |[west, south, east, north], (_, ls)| {
            let [w, s, e, n] = line_string_bbox(ls);
            [west.min(w), south.min(s), east.max(e), north.max(n)]
        },
    );

    let proj = wgs84_transformer(source_epsg, (west, south, east, north))?;

    rows_with_source_geometry
        .drain(..)
        .map(|(mut row, ls)| {
            row.geometry = transform_line_string(ls, &proj)?;
            Ok(row)
        })
        .collect()
}

/// 路線・駅に共通の列。**コードと解決した名前の両方を出す。**
/// 名前はUIの表示と絞り込みに、コードは名前で出せない場面と原典との突き合わせに使う。
fn shared_columns(rows: &[Row]) -> Vec<(Field, ArrayRef)> {
    let take =
        |f: fn(&Row) -> &String| -> Vec<String> { rows.iter().map(|r| f(r).clone()).collect() };
    vec![
        geoparquet::utf8_column("railway_class", take(|r| &r.railway_class).into_iter()),
        geoparquet::utf8_column(
            "railway_class_code",
            take(|r| &r.railway_class_code).into_iter(),
        ),
        geoparquet::utf8_column(
            "institution_type",
            take(|r| &r.institution_type).into_iter(),
        ),
        geoparquet::utf8_column(
            "institution_type_code",
            take(|r| &r.institution_type_code).into_iter(),
        ),
        geoparquet::utf8_column("line_name", take(|r| &r.line_name).into_iter()),
        geoparquet::utf8_column("operator", take(|r| &r.operator).into_iter()),
    ]
}

/// 路線をGeoParquetとして書き出す。
pub fn write_sections(rows: Vec<Row>, output: &Path, vintage: Option<&str>) -> Result<()> {
    let columns = shared_columns(&rows);
    let geometries: Vec<LineString<f64>> = rows.into_iter().map(|r| r.geometry).collect();
    write(output, columns, geometries, vintage)
}

/// 駅をGeoParquetとして書き出す。
///
/// **駅名の無い行があればエラーにする。** 路線のファイルを駅として書き出そうとした
/// ときに、駅名が全部NULLのファイルを黙って作らないため。
pub fn write_stations(rows: Vec<Row>, output: &Path, vintage: Option<&str>) -> Result<()> {
    if let Some(i) = rows.iter().position(|r| r.station_name.is_none()) {
        bail!("駅名 (N02_005) を持たない行があります (行 {i})。路線のGeoJSONを渡していませんか");
    }

    let mut columns = shared_columns(&rows);

    let station_name: Vec<String> = rows
        .iter()
        .map(|r| r.station_name.clone().unwrap_or_default())
        .collect();
    let station_code: Vec<Option<String>> = rows.iter().map(|r| r.station_code.clone()).collect();
    let station_group_code: Vec<Option<String>> =
        rows.iter().map(|r| r.station_group_code.clone()).collect();

    columns.push(geoparquet::utf8_column(
        "station_name",
        station_name.into_iter(),
    ));
    columns.push(geoparquet::utf8_nullable_column(
        "station_code",
        station_code.into_iter(),
    ));
    columns.push(geoparquet::utf8_nullable_column(
        "station_group_code",
        station_group_code.into_iter(),
    ));

    let geometries: Vec<LineString<f64>> = rows.into_iter().map(|r| r.geometry).collect();
    write(output, columns, geometries, vintage)
}

fn write(
    output: &Path,
    columns: Vec<(Field, ArrayRef)>,
    geometries: Vec<LineString<f64>>,
    vintage: Option<&str>,
) -> Result<()> {
    let (geometry, bbox, file_bbox) = geoparquet::geometry_columns(&geometries, line_string_bbox)?;

    geoparquet::write(
        output,
        columns,
        "geometry",
        geometry,
        bbox,
        &["LineString".to_string()],
        file_bbox,
        geoparquet::Provenance {
            // 配布元は出所全体で1つ (国土数値情報の鉄道データ)。カタログ側が持つ。
            via: None,
            vintage,
        },
    )
    .with_context(|| format!("書き出しに失敗しました: {}", output.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECTION_SAMPLE: &str = r#"
    {
      "type": "FeatureCollection",
      "name": "N02-25_RailroadSection",
      "crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::6668" } },
      "features": [
        { "type": "Feature", "properties": { "N02_001": "23", "N02_002": "5", "N02_003": "沖縄都市モノレール線", "N02_004": "沖縄都市モノレール" }, "geometry": { "type": "LineString", "coordinates": [ [ 127.67948, 26.21454 ], [ 127.68419, 26.21905 ] ] } },
        { "type": "Feature", "properties": { "N02_001": "11", "N02_002": "1", "N02_003": "東海道新幹線", "N02_004": "東海旅客鉄道" }, "geometry": { "type": "LineString", "coordinates": [ [ 139.0, 35.0 ], [ 139.1, 35.1 ] ] } }
      ]
    }
    "#;

    const STATION_SAMPLE: &str = r#"
    {
      "type": "FeatureCollection",
      "name": "N02-25_Station",
      "crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::6668" } },
      "features": [
        { "type": "Feature", "properties": { "N02_001": "11", "N02_002": "2", "N02_003": "指宿枕崎線", "N02_004": "九州旅客鉄道", "N02_005": "二月田", "N02_005c": "010112", "N02_005g": "010112" }, "geometry": { "type": "LineString", "coordinates": [ [ 130.63035, 31.25405 ], [ 130.62985, 31.25459 ] ] } }
      ]
    }
    "#;

    #[test]
    fn resolves_codes_to_names() {
        let rows = parse_geojson(SECTION_SAMPLE).unwrap();
        assert_eq!(rows.len(), 2);

        assert_eq!(rows[0].railway_class_code, "23");
        assert_eq!(rows[0].railway_class, "跨座式モノレール");
        assert_eq!(rows[0].institution_type, "第三セクター");
        assert_eq!(rows[0].line_name, "沖縄都市モノレール線");

        // 新幹線は「鉄道区分=普通鉄道JR」ד事業者種別=JRの新幹線」で判別する。
        assert_eq!(rows[1].railway_class, "普通鉄道JR");
        assert_eq!(rows[1].institution_type, "JRの新幹線");
    }

    #[test]
    fn keeps_raw_codes_alongside_names() {
        let rows = parse_geojson(SECTION_SAMPLE).unwrap();
        assert_eq!(rows[1].railway_class_code, "11");
        assert_eq!(rows[1].institution_type_code, "1");
    }

    #[test]
    fn sections_have_no_station_fields() {
        let rows = parse_geojson(SECTION_SAMPLE).unwrap();
        assert!(rows.iter().all(|r| r.station_name.is_none()));
    }

    #[test]
    fn parses_station_fields() {
        let rows = parse_geojson(STATION_SAMPLE).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].station_name.as_deref(), Some("二月田"));
        assert_eq!(rows[0].station_code.as_deref(), Some("010112"));
        assert_eq!(rows[0].station_group_code.as_deref(), Some("010112"));
        // 駅も線。点に潰していないことを確かめる。
        assert_eq!(rows[0].geometry.0.len(), 2);
    }

    #[test]
    fn rejects_unknown_railway_class_code() {
        let unknown = SECTION_SAMPLE.replace(r#""N02_001": "23""#, r#""N02_001": "99""#);
        let err = parse_geojson(&unknown).unwrap_err();
        let message = format!("{err:#}");
        assert!(
            message.contains("鉄道区分") && message.contains("99"),
            "未知のコードだと分かるエラーになっていない: {message}"
        );
    }

    #[test]
    fn rejects_unknown_institution_type_code() {
        let unknown = SECTION_SAMPLE.replace(r#""N02_002": "5""#, r#""N02_002": "9""#);
        let err = parse_geojson(&unknown).unwrap_err();
        assert!(format!("{err:#}").contains("事業者種別"));
    }

    #[test]
    fn rejects_polygon_geometry() {
        let polygon = r#"
        {
          "type": "FeatureCollection",
          "crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::6668" } },
          "features": [
            { "type": "Feature", "properties": { "N02_001": "11", "N02_002": "2", "N02_003": "x", "N02_004": "y" }, "geometry": { "type": "Polygon", "coordinates": [ [ [ 139.0, 35.0 ], [ 139.1, 35.0 ], [ 139.1, 35.1 ], [ 139.0, 35.0 ] ] ] } }
          ]
        }
        "#;
        assert!(parse_geojson(polygon).is_err());
    }

    #[test]
    fn rejects_missing_crs() {
        let missing_crs = SECTION_SAMPLE.replace(
            r#""crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::6668" } },"#,
            "",
        );
        assert!(parse_geojson(&missing_crs).is_err());
    }

    #[test]
    fn write_stations_rejects_section_rows() {
        let rows = parse_geojson(SECTION_SAMPLE).unwrap();
        let dir = std::env::temp_dir().join("n02_test_sections_as_stations");
        std::fs::create_dir_all(&dir).unwrap();
        let err = write_stations(rows, &dir.join("out.parquet"), None).unwrap_err();
        assert!(format!("{err:#}").contains("駅名"));
    }

    const META_SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
    <MD_Metadata xmlns="http://zgate.gsi.go.jp/ch/jmp/">
      <identificationInfo>
        <citation>
          <title>国土数値情報（鉄道）　N02-25</title>
          <date><date>2026-03-06</date><dateType>003</dateType></date>
        </citation>
      </identificationInfo>
    </MD_Metadata>"#;

    #[test]
    fn reads_vintage_from_metadata() {
        assert_eq!(
            extract_vintage(META_SAMPLE).unwrap(),
            "N02-25 (2026-03-06)",
            "配布元が名乗っている形をそのまま持ち回る (年度に直さない)"
        );
    }

    /// 版が読めないまま黙って通すと、**いつのデータか分からないものを配る**ことになる。
    #[test]
    fn rejects_metadata_without_title() {
        let without_title = r#"<MD_Metadata xmlns="http://zgate.gsi.go.jp/ch/jmp/"></MD_Metadata>"#;
        let err = extract_vintage(without_title).unwrap_err();
        assert!(format!("{err:#}").contains("title"));
    }

    /// コードリストの写し間違いを見張る。配布元のページと件数が合うこと。
    #[test]
    fn code_lists_match_the_published_ones() {
        assert_eq!(RAILWAY_CLASS.len(), 12, "鉄道区分は11〜17と21〜25の12種");
        assert_eq!(INSTITUTION_TYPE.len(), 5);
        // 鉄道事業法 (11〜17) と軌道法 (21〜25) の境目。
        assert!(RAILWAY_CLASS.iter().all(|(c, _)| {
            let n: u32 = c.parse().unwrap();
            (11..=17).contains(&n) || (21..=25).contains(&n)
        }));
    }
}
