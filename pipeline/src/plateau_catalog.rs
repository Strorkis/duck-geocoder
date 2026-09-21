//! PLATEAUの配信カタログ。都市コードからCityGMLのzipのURLを引く。
//!
//! **公式APIを使う。** 配布ページのURLを組み立てて取りに行くのではない
//! (AGENTS.mdの約束を参照)。
//!
//! カタログの `latest_citygml` は都市ごとに次を持つ。
//!
//! ```json
//! { "city_code": "13103", "city": "港区", "pref": "東京都",
//!   "url": "https://api.plateauview.mlit.go.jp/datacatalog/citygml/13103-latest/citygml.zip",
//!   "file_size": 2718857700,
//!   "feature_types": ["bldg", "dem", "fld", ...] }
//! ```
//!
//! この `url` は302で実体 (`assets.cms.plateau.reearth.io/...`) へ飛ぶ。
//! **HEADには404を返す**ので、長さはGETのRangeから取る (`remote_zip::HttpRange`)。
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// カタログAPI。都市の一覧とzipのURLが入っている (約9MB)。
pub const CATALOG_URL: &str = "https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets";

/// 1都市分。カタログの `latest_citygml` の要素。
#[derive(Debug, Clone, Deserialize)]
pub struct City {
    /// 全国地方公共団体コードの上5桁 (例: 13103 = 港区)。
    pub city_code: String,
    pub city: String,
    pub pref: String,
    /// CityGMLのzip。302で実体へ飛ぶ。
    pub url: String,
    /// zip全体の大きさ。**建物だけならこの一部しか読まない。**
    pub file_size: u64,
    /// 収録している地物の種別 (`bldg` / `dem` / `fld` など)。
    #[serde(default)]
    pub feature_types: Vec<String>,
    /// 地物の種別 → 原典にあるLODの一覧 (昇順・重複なし)。
    ///
    /// `latest_datasets` から組み立てるので、JSONから直接は読まない。
    #[serde(skip)]
    lods: BTreeMap<String, Vec<u8>>,
}

impl City {
    /// 建物を収録しているか。
    pub fn has_buildings(&self) -> bool {
        self.feature_types.iter().any(|t| t == "bldg")
    }

    /// この地物が**原典でLOD幾つまであるか**。昇順・重複なし。
    ///
    /// このパイプラインが読むのはCityGMLのLOD0 (屋根の外周線) だけなので、
    /// 原典にそれ以上が入っていることを配信物に書き残すために使う。
    ///
    /// **政令指定都市は区ごとにデータがあり、区によって最大LODが違う**
    /// (横浜市はLOD1〜4)。CityGMLのzipは市単位でしか落とせないので、
    /// ここが返すのは**市としての集合**で、区の差は表現できない。
    pub fn lods(&self, feature_type: &str) -> &[u8] {
        self.lods.get(feature_type).map_or(&[], Vec::as_slice)
    }
}

/// `latest_datasets` の要素。
///
/// CityGMLのzipとは別に、3D Tiles / MVT に変換したものが**LODごとに**並んでいる
/// (港区の建築物なら `13103_bldg_lod1` `13103_bldg_lod2` など5件)。
/// 欲しいのは「どのLODがあるか」だけなので、3項目しか読まない。
#[derive(Debug, Deserialize)]
struct Dataset {
    city_code: String,
    /// 地物の種別 (`bldg` / `tran` など)。
    type_en: String,
    /// `"1"` 〜 `"4"`。**数値ではなく文字列**で入っている。
    /// 3D Tiles 以外では省かれることがあるので `Option`。
    lod: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Catalog {
    #[serde(default)]
    latest_citygml: Vec<City>,
    #[serde(default)]
    latest_datasets: Vec<Dataset>,
}

/// カタログのJSONから都市の一覧を取り出す。
///
/// 取得とパースを分けてあるのは、固定のJSONで試せるようにするため。
///
/// `latest_datasets` からLODの一覧を組み立てて各都市に付ける。
/// **同じJSONを1回読むだけ**なので、取得の回数は増えない。
pub fn parse_catalog(json: &str) -> Result<Vec<City>> {
    let catalog: Catalog = serde_json::from_str(json).context("カタログを読めません")?;
    if catalog.latest_citygml.is_empty() {
        bail!("カタログに latest_citygml がありません (APIの形が変わった可能性)");
    }

    // 都市コード → 地物 → LOD。同じLODが複数件あるので (テクスチャ有無で分かれる)
    // BTreeSet で重複を落とす。
    let mut by_city: HashMap<&str, BTreeMap<String, BTreeSet<u8>>> = HashMap::new();
    for dataset in &catalog.latest_datasets {
        // LOD が読めないものは飛ばす。**落とさない** — 3D Tiles 以外では
        // 省かれる項目で、CityGMLの変換とは関係が無い。
        let Some(lod) = dataset.lod.as_deref().and_then(|l| l.parse::<u8>().ok()) else {
            continue;
        };
        by_city
            .entry(dataset.city_code.as_str())
            .or_default()
            .entry(dataset.type_en.clone())
            .or_default()
            .insert(lod);
    }

    let mut cities = catalog.latest_citygml;
    for city in &mut cities {
        if let Some(types) = by_city.get(city.city_code.as_str()) {
            city.lods = types
                .iter()
                .map(|(ty, lods)| (ty.clone(), lods.iter().copied().collect()))
                .collect();
        }
    }
    Ok(cities)
}

/// LODの一覧を配信物に書ける形にする。無ければ `None`。
///
/// `"1,2,3"` の形。読む側 (UI) が最大値を取れるよう、**昇順のまま**並べる。
pub fn format_lods(lods: &[u8]) -> Option<String> {
    if lods.is_empty() {
        return None;
    }
    Some(lods.iter().map(u8::to_string).collect::<Vec<_>>().join(","))
}

/// 都市コードで引く。
pub fn find_city<'a>(cities: &'a [City], city_code: &str) -> Result<&'a City> {
    cities
        .iter()
        .find(|c| c.city_code == city_code)
        .with_context(|| {
            format!("都市コード {city_code} がカタログにありません (5桁の全国地方公共団体コード)")
        })
}

