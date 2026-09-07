use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::fs::File;
use std::path::Path;

/// データセット1件分のカタログエントリ。
/// 件数・bbox・列構成は実際のGeoParquetのメタデータから読むので、中身とずれない。
#[derive(Debug, Serialize)]
pub struct DatasetEntry {
    /// ファイル名から決まる識別子。例: "n03_all"
    pub id: String,
    /// 配信時のファイル名。UIはこれを読みに行く。
    pub file: String,
    /// UIやツールが扱いを切り替えるための種別。
    /// 表示用の `title` と違い、こちらは機械が分岐に使う。
    pub kind: DatasetKind,
    /// 人間向けの名称。
    pub title: String,
    /// 出典表示。地図上にそのまま出す。
    pub source: String,
    /// 出典元のURL。国土交通省の記載例が出典にURLを求めているため、
    /// `source` と対で持ち、UIはリンクとして出す。
    pub source_url: String,
    /// ジオメトリの種類 (Point / MultiPolygon など)。UIの表示方法がこれで決まる。
    pub geometry_types: Vec<String>,
    /// 収録範囲 [xmin, ymin, xmax, ymax] (WGS84)。
    pub bbox: Option<[f64; 4]>,
    pub row_count: i64,
    pub columns: Vec<ColumnEntry>,
}

/// データセットの種別。ジオメトリの型と用途が種別ごとに決まる。
#[derive(Debug, Serialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum DatasetKind {
    /// 行政区域 (面)。ハイライトや逆ジオコーディングに使う。
    Admin,
    /// 行政区域の名称だけを抜き出したもの。ジオメトリを持たない。
    /// 地名検索の候補をこれで引く (`crate::admin_names` を参照)。
    AdminNames,
    /// 大字・町丁目 (点)。住所検索に使う。
    Oaza,
    /// 街区 (点)。より細かい住所検索に使う。
    Block,
    /// 建物 (面)。名称・用途・高さなどを持つ。
    Buildings,
    /// PLATEAUの建物 (面)。高さ・用途・階数がほぼ全件に入っており、絞り込みに使える。
    ///
    /// [`DatasetKind::Buildings`] と分けているのは列構成が違うため。
    /// 同じ種別にすると `read_parquet([...])` で1つのビューに束ねられてしまい、
    /// スキーマが合わずに壊れる。
    PlateauBuildings,
}

#[derive(Debug, Serialize)]
pub struct ColumnEntry {
    pub name: String,
    /// Parquet上の物理型。
    pub data_type: String,
}

#[derive(Debug, Serialize)]
pub struct Catalog {
    pub datasets: Vec<DatasetEntry>,
}

/// 出典表示。表示する文言と、その出典元のURL。
///
/// 2つを別々の定数で持つと組み合わせを間違えても気付けないので、対にして扱う。
struct Attribution {
    text: &'static str,
    url: &'static str,
}

/// 国土交通省のコンテンツ。
///
/// 利用約款の記載例は「コンテンツ名」「（国土交通省）」「当該ページのURL」に加え、
/// 加工した場合は加工した旨を求めている。このパイプラインは座標系を変換し、
/// 行を空間的に並べ替えているので、いずれも「もとに作成」にあたる。
/// <https://nlftp.mlit.go.jp/ksj/other/agreement.html>
const MLIT_ISJ: Attribution = Attribution {
    text: "「位置参照情報ダウンロードサービス」（国土交通省）をもとに作成",
    url: "https://nlftp.mlit.go.jp/isj/",
};
const MLIT_KSJ: Attribution = Attribution {
    text: "「国土数値情報（行政区域データ）」（国土交通省）をもとに作成",
    url: "https://nlftp.mlit.go.jp/ksj/",
};

/// Overture Maps は ODbL 1.0。OpenStreetMap由来を含むため両方を示す。
/// <https://docs.overturemaps.org/attribution/>
const OVERTURE: Attribution = Attribution {
    text: "Overture Maps / © OpenStreetMap contributors (ODbL 1.0)",
    url: "https://docs.overturemaps.org/attribution/",
};

/// PLATEAU (3D都市モデル) は政府標準利用規約に準じたPDL1.0。
/// 加工した場合はその旨を示すことを求めているので、他の国土交通省コンテンツと
/// 同じく「をもとに作成」の形にする。
/// <https://www.mlit.go.jp/plateau/site-policy/>
const MLIT_PLATEAU: Attribution = Attribution {
    text: "「3D都市モデル（Project PLATEAU）」（国土交通省）をもとに作成",
    url: "https://www.mlit.go.jp/plateau/",
};

