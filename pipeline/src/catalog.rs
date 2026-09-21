use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::path::Path;

/// GeoParquet 1件から読み取った素性。**STACを組み立てる前の中間表現。**
///
/// 件数・bbox・列構成は実際のGeoParquetのメタデータから読むので、中身とずれない。
/// これを [`crate::stac`] が Collection と Item にまとめ直す。
#[derive(Debug)]
pub struct DatasetEntry {
    /// ファイル名から決まる識別子。STACのItem IDになる。例: "n03_all"
    pub id: String,
    /// 配信時のパス。STACのアセットの `href` になる。例: "estat/mesh_pop_13.parquet"
    pub file: String,
    /// UIやツールが扱いを切り替えるための種別。
    /// 表示用の `title` と違い、こちらは機械が分岐に使う。
    pub kind: DatasetKind,
    /// 属するCollectionのID。同じ出所・同じ種別のファイルが1つにまとまる。
    pub collection: &'static str,
    /// 人間向けの名称。
    pub title: &'static str,
    /// Collectionの説明。STACは必須項目にしている。
    pub description: &'static str,
    /// 出典・ライセンス。
    pub attribution: Attribution,
    /// ジオメトリの種類 (Point / MultiPolygon など)。UIの表示方法がこれで決まる。
    pub geometry_types: Vec<String>,
    /// 収録範囲 [xmin, ymin, xmax, ymax] (WGS84)。
    pub bbox: Option<[f64; 4]>,
    pub row_count: i64,
    pub columns: Vec<ColumnEntry>,
    /// 列がとりうる値の一覧。列名 → 値 (件数の多い順)。
    ///
    /// **UIが選択肢をここから作るためにある。** 無いと起動時に全ファイルの
    /// 該当列を走査することになり、ファイルが増えるほど1ファイル1往復の
    /// フッター読みが積み上がる。
    ///
    /// 語彙を持つ列は [`Description::summary_columns`] で指定する。
    pub summaries: BTreeMap<String, Vec<String>>,
    /// 地域メッシュの細かさ (メッシュコードの桁数)。メッシュ以外は `None`。
    pub mesh_digits: Option<u8>,
    /// **このファイル1つの配布元。** GeoParquetの `duck:via` から読む。
    ///
    /// ファイルごとに違うもの (PLATEAUの都市ごとのzip) だけが持つ。
    pub via: Option<String>,
    /// **いつ時点のデータか。** GeoParquetの `duck:vintage` から読む。
    ///
    /// 出所を見ただけでは版が分からず、古いものを新しいと思って使う事故が起きる。
    /// 配布元が名乗っている形 (`N02-25 (2026-03-06)` など) をそのまま持ち回る。
    pub vintage: Option<String>,
    /// **この出所の配布元。** 出所全体で1つ。ファイル側に `via` が無くてもこれはある。
    pub collection_via: &'static str,
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
    /// 人口メッシュ (面)。SORAのGround Riskに使う人口密度を持つ。
    ///
    /// ジオメトリはメッシュコードから計算したもの (`crate::mesh`)。
    PopulationMesh,
    /// PLATEAUの建物 (面)。高さ・用途・階数がほぼ全件に入っており、絞り込みに使える。
    ///
    /// [`DatasetKind::Buildings`] と分けているのは列構成が違うため。
    /// 同じ種別にすると `read_parquet([...])` で1つのビューに束ねられてしまい、
    /// スキーマが合わずに壊れる。
    PlateauBuildings,
    /// 鉄道路線 (線)。第三者リスクと「落としてはいけない場所」に使う。
    Railway,
    /// 鉄道駅 (線)。**点ではない** — 原典がホームの延長を線で持っている。
    ///
    /// [`DatasetKind::Railway`] と分けているのは駅名などの列が増えるため
    /// ([`DatasetKind::PlateauBuildings`] と同じ理由)。
    RailwayStation,
    /// 道路 (線)。人と車がいるので、墜落は二次事故になる。
    ///
    /// 出所はOverture。**国のデータには路線名が無い** (N13の属性8つに含まれず、
    /// 地理院の道路中心線も名前は注記レイヤにしかない) ので、
    /// 「国道13号」で引けるのはこちらだけ。詳細は docs/data-sources.md。
    Road,
    /// 道路の路線 (「国道13号」など)。ジオメトリを持たない。
    ///
    /// [`DatasetKind::Road`] の要約で、**出所は同じ**。路線名で引いたときに
    /// 全区間のbbox列 (配信物の13%) を読まずに済ませるためのもの
    /// ([`DatasetKind::AdminNames`] と同じ役目)。
    RoadRoute,
}