/// カタログを取得する。
pub fn fetch_catalog() -> Result<Vec<City>> {
    let json = ureq::get(CATALOG_URL)
        .call()
        .with_context(|| format!("カタログを取得できません: {CATALOG_URL}"))?
        .body_mut()
        .read_to_string()
        .context("カタログの本文を読めません")?;
    parse_catalog(&json)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "datasets": [],
      "latest_datasets": [
        { "id": "13103_bldg_lod1", "city_code": "13103", "type_en": "bldg", "lod": "1" },
        { "id": "13103_bldg_lod2", "city_code": "13103", "type_en": "bldg", "lod": "2" },
        { "id": "13103_bldg_lod2_no_texture", "city_code": "13103", "type_en": "bldg", "lod": "2" },
        { "id": "13103_bldg_lod3", "city_code": "13103", "type_en": "bldg", "lod": "3" },
        { "id": "13103_tran_lod1", "city_code": "13103", "type_en": "tran", "lod": "1" },
        { "id": "13103_luse", "city_code": "13103", "type_en": "luse", "lod": null },
        { "id": "01100_fld", "city_code": "01100", "type_en": "fld", "lod": "1" }
      ],
      "latest_citygml": [
        { "city_code": "13103", "city": "港区", "pref": "東京都",
          "url": "https://api.plateauview.mlit.go.jp/datacatalog/citygml/13103-latest/citygml.zip",
          "file_size": 2147483648, "feature_types": ["bldg", "dem"] },
        { "city_code": "01100", "city": "札幌市", "pref": "北海道",
          "url": "https://api.plateauview.mlit.go.jp/datacatalog/citygml/01100-latest/citygml.zip",
          "file_size": 2718857700, "feature_types": ["fld"] }
      ]
    }"#;

    #[test]
    fn reads_cities_from_the_catalog() {
        let cities = parse_catalog(SAMPLE).unwrap();
        assert_eq!(cities.len(), 2);
        let minato = find_city(&cities, "13103").unwrap();
        assert_eq!(minato.city, "港区");
        assert_eq!(minato.file_size, 2147483648);
    }

    // 建物を持たない都市を指定したときに、取りに行く前に気付けるようにする。
    #[test]
    fn knows_which_cities_have_buildings() {
        let cities = parse_catalog(SAMPLE).unwrap();
        assert!(find_city(&cities, "13103").unwrap().has_buildings());
        assert!(!find_city(&cities, "01100").unwrap().has_buildings());
    }

    /// **原典がLOD幾つまであるか**を配信物に書き残すために読む。
    /// このパイプラインが読むのはLOD0だけなので、差があることを示す手掛かりになる。
    #[test]
    fn reads_the_lods_available_at_the_source() {
        let cities = parse_catalog(SAMPLE).unwrap();
        let minato = find_city(&cities, "13103").unwrap();

        // 同じLODがテクスチャ有無で2件あるので、重複は落とす。
        assert_eq!(minato.lods("bldg"), [1, 2, 3]);
        assert_eq!(minato.lods("tran"), [1]);
    }

    // LODを持たない地物 (3D Tiles以外) で落ちないこと。CityGMLの変換とは関係が無い。
    #[test]
    fn skips_datasets_without_a_lod() {
        let cities = parse_catalog(SAMPLE).unwrap();
        assert!(find_city(&cities, "13103").unwrap().lods("luse").is_empty());
    }

    // データセットが1件も無い地物・都市で空を返すこと。
    #[test]
    fn returns_nothing_when_the_source_has_no_datasets() {
        let cities = parse_catalog(SAMPLE).unwrap();
        assert!(find_city(&cities, "13103").unwrap().lods("rwy").is_empty());
        assert!(find_city(&cities, "01100").unwrap().lods("bldg").is_empty());
    }

    #[test]
    fn formats_lods_for_the_delivered_file() {
        assert_eq!(format_lods(&[1, 2, 3]).as_deref(), Some("1,2,3"));
        // 無いときは項目ごと出さない。
        assert_eq!(format_lods(&[]), None);
    }

    #[test]
    fn rejects_an_unknown_city_code() {
        let cities = parse_catalog(SAMPLE).unwrap();
        let err = find_city(&cities, "99999").unwrap_err();
        assert!(err.to_string().contains("99999"));
    }

    // APIの形が変わったときに、空の結果で静かに進まないこと。
    #[test]
    fn rejects_a_catalog_without_latest_citygml() {
        let err = parse_catalog(r#"{"datasets": []}"#).unwrap_err();
        assert!(err.to_string().contains("latest_citygml"));
    }
}