/// データセットの素性。ファイル名の接頭辞から引く。
struct Description {
    kind: DatasetKind,
    /// 人間向けの名称。
    title: &'static str,
    attribution: Attribution,
}

/// ファイル名の接頭辞と、そのデータセットの素性。
/// 変換バイナリの出力名 (n03_*.parquet など) と対応している。
/// **前方一致で引くので、長い接頭辞を先に置くこと**
/// (`overture_admin_names` が `overture_admin` に吸われないように)。
const DESCRIPTIONS: &[(&str, Description)] = &[
    (
        "n03_names",
        Description {
            kind: DatasetKind::AdminNames,
            title: "行政区域の名称",
            attribution: MLIT_KSJ,
        },
    ),
    (
        "n03",
        Description {
            kind: DatasetKind::Admin,
            title: "行政区域",
            attribution: MLIT_KSJ,
        },
    ),
    (
        "overture_admin_names",
        Description {
            kind: DatasetKind::AdminNames,
            title: "行政区域の名称",
            attribution: OVERTURE,
        },
    ),
    (
        "overture_admin",
        Description {
            kind: DatasetKind::Admin,
            title: "行政区域",
            attribution: OVERTURE,
        },
    ),
    (
        "overture_buildings",
        Description {
            kind: DatasetKind::Buildings,
            title: "建物",
            attribution: OVERTURE,
        },
    ),
    (
        "plateau_bldg",
        Description {
            kind: DatasetKind::PlateauBuildings,
            title: "建物 (PLATEAU)",
            attribution: MLIT_PLATEAU,
        },
    ),
    (
        "isj_oaza",
        Description {
            kind: DatasetKind::Oaza,
            title: "大字・町丁目",
            attribution: MLIT_ISJ,
        },
    ),
    (
        "isj_block",
        Description {
            kind: DatasetKind::Block,
            title: "街区",
            attribution: MLIT_ISJ,
        },
    ),
];

fn describe(file_stem: &str) -> Option<&'static Description> {
    DESCRIPTIONS
        .iter()
        .find(|(prefix, _)| file_stem.starts_with(prefix))
        .map(|(_, description)| description)
}

/// GeoParquetの `geo` メタデータ (GeoParquet仕様のJSON) から
/// ジオメトリ種別と収録範囲を取り出す。
fn read_geo_metadata(geo_json: &str) -> Result<(Vec<String>, Option<[f64; 4]>)> {
    let geo: serde_json::Value =
        serde_json::from_str(geo_json).context("`geo` メタデータがJSONとして読めない")?;

    let primary = geo
        .get("primary_column")
        .and_then(|v| v.as_str())
        .context("primary_column がない")?;
    let column = geo
        .get("columns")
        .and_then(|c| c.get(primary))
        .context("primary_column に対応する定義がない")?;

    let geometry_types = column
        .get("geometry_types")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let bbox = column
        .get("bbox")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            let values: Vec<f64> = arr.iter().filter_map(|v| v.as_f64()).collect();
            <[f64; 4]>::try_from(values.as_slice()).ok()
        });

    Ok((geometry_types, bbox))
}

/// GeoParquet 1件を読んでカタログエントリを組み立てる。
pub fn describe_parquet(path: &Path) -> Result<DatasetEntry> {
    let file_stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .context("ファイル名が取得できない")?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .context("ファイル名が取得できない")?;

    let described =
        describe(file_stem).with_context(|| format!("未知のデータセットです: {file_name}"))?;

    let file = File::open(path).with_context(|| format!("開けません: {}", path.display()))?;
    let reader = parquet::file::reader::SerializedFileReader::new(file)
        .with_context(|| format!("Parquetとして読めません: {}", path.display()))?;

    use parquet::file::reader::FileReader;
    let metadata = reader.metadata();
    let file_metadata = metadata.file_metadata();

    let geo_json = file_metadata
        .key_value_metadata()
        .and_then(|kv| kv.iter().find(|entry| entry.key == "geo"))
        .and_then(|entry| entry.value.as_deref());
    // 検索用の名称のようにジオメトリを持たないデータセットもあるので、
    // `geo` の有無は種別で判断する。空間データに `geo` が無ければ、
    // 収録範囲も読めず配信用の最適化もかけられないのでエラーにする。
    let (geometry_types, bbox) = match (geo_json, described.kind) {
        (Some(geo_json), _) => read_geo_metadata(geo_json)?,
        (None, DatasetKind::AdminNames) => (Vec::new(), None),
        (None, _) => bail!("GeoParquetの `geo` メタデータがありません: {file_name}"),
    };

    let columns = file_metadata
        .schema_descr()
        .columns()
        .iter()
        .map(|col| ColumnEntry {
            name: col.path().string(),
            data_type: col.physical_type().to_string(),
        })
        .collect();

    Ok(DatasetEntry {
        id: file_stem.to_string(),
        file: file_name.to_string(),
        kind: described.kind,
        title: described.title.to_string(),
        source: described.attribution.text.to_string(),
        source_url: described.attribution.url.to_string(),
        geometry_types,
        bbox,
        row_count: file_metadata.num_rows(),
        columns,
    })
}

