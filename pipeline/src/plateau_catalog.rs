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
}

impl City {
    /// 建物を収録しているか。
    pub fn has_buildings(&self) -> bool {
        self.feature_types.iter().any(|t| t == "bldg")
    }
}

#[derive(Debug, Deserialize)]
struct Catalog {
    #[serde(default)]
    latest_citygml: Vec<City>,
}

/// カタログのJSONから都市の一覧を取り出す。
///
/// 取得とパースを分けてあるのは、固定のJSONで試せるようにするため。
pub fn parse_catalog(json: &str) -> Result<Vec<City>> {
    let catalog: Catalog = serde_json::from_str(json).context("カタログを読めません")?;
    if catalog.latest_citygml.is_empty() {
        bail!("カタログに latest_citygml がありません (APIの形が変わった可能性)");
    }
    Ok(catalog.latest_citygml)
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
