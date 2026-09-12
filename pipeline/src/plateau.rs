//! PLATEAU (3D都市モデル) のCityGMLから建物を読み、GeoParquetに変換する。
//!
//! CityGMLのパースは自前で書かず、PLATEAU公式コンバータの
//! [`nusamai_citygml`] / [`nusamai_plateau`] に任せている。
//! コードリスト (用途コード → 「業務施設」など) の解決も含めて向こうが持っている。
//!
//! 使うのは **LOD0の屋根の外周線 (`bldg:lod0RoofEdge`)** だけ。
//! 全建物にあり、2Dのフットプリントなので地図表示にそのまま使える。
//! 立体 (LOD1以上) は高さの数値で代用できるので読まない。

use crate::geoparquet;
use crate::wgs84_transformer;
use anyhow::{Context, Result, bail};
use geo_types::{LineString, MultiPolygon, Polygon};
use nusamai_citygml::codelist::CodeResolver;
use nusamai_citygml::{CityGmlElement, CityGmlReader, GeometryType, ParseError, SubTreeReader};
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, Read, Seek};
use std::path::Path;

/// コードリストの置き場所を表すだけの、実在しないURL。
///
/// nusamaiはCityGMLの `codeSpace` (`../../codelists/Building_usage.xml` のような
/// 相対パス) を、渡した基準URLからの相対で解決する。`zip/udx/bldg/x.gml` を基準に
/// すると `zip/codelists/Building_usage.xml` になるので、ファイル名で引ける。
const CODELIST_BASE: &str = "https://plateau.invalid/zip/";

/// zipから読み込んだコードリスト。用途コード (454など) を「業務施設」に直す。
///
/// nusamai付属の `Resolver` はローカルのzipパスを前提にしているが、
/// **HTTP Range で読むときは手元にパスが無い**。中身を先にメモリへ載せてしまえば
/// ローカルもリモートも同じ経路になるので、こちらを使う。
pub struct Codelists {
    /// ファイル名 (`Building_usage.xml`) → 生のXML。
    raw: HashMap<String, Vec<u8>>,
    /// 解決済み。`resolve` が `&self` なので内側で持つ。
    /// 293ファイル・10MBあるが、実際に引かれるのは数本なので必要になってから読む。
    parsed: RefCell<HashMap<String, HashMap<String, String>>>,
}

impl Codelists {
    fn file_name(path: &str) -> Option<&str> {
        path.rsplit('/').next().filter(|name| !name.is_empty())
    }

    /// `codelists/*.xml` を集めたものから作る。
    pub fn new(entries: impl IntoIterator<Item = (String, Vec<u8>)>) -> Self {
        let raw = entries
            .into_iter()
            .filter_map(|(path, bytes)| {
                Self::file_name(&path).map(|name| (name.to_string(), bytes))
            })
            .collect();
        Self {
            raw,
            parsed: RefCell::new(HashMap::new()),
        }
    }

    pub fn len(&self) -> usize {
        self.raw.len()
    }

    pub fn is_empty(&self) -> bool {
        self.raw.is_empty()
    }

    /// パースの基準に渡すURL。`name` は `udx/bldg/x.gml` のような内部パス。
    pub fn source_uri(name: &str) -> Result<url::Url> {
        url::Url::parse(CODELIST_BASE)
            .and_then(|base| base.join(name))
            .with_context(|| format!("URLを組み立てられません: {name}"))
    }
}

impl CodeResolver for Codelists {
    fn resolve(
        &self,
        base_url: &url::Url,
        code_space: &str,
        code: &str,
    ) -> Result<Option<String>, ParseError> {
        let absolute = base_url.join(code_space).map_err(|e| {
            ParseError::CodelistError(format!("codeSpaceを解決できません {code_space}: {e}"))
        })?;
        let Some(name) = Self::file_name(absolute.path()) else {
            return Ok(None);
        };
        if let Some(dict) = self.parsed.borrow().get(name) {
            return Ok(dict.get(code).cloned());
        }
        let Some(bytes) = self.raw.get(name) else {
            // 参照されているコードリストがzipに無いことはある。値をそのまま通す。
            return Ok(None);
        };
        let dictionary = nusamai_plateau::codelist::xml::parse_dictionary(std::io::Cursor::new(
            bytes.as_slice(),
        ))?;
        let simple: HashMap<String, String> = dictionary
            .into_iter()
            .map(|(key, definition)| (key, definition.value().to_string()))
            .collect();
        let found = simple.get(code).cloned();
        self.parsed.borrow_mut().insert(name.to_string(), simple);
        Ok(found)
    }
}