/// 列1つ。項目名はSTACのTable拡張に合わせてある。
#[derive(Debug, Serialize, Clone)]
pub struct ColumnEntry {
    pub name: String,
    /// Parquet上の物理型。
    #[serde(rename = "type")]
    pub data_type: String,
}

/// 出典表示。表示する文言と、その出典元のURL。
///
/// 別々の定数で持つと組み合わせを間違えても気付けないので、まとめて扱う。
#[derive(Debug, Clone, Copy)]
pub struct Attribution {
    /// 地図上にそのまま出す文言。**表示義務があるので縮めない。**
    pub text: &'static str,
    /// 出典元のURL。国土交通省の記載例が出典にURLを求めている。
    pub url: &'static str,
    /// STACの `license`。[SPDX識別子](https://spdx.org/licenses/)か、
    /// 当てはまるものが無ければ `"other"`。
    pub license: &'static str,
    /// STACの `providers[].name`。組織名。
    pub provider: &'static str,
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
    license: "other",
    provider: "国土交通省",
};
const MLIT_KSJ: Attribution = Attribution {
    text: "「国土数値情報（行政区域データ）」（国土交通省）をもとに作成",
    url: "https://nlftp.mlit.go.jp/ksj/",
    license: "other",
    provider: "国土交通省",
};

/// 国土数値情報の鉄道データ (N02)。**2020年度以降はオープンデータ扱い**で、
/// 行政区域 (N03) と違って複製に国土地理院長の承認を求める記載が無い。
/// 出所ごとに条件が違うので、行政区域とは別の出典にしてある。
/// <https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2022.html>
const MLIT_KSJ_RAILWAY: Attribution = Attribution {
    text: "「国土数値情報（鉄道データ）」（国土交通省）をもとに作成",
    url: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2022.html",
    license: "other",
    provider: "国土交通省",
};

/// Overture Maps は ODbL 1.0。OpenStreetMap由来を含むため両方を示す。
/// <https://docs.overturemaps.org/attribution/>
const OVERTURE: Attribution = Attribution {
    text: "Overture Maps / © OpenStreetMap contributors (ODbL 1.0)",
    url: "https://docs.overturemaps.org/attribution/",
    license: "ODbL-1.0",
    provider: "Overture Maps Foundation",
};

/// PLATEAU (3D都市モデル) は政府標準利用規約に準じたPDL1.0。
/// 加工した場合はその旨を示すことを求めているので、他の国土交通省コンテンツと
/// 同じく「をもとに作成」の形にする。
/// <https://www.mlit.go.jp/plateau/site-policy/>
const MLIT_PLATEAU: Attribution = Attribution {
    text: "「3D都市モデル（Project PLATEAU）」（国土交通省）をもとに作成",
    url: "https://www.mlit.go.jp/plateau/",
    // PDL1.0だが CC BY 4.0 での利用も認められている。SPDXに当てはまる方を出す。
    license: "CC-BY-4.0",
    provider: "国土交通省",
};