/// ディレクトリ内の *.parquet を走査してカタログを組み立てる。
pub fn build_catalog(dir: &Path) -> Result<Catalog> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .with_context(|| format!("読めません: {}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "parquet"))
        .collect();
    paths.sort();

    if paths.is_empty() {
        bail!("{} にGeoParquetがありません", dir.display());
    }

    let datasets = paths
        .iter()
        .map(|path| describe_parquet(path))
        .collect::<Result<Vec<_>>>()?;
    Ok(Catalog { datasets })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_geo_metadata() {
        let geo = r#"{
            "version": "1.1.0",
            "primary_column": "geometry",
            "columns": {
                "geometry": {
                    "encoding": "WKB",
                    "geometry_types": ["MultiPolygon"],
                    "bbox": [138.9, 35.1, 139.8, 35.6]
                }
            }
        }"#;
        let (types, bbox) = read_geo_metadata(geo).unwrap();
        assert_eq!(types, vec!["MultiPolygon"]);
        assert_eq!(bbox, Some([138.9, 35.1, 139.8, 35.6]));
    }

    #[test]
    fn rejects_metadata_without_primary_column() {
        assert!(read_geo_metadata(r#"{"version":"1.1.0"}"#).is_err());
    }

    #[test]
    fn maps_file_names_to_datasets() {
        // 行政区域は出所が2つある (承認が下りるまではOverture、将来はN03も)。
        assert_eq!(describe("n03_all").unwrap().kind, DatasetKind::Admin);
        assert_eq!(
            describe("overture_admin_jp").unwrap().kind,
            DatasetKind::Admin
        );
        assert_eq!(describe("isj_oaza_13").unwrap().kind, DatasetKind::Oaza);
        assert_eq!(describe("isj_block_14").unwrap().kind, DatasetKind::Block);
        assert_eq!(
            describe("overture_buildings_minato").unwrap().kind,
            DatasetKind::Buildings
        );
        assert!(describe("unknown_data").is_none());
    }

    // 前方一致で引くので、より長い接頭辞が短いものに隠れないこと。
    // (`overture_admin` が `overture_buildings` より後ろにあっても両方引ける)
    #[test]
    fn longer_prefixes_are_not_shadowed() {
        for (prefix, _) in DESCRIPTIONS {
            let described = describe(&format!("{prefix}_jp")).expect(prefix);
            assert!(
                std::ptr::eq(described, describe(prefix).unwrap()),
                "{prefix} が別の定義に吸われている",
            );
        }
    }

    // 出典表示はライセンス上の義務。データセットを増やしたときに書き忘れないよう、
    // 表の全項目を見る (ファイル名で licensor を判定し直すと、その判定自体が
    // 増えたデータセットを取りこぼす)。
    #[test]
    fn every_dataset_carries_an_attribution() {
        for (prefix, described) in DESCRIPTIONS {
            let Attribution { text, url } = described.attribution;
            assert!(!text.is_empty(), "{prefix} に出典が無い");
            assert!(
                url.starts_with("https://"),
                "{prefix} に出典元のURLが無い: {url}"
            );
        }
    }

    // 国土交通省の利用約款は、出典に「コンテンツ名」「（国土交通省）」「当該ページのURL」を、
    // 加工した場合はその旨を求めている。座標系変換と空間的な並べ替えをしているので、
    // どれも加工にあたる。
    #[test]
    fn mlit_attributions_follow_the_required_form() {
        for Attribution { text, url } in [MLIT_ISJ, MLIT_KSJ] {
            assert!(
                text.contains("（国土交通省）"),
                "作成者の表示が無い: {text}"
            );
            assert!(
                text.contains("もとに作成"),
                "加工した旨の記載が無い: {text}"
            );
            assert!(
                url.contains("nlftp.mlit.go.jp"),
                "当該ページのURLが国土交通省のものでない: {url}",
            );
        }
    }

    // Overtureは ODbL 1.0 で、OpenStreetMap由来を含むため両方の表示が要る。
    #[test]
    fn overture_attribution_credits_odbl_and_openstreetmap() {
        assert!(OVERTURE.text.contains("ODbL"), "{}", OVERTURE.text);
        assert!(OVERTURE.text.contains("OpenStreetMap"), "{}", OVERTURE.text);
    }
}