/// PLATEAUが「不明」を表すのに使う番兵値。
///
/// 数値の属性に紛れ込むので、そのまま通すと絞り込みが壊れる。実測 (港区周辺):
///
/// - `bldg:storeysAboveGround` = 9999 が14.8% → 「9999階建て」になる
/// - `bldg:measuredHeight` = -9999 が4.4% → 高さの最小値が-9999mになり、
///   row groupの統計も汚れる
///
/// どちらもNULLにする。用途や分類のコードでも9999が使われるが、そちらは
/// コードリストが「不明」という文字列に解決してくれるのでそのまま入れてよい。
const UNKNOWN_SENTINEL: u64 = 9999;

/// 高さの「不明」。負の値はありえないので、符号で弾いてもよいが、
/// 実際に入っている値と対応が取れるように定数で持つ。
const UNKNOWN_HEIGHT: f64 = -9999.0;

/// 建物1棟。
#[derive(Debug)]
pub struct Row {
    /// `uro:buildingID`。自治体コードを含む識別子。
    pub building_id: Option<String>,
    /// `gml:name`。ほとんど入っていない (実測0.6%)。
    pub name: Option<String>,
    /// `bldg:usage` をコードリストで解決したもの。「業務施設」「共同住宅」など。
    pub usage: Option<String>,
    /// `bldg:class` をコードリストで解決したもの。
    pub class: Option<String>,
    /// `bldg:measuredHeight` (m)。
    pub height: Option<f64>,
    /// `bldg:storeysAboveGround`。9999 (不明) はNULLにしてある。
    pub storeys: Option<i32>,
    /// `uro:city` をコードリストで解決したもの。「港区」など。
    /// メッシュ単位で切られているため、1つのzipに周辺自治体が混ざる。
    pub city: Option<String>,
    /// LOD0の屋根の外周線。WGS84 (EPSG:4326) に変換済み。
    pub geometry: MultiPolygon<f64>,
}

/// MultiPolygonの外接矩形 `[xmin, ymin, xmax, ymax]`。
pub fn multi_polygon_bbox(mp: &MultiPolygon<f64>) -> [f64; 4] {
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

/// zip内の建物CityGMLをすべて読み、変換前 (元の座標系) の行を返す。
///
/// zipは展開しない。`udx/bldg/*.gml` だけを1本ずつ取り出して読む。
/// テクスチャ (`*_appearance/`) は読まないので、対象は展開後2.0GB程度で済む。
pub fn parse_zip(zip_path: &Path) -> Result<Vec<Row>> {
    let file =
        File::open(zip_path).with_context(|| format!("開けません: {}", zip_path.display()))?;
    parse_archive(file, &zip_path.display().to_string())
}

/// [`parse_zip`] の、ローカルのファイルに限らない版。
///
/// `Read + Seek` があればよいので、HTTP Range で範囲を取るものを渡せば
/// **zipを落とさずに**変換できる (`crate::remote_zip`)。PLATEAUのCityGMLは
/// 全国で1,385GBあり、落としてから読む道が無い。
///
/// **アーカイブは一度しか開かない。** リモートでは中央ディレクトリの読み直しが
/// そのまま往復になるため。
pub fn parse_archive(source: impl Read + Seek, label: &str) -> Result<Vec<Row>> {
    let mut archive =
        zip::ZipArchive::new(source).with_context(|| format!("zipとして読めません: {label}"))?;

    // 名前を先に集める。読み出し中は archive を可変で借りるため、
    // 反復しながら by_name を呼べない。
    //
    // **`file_names()` を使うこと。** `by_index_raw` は1件ごとにローカルヘッダを
    // 読みに行くので、5万を超えるエントリを舐めるとファイル全体を引きずる
    // (港区で実測: 1,013MB / 3,097リクエスト。必要なのは建物199MBだけ)。
    // `file_names` は読み込み済みの中央ディレクトリから返すので通信しない。
    let mut codelist_names = Vec::new();
    let mut building_names = Vec::new();
    for name in archive.file_names() {
        if name.starts_with("codelists/") && name.ends_with(".xml") {
            codelist_names.push(name.to_string());
        } else if name.starts_with("udx/bldg/") && name.ends_with(".gml") {
            building_names.push(name.to_string());
        }
    }
    building_names.sort();
    if building_names.is_empty() {
        bail!("建物のGMLが1本もありません: {label}");
    }

    let mut codelists = Vec::with_capacity(codelist_names.len());
    for name in &codelist_names {
        codelists.push((name.clone(), read_entry(&mut archive, name)?));
    }
    // 用途コードを日本語に直すのに要る。無いとコードのまま入って読めなくなる。
    let resolver = Codelists::new(codelists);
    if resolver.is_empty() {
        bail!("コードリストがありません (用途が解決できない): {label}");
    }

    let mut rows = Vec::new();
    for name in &building_names {
        let bytes = read_entry(&mut archive, name)?;
        let context = nusamai_citygml::ParseContext::new(Codelists::source_uri(name)?, &resolver);

        let mut xml_reader = quick_xml::NsReader::from_reader(std::io::Cursor::new(bytes));
        let mut citygml_reader = CityGmlReader::new(context);
        let mut st = citygml_reader
            .start_root(&mut xml_reader)
            .map_err(|e| anyhow::anyhow!("{e:?}"))
            .with_context(|| format!("ルート要素を読めません: {name}"))?;
        collect_buildings(&mut st, &mut rows)
            .map_err(|e| anyhow::anyhow!("{e:?}"))
            .with_context(|| format!("建物を読めません: {name}"))?;
    }

    if rows.is_empty() {
        bail!("建物が1件も読めませんでした: {label}");
    }
    Ok(rows)
}

fn read_entry<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, name: &str) -> Result<Vec<u8>> {
    let mut entry = archive
        .by_name(name)
        .with_context(|| format!("エントリを開けません: {name}"))?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    std::io::copy(&mut entry, &mut buf).with_context(|| format!("エントリを読めません: {name}"))?;
    Ok(buf)
}