/// 国勢調査の地域メッシュ統計。政府標準利用規約 (第2.0版) で、出典表示のうえ
/// 商用も含めて二次利用できる。ジオメトリはメッシュコードから計算しているので、
/// 統計の数値だけを使っていることになる。
/// <https://www.e-stat.go.jp/terms-of-use>
const ESTAT_MESH: Attribution = Attribution {
    text: "「令和2年国勢調査 地域メッシュ統計」（総務省統計局）をもとに作成",
    url: "https://www.e-stat.go.jp/gis",
    license: "other",
    provider: "総務省統計局",
};

/// データセットの素性。ファイル名の接頭辞から引く。
struct Description {
    kind: DatasetKind,
    /// 属するSTAC CollectionのID。**出所と種別が同じものが1つにまとまる。**
    ///
    /// 行政区域のように出所が2つありうるもの (N03とOverture) は別のCollectionにする。
    /// 列構成もライセンスも違うため。
    collection: &'static str,
    /// 人間向けの名称。
    title: &'static str,
    /// Collectionの説明。STACが必須にしている項目。
    description: &'static str,
    attribution: Attribution,
    /// とりうる値をカタログに書き出す列。UIの選択肢がここから作られる。
    ///
    /// 名前や住所のように値が行ごとに違う列を入れてはいけない。
    /// 取り違えても壊れないよう [`MAX_VOCABULARY`] で歯止めを掛けてあるが、
    /// 歯止めに当たった列は選択肢が作れなくなる。
    summary_columns: &'static [&'static str],
    /// 地域メッシュの細かさ (メッシュコードの桁数)。11桁=125m、8桁=1km。
    ///
    /// **同じ人口メッシュでも細かさの違うCollectionが並ぶ**ので、UIがどれを引くかを
    /// これで決める。要求する細かさ以上のものの中から、いちばん粗いものを選べば
    /// 読む量が最小になる。メッシュ以外は `None`。
    mesh_digits: Option<u8>,
    /// **この出所の配布元。** 実物が欲しい人が辿る先。
    ///
    /// 出典表示のリンク先 ([`Attribution::url`]) とは別物。Overtureでは
    /// 出典表示がガイドページを指すのに対し、配布元はデータのページになる。
    via: &'static str,
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
            collection: "ksj-admin-names",
            title: "行政区域の名称",
            description: "国土数値情報の行政区域から名称だけを抜き出したもの。地名検索の候補に使う。",
            attribution: MLIT_KSJ,
            summary_columns: &[],
            mesh_digits: None,
            via: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html",
        },
    ),
    (
        "n03",
        Description {
            kind: DatasetKind::Admin,
            collection: "ksj-admin",
            title: "行政区域",
            description: "国土数値情報の行政区域 (面)。逆ジオコーディングとハイライトに使う。",
            attribution: MLIT_KSJ,
            summary_columns: &[],
            mesh_digits: None,
            via: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html",
        },
    ),
    (
        "n02_stations",
        Description {
            kind: DatasetKind::RailwayStation,
            collection: "ksj-railway-stations",
            title: "鉄道駅",
            description: "国土数値情報の鉄道データのうち駅。原典がホームの延長を線で持っているので、点に潰さず線のまま配っている。",
            attribution: MLIT_KSJ_RAILWAY,
            summary_columns: &["railway_class", "institution_type"],
            mesh_digits: None,
            via: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2022.html",
        },
    ),
    (
        "n02_sections",
        Description {
            kind: DatasetKind::Railway,
            collection: "ksj-railway",
            title: "鉄道路線",
            description: "国土数値情報の鉄道データのうち路線 (線)。鉄道区分と事業者種別はコードを名前に解決したうえで、原典のコードも併せて持つ。",
            attribution: MLIT_KSJ_RAILWAY,
            summary_columns: &["railway_class", "institution_type"],
            mesh_digits: None,
            via: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2022.html",
        },
    ),
    (
        "overture_admin_names",
        Description {
            kind: DatasetKind::AdminNames,
            collection: "overture-admin-names",
            title: "行政区域の名称",
            description: "Overtureの行政区域から名称だけを抜き出したもの。地名検索の候補に使う。",
            attribution: OVERTURE,
            summary_columns: &[],
            mesh_digits: None,
            // 出典表示のリンク先 (attribution.url) はガイドページなので、配布元とは別。
            via: "https://docs.overturemaps.org/guides/divisions/",
        },
    ),
    (
        "overture_admin",
        Description {
            kind: DatasetKind::Admin,
            collection: "overture-admin",
            title: "行政区域",
            description: "Overtureの行政区域 (面)。逆ジオコーディングとハイライトに使う。",
            attribution: OVERTURE,
            summary_columns: &[],
            mesh_digits: None,
            // 出典表示のリンク先 (attribution.url) はガイドページなので、配布元とは別。
            via: "https://docs.overturemaps.org/guides/divisions/",
        },
    ),
    (
        "overture_buildings",
        Description {
            kind: DatasetKind::Buildings,
            collection: "overture-buildings",
            title: "建物",
            description: "Overtureの建物 (面)。高さと種別は入っている割合が低い。",
            attribution: OVERTURE,
            // Overtureの建物種別。"residential" "commercial" など。
            summary_columns: &["class"],
            mesh_digits: None,
            via: "https://docs.overturemaps.org/guides/buildings/",
        },
    ),
    (
        "overture_road_routes",
        Description {
            kind: DatasetKind::RoadRoute,
            collection: "overture-road-routes",
            title: "道路の路線",
            description: "Overtureの道路から路線名だけを抜き出したもの。「国道13号」のような路線名検索に使う。",
            attribution: OVERTURE,
            summary_columns: &[],
            mesh_digits: None,
            via: "https://docs.overturemaps.org/guides/transportation/",
        },
    ),
    (
        "overture_roads",
        Description {
            kind: DatasetKind::Road,
            collection: "overture-roads",
            title: "道路",
            description: "Overtureの道路 (線) のうち幹線。1つの区間が複数の路線に属することがあるので、路線名と系統はリストで持つ。",
            attribution: OVERTURE,
            // Overtureの道路等級。"motorway"=高速、"trunk"≒国道、"primary"≒主要地方道・県道。
            summary_columns: &["class"],
            mesh_digits: None,
            via: "https://docs.overturemaps.org/guides/transportation/",
        },
    ),
    (
        "plateau_bldg",
        Description {
            kind: DatasetKind::PlateauBuildings,
            collection: "plateau-buildings",
            title: "建物 (PLATEAU)",
            description: "PLATEAUの建物 (面)。高さ・用途・階数がほぼ全件に入っている。都市ごとに1ファイル。",
            attribution: MLIT_PLATEAU,
            // PLATEAUの用途。コードリストで解決済みの「住宅」「商業施設」など。
            summary_columns: &["usage"],
            mesh_digits: None,
            // 都市ごとのzipのURLはファイル側 (`duck:via`) が持つ。ここは入口。
            via: "https://www.geospatial.jp/ckan/dataset/plateau",
        },
    ),
    // **`mesh_pop` より前に置くこと。** 前方一致で引くので、後ろだと吸われる。
    (
        "mesh_pop_1km",
        Description {
            kind: DatasetKind::PopulationMesh,
            collection: "estat-mesh-pop-1km",
            title: "人口メッシュ (1km)",
            description: "令和2年国勢調査の地域メッシュ統計を1kmに束ねたもの。全国で1ファイル。引いた表示で125mを読むと転送量が跳ね上がるため、俯瞰用に別に持つ。人口・世帯数は合計、密度は中に含まれる125mメッシュの最大値。",
            attribution: ESTAT_MESH,
            summary_columns: &[],
            via: "https://www.e-stat.go.jp/gis/statmap-search?page=1&type=1",
            mesh_digits: Some(8),
        },
    ),
    (
        "mesh_pop",
        Description {
            kind: DatasetKind::PopulationMesh,
            collection: "estat-mesh-pop",
            title: "人口メッシュ",
            description: "令和2年国勢調査の地域メッシュ統計 (125m)。人口・世帯数・人口密度を持つ。ジオメトリはメッシュコードから計算したもの。都道府県ごとに1ファイル。",
            attribution: ESTAT_MESH,
            summary_columns: &[],
            via: "https://www.e-stat.go.jp/gis/statmap-search?page=1&type=1",
            mesh_digits: Some(11),
        },
    ),
    (
        "isj_oaza",
        Description {
            kind: DatasetKind::Oaza,
            collection: "isj-oaza",
            title: "大字・町丁目",
            description: "位置参照情報の大字・町丁目 (点)。住所検索に使う。",
            attribution: MLIT_ISJ,
            summary_columns: &[],
            mesh_digits: None,
            via: "https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_choose_method.cgi",
        },
    ),
    (
        "isj_block",
        Description {
            kind: DatasetKind::Block,
            collection: "isj-block",
            title: "街区",
            description: "位置参照情報の街区 (点)。より細かい住所検索に使う。",
            attribution: MLIT_ISJ,
            summary_columns: &[],
            mesh_digits: None,
            via: "https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_choose_method.cgi",
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

/// 語彙として扱う値の数の上限。
///
/// 選択肢に並べるためのものなので、これを超えたら列の指定を間違えている
/// (名前や住所のような列を指したなど)。カタログを肥大させる前に打ち切る。
const MAX_VOCABULARY: usize = 256;

/// ある列がとりうる値を、**件数の多い順**に集める。
///
/// 並び順をそのままUIの選択肢の順にする。よく出る用途が上に来る方が選びやすく、
/// 同数のときは値で並べて、作り直しても順序が変わらないようにする。
///
/// 列が無ければ `None`。値の種類が [`MAX_VOCABULARY`] を超えた場合も
/// 語彙ではないと判断して `None` を返す。
fn read_vocabulary(path: &Path, column: &str) -> Result<Option<Vec<String>>> {
    use arrow::array::{Array, StringArray};
    use arrow::datatypes::DataType;
    use parquet::arrow::ProjectionMask;
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

    let file = File::open(path).with_context(|| format!("開けません: {}", path.display()))?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)
        .with_context(|| format!("Parquetとして読めません: {}", path.display()))?;

    let schema = builder.parquet_schema();
    let Some(index) = schema
        .columns()
        .iter()
        .position(|c| c.path().string() == column)
    else {
        return Ok(None);
    };
    // 語彙を集めたい1列だけを読む。全列を読むとファイルの大きさがそのまま効く。
    let mask = ProjectionMask::leaves(schema, [index]);
    let reader = builder.with_projection(mask).build()?;

    let mut counts: HashMap<String, usize> = HashMap::new();
    for batch in reader {
        let batch = batch?;
        // 文字列の持ち方は出所によって違う (Utf8 / LargeUtf8 / 辞書エンコード)。
        // 読み分けるより変換に任せる方が、出所が増えたときに壊れにくい。
        let array = arrow::compute::cast(batch.column(0), &DataType::Utf8)
            .with_context(|| format!("{column} が文字列として読めません"))?;
        let values = array
            .as_any()
            .downcast_ref::<StringArray>()
            .context("Utf8に変換したのにStringArrayでない")?;
        for value in values.iter().flatten() {
            if !counts.contains_key(value) && counts.len() >= MAX_VOCABULARY {
                eprintln!(
                    "  {} の値が{MAX_VOCABULARY}種類を超えたので語彙にしません: {}",
                    column,
                    path.display(),
                );
                return Ok(None);
            }
            *counts.entry(value.to_string()).or_default() += 1;
        }
    }
    if counts.is_empty() {
        return Ok(None);
    }

    let mut values: Vec<(String, usize)> = counts.into_iter().collect();
    values.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(Some(values.into_iter().map(|(value, _)| value).collect()))
}

/// 配信時のパスを組み立てる。`base` からの相対パスを、URLと同じ `/` 区切りにする。
///
/// 配信先 (R2) のキーはこの値がそのまま使われる。Windowsで生成しても
/// `\` が混ざらないよう、区切りは明示的に置き換える。
fn delivery_path(path: &Path, base: &Path) -> Result<String> {
    let relative = path.strip_prefix(base).unwrap_or(path);
    let parts: Vec<&str> = relative
        .components()
        .map(|c| {
            c.as_os_str()
                .to_str()
                .context("パスに扱えない文字が入っている")
        })
        .collect::<Result<_>>()?;
    Ok(parts.join("/"))
}

/// GeoParquet 1件を読んでカタログエントリを組み立てる。
///
/// `base` は配信の起点になるディレクトリ。ここからの相対パスが `file` になるので、
/// **出所ごとにディレクトリを切って置ける** (`estat/mesh_pop_13.parquet` など)。
/// 配信先のキーがそのまま分かれるので、1つの出所だけを上げ直せる。
pub fn describe_parquet(path: &Path, base: &Path) -> Result<DatasetEntry> {
    let file_stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .context("ファイル名が取得できない")?;
    let file = delivery_path(path, base)?;

    let described =
        describe(file_stem).with_context(|| format!("未知のデータセットです: {file}"))?;

    let handle = File::open(path).with_context(|| format!("開けません: {}", path.display()))?;
    let reader = parquet::file::reader::SerializedFileReader::new(handle)
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
        (None, DatasetKind::AdminNames | DatasetKind::RoadRoute) => (Vec::new(), None),
        (None, _) => bail!("GeoParquetの `geo` メタデータがありません: {file}"),
    };

    // ファイルごとの素性。変換時に書いてあれば拾う (PLATEAUの都市ごとのzipなど)。
    let key_value = |key: &str| {
        file_metadata
            .key_value_metadata()
            .and_then(|kv| kv.iter().find(|entry| entry.key == key))
            .and_then(|entry| entry.value.clone())
    };
    let via = key_value(crate::geoparquet::VIA_KEY);
    let vintage = key_value(crate::geoparquet::VINTAGE_KEY);

    let columns = file_metadata
        .schema_descr()
        .columns()
        .iter()
        .map(|col| ColumnEntry {
            name: col.path().string(),
            data_type: col.physical_type().to_string(),
        })
        .collect();

    let row_count = file_metadata.num_rows();
    // メタデータだけで済む項目と違い、ここは列の中身を読む。
    // 読むのは指定した1列だけで、しかも変換時の1回きり。
    // 代わりにブラウザ側が起動時に全ファイルを走査せずに済む。
    let mut summaries = BTreeMap::new();
    for column in described.summary_columns {
        if let Some(values) = read_vocabulary(path, column)? {
            summaries.insert((*column).to_string(), values);
        }
    }

    Ok(DatasetEntry {
        id: file_stem.to_string(),
        file,
        kind: described.kind,
        collection: described.collection,
        title: described.title,
        description: described.description,
        attribution: described.attribution,
        geometry_types,
        bbox,
        row_count,
        columns,
        summaries,
        mesh_digits: described.mesh_digits,
        via,
        vintage,
        collection_via: described.via,
    })
}