/// `core:cityObjectMember` を辿って建物だけを拾う。
fn collect_buildings<R: BufRead>(
    st: &mut SubTreeReader<R>,
    rows: &mut Vec<Row>,
) -> Result<(), ParseError> {
    st.parse_children(|st| match st.current_path() {
        b"core:cityObjectMember" => {
            let mut obj: nusamai_plateau::models::TopLevelCityObject = Default::default();
            obj.parse(st)?;
            // ジオメトリは頂点バッファを共有する形でまとめて返る。
            let geometries = st.collect_geometries(None);

            if let nusamai_plateau::models::TopLevelCityObject::Building(building) = obj
                && let Some(row) = build_row(&building, &geometries)
            {
                rows.push(row);
            }
            Ok(())
        }
        // 範囲とテクスチャは使わないので読み飛ばす。
        // appearanceMemberはファイル容量の大半を占めるため、ここを飛ばす効果が大きい。
        b"gml:boundedBy" | b"app:appearanceMember" => {
            st.skip_current_element()?;
            Ok(())
        }
        other => Err(ParseError::SchemaViolation(format!(
            "想定外の要素: {}",
            String::from_utf8_lossy(other)
        ))),
    })
}

/// 建物1棟を行に変換する。LOD0の外周線が無いものは捨てる (Noneを返す)。
fn build_row(
    building: &nusamai_plateau::models::Building,
    geometries: &nusamai_citygml::GeometryStore,
) -> Option<Row> {
    // LOD0のSurfaceが屋根の外周線。
    let reference = building
        .geometries
        .iter()
        .find(|g| g.lod == 0 && g.ty == GeometryType::Surface)?;

    // CityGMLの座標は「緯度 経度 標高」の順。GeoParquetは経度・緯度なので入れ替える。
    // Z(標高)はlod0RoofEdgeでは常に0なので捨てる。
    let ring = |indices: &mut dyn Iterator<Item = u32>| -> LineString<f64> {
        indices
            .map(|i| {
                let [lat, lon, _z] = geometries.vertices[i as usize];
                (lon, lat)
            })
            .collect()
    };

    let polygons: Vec<Polygon<f64>> = geometries
        .multipolygon
        .iter_range(reference.pos as usize..(reference.pos + reference.len) as usize)
        .map(|poly| {
            let exterior = ring(&mut poly.exterior().iter_closed());
            let interiors = poly
                .interiors()
                .map(|hole| ring(&mut hole.iter_closed()))
                .collect();
            Polygon::new(exterior, interiors)
        })
        .collect();

    if polygons.is_empty() {
        return None;
    }

    let id_attribute = building.building_id_attribute.first();
    Some(Row {
        building_id: id_attribute.and_then(|a| a.building_id.clone()),
        name: building.name.first().map(|n| n.value().to_string()),
        usage: building.usage.first().map(|c| c.value().to_string()),
        class: building.class.as_ref().map(|c| c.value().to_string()),
        height: building
            .measured_height
            .as_ref()
            .map(|h| h.value())
            .filter(|h| *h != UNKNOWN_HEIGHT),
        storeys: building
            .storeys_above_ground
            .filter(|s| *s != UNKNOWN_SENTINEL)
            .and_then(|s| i32::try_from(s).ok()),
        city: id_attribute
            .and_then(|a| a.city.as_ref())
            .map(|c| c.value().to_string()),
        geometry: MultiPolygon(polygons),
    })
}

/// 元の座標系 (JGD2011) からWGS84へ変換する。
///
/// PLATEAUのCityGMLは EPSG:6697 (JGD2011 + 標高) だが、Zを捨てているので
/// 水平部分の EPSG:6668 として扱えばよい。`n03` と同じ経路を通る。
pub fn to_wgs84(rows: &mut [Row]) -> Result<()> {
    const SOURCE_EPSG: u32 = 6668;

    let [west, south, east, north] = rows.iter().fold(
        [f64::MAX, f64::MAX, f64::MIN, f64::MIN],
        |[west, south, east, north], row| {
            let [w, s, e, n] = multi_polygon_bbox(&row.geometry);
            [west.min(w), south.min(s), east.max(e), north.max(n)]
        },
    );
    let proj = wgs84_transformer(SOURCE_EPSG, (west, south, east, north))?;

    for row in rows.iter_mut() {
        let polygons = std::mem::take(&mut row.geometry.0).into_iter().try_fold(
            Vec::new(),
            |mut acc, polygon| {
                let (exterior, interiors) = polygon.into_inner();
                let exterior = transform_ring(exterior, &proj)?;
                let interiors = interiors
                    .into_iter()
                    .map(|ring| transform_ring(ring, &proj))
                    .collect::<Result<Vec<_>>>()?;
                acc.push(Polygon::new(exterior, interiors));
                Ok::<_, anyhow::Error>(acc)
            },
        )?;
        row.geometry = MultiPolygon(polygons);
    }
    Ok(())
}

fn transform_ring(ring: LineString<f64>, proj: &proj::Proj) -> Result<LineString<f64>> {
    let mut points: Vec<(f64, f64)> = ring.into_iter().map(|c| (c.x, c.y)).collect();
    proj.convert_array(&mut points)
        .context("WGS84への変換に失敗しました")?;
    Ok(LineString::from(points))
}

/// 変換した行をGeoParquetとして書き出す。
pub fn write_geoparquet(rows: Vec<Row>, output: &Path) -> Result<()> {
    let mut building_id = Vec::with_capacity(rows.len());
    let mut name = Vec::with_capacity(rows.len());
    let mut usage = Vec::with_capacity(rows.len());
    let mut class = Vec::with_capacity(rows.len());
    let mut height = Vec::with_capacity(rows.len());
    let mut storeys = Vec::with_capacity(rows.len());
    let mut city = Vec::with_capacity(rows.len());
    let mut geometries = Vec::with_capacity(rows.len());
    for row in rows {
        building_id.push(row.building_id);
        name.push(row.name);
        usage.push(row.usage);
        class.push(row.class);
        height.push(row.height);
        storeys.push(row.storeys);
        city.push(row.city);
        geometries.push(row.geometry);
    }

    let (geometry, bbox, file_bbox) =
        geoparquet::geometry_columns(&geometries, multi_polygon_bbox)?;

    let columns = vec![
        geoparquet::utf8_nullable_column("building_id", building_id.into_iter()),
        geoparquet::utf8_nullable_column("name", name.into_iter()),
        geoparquet::utf8_nullable_column("usage", usage.into_iter()),
        geoparquet::utf8_nullable_column("class", class.into_iter()),
        geoparquet::utf8_nullable_column("city", city.into_iter()),
        geoparquet::f64_nullable_column("height", height.into_iter()),
        geoparquet::i32_nullable_column("storeys", storeys.into_iter()),
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

    #[test]
    fn bbox_covers_all_rings() {
        let mp = MultiPolygon(vec![Polygon::new(
            LineString::from(vec![
                (139.0, 35.0),
                (139.1, 35.0),
                (139.1, 35.2),
                (139.0, 35.0),
            ]),
            vec![],
        )]);
        assert_eq!(multi_polygon_bbox(&mp), [139.0, 35.0, 139.1, 35.2]);
    }

    // 「不明」の番兵値。数値として通すと絞り込みが壊れるうえ、
    // row groupの統計 (min/max) まで汚れて枝刈りの判断材料にならなくなる。
    // 実データで height=-9999 が4.4%、storeys=9999 が14.8%あった。
    #[test]
    fn unknown_sentinels_are_dropped() {
        let keep_storeys = |s: u64| Some(s).filter(|s| *s != UNKNOWN_SENTINEL);
        assert_eq!(keep_storeys(3), Some(3));
        assert_eq!(keep_storeys(UNKNOWN_SENTINEL), None);

        let keep_height = |h: f64| Some(h).filter(|h| *h != UNKNOWN_HEIGHT);
        assert_eq!(keep_height(9.8), Some(9.8));
        assert_eq!(keep_height(UNKNOWN_HEIGHT), None);
    }
}