/// 配下の *.parquet を集める。**サブディレクトリも見る。**
fn collect_parquet(dir: &Path, found: &mut Vec<std::path::PathBuf>) -> Result<()> {
    let entries =
        std::fs::read_dir(dir).with_context(|| format!("読めません: {}", dir.display()))?;
    for entry in entries {
        let path = entry?.path();
        if path.is_dir() {
            collect_parquet(&path, found)?;
        } else if path.extension().is_some_and(|ext| ext == "parquet") {
            found.push(path);
        }
    }
    Ok(())
}

/// ディレクトリ配下の *.parquet を走査してカタログを組み立てる。
///
/// **出所ごとにディレクトリを切ってよい。** `file` には `dir` からの相対パスが入り、
/// 配信先ではそれがそのままキーになる (`estat/mesh_pop_13.parquet`)。
/// ファイルが数百に増えたときに、1つの出所だけを上げ直せるようにするため。
pub fn build_catalog(dir: &Path) -> Result<Vec<DatasetEntry>> {
    let mut paths = Vec::new();
    collect_parquet(dir, &mut paths)?;
    paths.sort();

    if paths.is_empty() {
        bail!("{} にGeoParquetがありません", dir.display());
    }

    paths
        .iter()
        .map(|path| describe_parquet(path, dir))
        .collect::<Result<Vec<_>>>()
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

    // 配信先のキーは `file` がそのまま使われる。ディレクトリを切って置けること、
    // そのとき区切りがURLと同じ `/` になることを見る。
    #[test]
    fn delivery_path_is_relative_and_slash_separated() {
        let base = Path::new("/data/output");
        assert_eq!(
            delivery_path(Path::new("/data/output/estat/mesh_pop_13.parquet"), base).unwrap(),
            "estat/mesh_pop_13.parquet",
        );
        // 直下に置いたものは今までどおり名前だけ。
        assert_eq!(
            delivery_path(Path::new("/data/output/n03_all.parquet"), base).unwrap(),
            "n03_all.parquet",
        );
    }

    // 出典表示はライセンス上の義務。データセットを増やしたときに書き忘れないよう、
    // 表の全項目を見る (ファイル名で licensor を判定し直すと、その判定自体が
    // 増えたデータセットを取りこぼす)。
    #[test]
    fn every_dataset_carries_an_attribution() {
        for (prefix, described) in DESCRIPTIONS {
            let Attribution { text, url, .. } = described.attribution;
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
        for Attribution { text, url, .. } in [MLIT_ISJ, MLIT_KSJ] {
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

    // 絞り込める種別の選択肢は、カタログの語彙から作る。出所を足したときに
    // ここを書き忘れると、UIから絞り込みが黙って消える。
    //
    // もとは「建物だけが絞り込める」前提だったが、鉄道も区分と事業者種別で
    // 絞れるようにしたので、種別の一覧として持つ形に変えた。
    #[test]
    fn filterable_datasets_declare_a_vocabulary() {
        for (prefix, described) in DESCRIPTIONS {
            let is_filterable = matches!(
                described.kind,
                DatasetKind::Buildings
                    | DatasetKind::PlateauBuildings
                    | DatasetKind::Railway
                    | DatasetKind::RailwayStation
                    | DatasetKind::Road
            );
            assert_eq!(
                is_filterable,
                !described.summary_columns.is_empty(),
                "{prefix}: 絞り込める種別には語彙にする列が要る / それ以外には要らない",
            );
        }
    }

    // Collectionは出所と種別の組で分かれる。同じIDに違う種別が入ると
    // `stac::build` が落ちるので、表の側で取り違えていないことを見ておく。
    #[test]
    fn each_collection_holds_one_kind() {
        let mut kinds: std::collections::HashMap<&str, DatasetKind> =
            std::collections::HashMap::new();
        for (prefix, described) in DESCRIPTIONS {
            assert!(
                !described.collection.is_empty(),
                "{prefix} にCollectionが無い"
            );
            assert!(
                !described.description.is_empty(),
                "{prefix} に説明が無い (STACの必須項目)"
            );
            if let Some(existing) = kinds.insert(described.collection, described.kind) {
                assert_eq!(
                    existing, described.kind,
                    "{} に種別が2つある",
                    described.collection
                );
            }
        }
    }

    // Overtureは ODbL 1.0 で、OpenStreetMap由来を含むため両方の表示が要る。
    #[test]
    fn overture_attribution_credits_odbl_and_openstreetmap() {
        assert!(OVERTURE.text.contains("ODbL"), "{}", OVERTURE.text);
        assert!(OVERTURE.text.contains("OpenStreetMap"), "{}", OVERTURE.text);
    }
}
