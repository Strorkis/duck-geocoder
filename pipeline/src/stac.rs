//! カタログを [STAC 1.1.0](https://github.com/radiantearth/stac-spec) の文書にする。
//!
//! 独自形式をやめて標準に寄せたのは2つの理由から。
//!
//! - **遅延読み込みができる。** Catalog → Collection → Item と分かれるので、
//!   起動時に要るCollectionだけを読める。1ファイルに全部入れていた頃は、
//!   人口メッシュ47件を足しただけで12.7KB→72KBになり、PLATEAUを306都市に
//!   広げると460KB前後に達する見込みだった。使わないデータの分まで毎回待つことになる
//! - **既存のツールに載る。** stac-browser や pystac がそのまま読める
//!
//! 置き方は**出所ごとのディレクトリに、実データと一緒**。
//! **ルートは `catalog.json` 1つだけ。**
//!
//! ```text
//! catalog.json                         ← Catalog。出所ごとのサブカタログへの child リンク
//! estat/catalog.json                   ← Catalog (サブカタログ)。「国勢調査」
//! estat/estat-mesh-pop.json            ← Collection
//! estat/estat-mesh-pop-items.json      ← ItemCollection (Itemをまとめたもの)
//! estat/mesh_pop_13.parquet            ← 実データ
//! ```
//!
//! 以前は起点に平置きしていたが、**出所が増えるたびにルートにJSONが積み上がった**
//! (12コレクションで25ファイル)。実データは元から出所ごとに分かれていたので、
//! そこへ寄せた。
//!
//! **出所ごとにサブカタログを挟む。** 「PLATEAU」「Overture Maps」のような
//! まとまりを表すSTAC本来の仕組みで、UIの一覧もこの階層で見出しを作る
//! (画面を読むことがカタログを歩くことになるように)。`providers[].name` では
//! 束ねられない — 組織名なので、PLATEAUも国土数値情報も位置参照情報も
//! 「国土交通省」で1つにまとまってしまう。
//!
//! Itemを1件1ファイルにするのが静的STACの標準的な置き方だが、**採らない**。
//! 人口メッシュ47件 + PLATEAU306都市で350ファイルを超え、
//! 1つ読むたびに1往復する形になるため。代わりにCollectionごとに
//! ItemCollection (STAC APIの `/items` が返すのと同じ形) を1つ置く。
//!
//! **相対リンクはその文書からの相対**として解決される。平置きの間は
//! 「起点からの相対」と一致していてずれが表に出なかったが、階層を作ると出る。
//! `root` は `../catalog.json`、`items` は兄弟なのでファイル名だけ、
//! アセットも同じディレクトリにあるのでファイル名だけになる。

use crate::catalog::{ColumnEntry, DatasetEntry, DatasetKind};
use crate::external::{ExternalRaster, ExternalTileset, RasterRole, TileLink};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const STAC_VERSION: &str = "1.1.0";
/// `table:columns` / `table:row_count` の出どころ。
const TABLE_EXTENSION: &str = "https://stac-extensions.github.io/table/v1.2.0/schema.json";
/// `file:size` の出どころ。
const FILE_EXTENSION: &str = "https://stac-extensions.github.io/file/v2.1.0/schema.json";
const PARQUET_MEDIA_TYPE: &str = "application/vnd.apache.parquet";
const JSON_MEDIA_TYPE: &str = "application/json";
const GEOJSON_MEDIA_TYPE: &str = "application/geo+json";

/// このカタログ自身のID。
const CATALOG_ID: &str = "duck-geocoder";

/// 書き出す1ファイル。
pub struct Document {
    /// 配信の起点からの相対パス。
    pub path: String,
    pub body: Value,
}

/// Collectionの文書を置くディレクトリ。**実データと同じところに置く。**
///
/// 起点に平置きしていたが、出所が増えるたびにルートにJSONが積み上がっていた
/// (12コレクションで25ファイル)。実データは既に出所ごとのディレクトリに
/// 分かれているので、**そこへ寄せればルートは `catalog.json` 1つになる。**
///
/// ディレクトリは実データの位置から導く。**別に持たない**のは、
/// 置き場所が2か所に書かれていると食い違うため。
/// 同じCollectionのファイルが複数のディレクトリに散っていたらエラーにする。
fn collection_dir(entries: &[&DatasetEntry]) -> Result<String> {
    let dirs: std::collections::BTreeSet<&str> = entries
        .iter()
        .map(|entry| match entry.file.rsplit_once('/') {
            Some((dir, _)) => dir,
            // 起点直下のファイル。ディレクトリ無しとして扱う。
            None => "",
        })
        .collect();
    match dirs.into_iter().collect::<Vec<_>>().as_slice() {
        [dir] => Ok((*dir).to_string()),
        many => bail!(
            "1つのCollectionのファイルが複数のディレクトリに散っています: {many:?} \
             (出所ごとに1つのディレクトリへ置くこと)"
        ),
    }
}

/// `dir` の中のファイルへの、起点からのパス。`dir` が空なら起点直下。
fn in_dir(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// Collectionのファイル名 (ディレクトリを含まない)。
fn collection_file(id: &str) -> String {
    format!("{id}.json")
}

/// ItemCollectionのファイル名 (ディレクトリを含まない)。
fn items_file(id: &str) -> String {
    format!("{id}-items.json")
}

/// `dir` にある文書から `catalog.json` への相対リンク。
///
/// **STACの相対リンクはその文書からの相対。** 起点からのパスを書くと、
/// 仕様どおりに解決する読み手 (stac-browser など) で壊れる。
fn root_href(dir: &str) -> String {
    if dir.is_empty() {
        CATALOG_FILE.to_string()
    } else {
        format!("../{CATALOG_FILE}")
    }
}

const CATALOG_FILE: &str = "catalog.json";

/// 出所ごとのサブカタログ。
struct SubCatalog {
    /// 置き場所のディレクトリ。**これで引く** — Collectionの置き場所は
    /// 実データから導いている ([`collection_dir`]) ので、同じ鍵で題名を足す。
    dir: &'static str,
    title: &'static str,
    description: &'static str,
}

/// **出所の名前はここにしか書かない。** UIの一覧の見出しはここから来る。
///
/// ディレクトリが増えたのにここに無ければエラーにする。題名の無い見出しを
/// 黙って作ると、一覧に「plateau」のような置き場所の名前が出てしまう。
const SUB_CATALOGS: &[SubCatalog] = &[
    SubCatalog {
        dir: "plateau",
        title: "PLATEAU",
        description: "国土交通省が整備している3D都市モデルです。",
    },
    SubCatalog {
        dir: "overture",
        title: "Overture Maps",
        description: "Overture Maps Foundation が公開している地図データです。OpenStreetMap など、複数の出所をまとめたものです。",
    },
    SubCatalog {
        dir: "ksj",
        title: "国土数値情報",
        description: "国土交通省が整備している国土数値情報です。",
    },
    SubCatalog {
        dir: "estat",
        title: "国勢調査",
        description: "総務省統計局の国勢調査を、地域メッシュごとに集計したものです。",
    },
    SubCatalog {
        dir: "isj",
        title: "位置参照情報",
        description: "国土交通省の位置参照情報です。住所の代表点を持っています。",
    },
    // **UI に出る文章は丁寧語で書く** (利用者の指摘、2026-10-06)。内輪の言い方 (「うち」) もしない。
    SubCatalog {
        dir: "gsi",
        title: "国土地理院",
        description: "国土地理院が公開している地図タイル・ベクトルタイル・標高タイルです。\
                      このカタログでは複製せず、公開元の配信をそのまま使っています。",
    },
    SubCatalog {
        dir: "mapterhorn",
        title: "Mapterhorn",
        description: "世界の標高タイルです。このカタログでは複製せず、公開元の配信をそのまま使っています。",
    },
    SubCatalog {
        dir: "reearth",
        title: "Re:Earth",
        description: "Re:Earth が公開している標高タイルと 3D の建物 (3D Tiles) です。\
                      このカタログでは複製せず、公開元の配信をそのまま使っています。",
    },
    // JAXA と NASA は配信を使っておらず (まだ描かない)、公開元への案内だけを載せている。
    SubCatalog {
        dir: "jaxa",
        title: "JAXA",
        description: "宇宙航空研究開発機構 (JAXA) の衛星データです。\
                      このカタログでは複製せず、公開元 (JAXA Earth API) への案内だけを載せています。",
    },
    SubCatalog {
        dir: "nasa",
        title: "NASA",
        description: "米国航空宇宙局 (NASA) の衛星データです。このカタログでは複製せず、公開元への案内だけを載せています。",
    },
];

fn sub_catalog(dir: &str) -> Result<&'static SubCatalog> {
    match SUB_CATALOGS.iter().find(|sub| sub.dir == dir) {
        Some(sub) => Ok(sub),
        None => bail!(
            "ディレクトリ {dir:?} のサブカタログが定義されていません \
             (stac.rs の SUB_CATALOGS に題名と説明を足すこと)"
        ),
    }
}

/// 実データへのリンク。**ファイル名だけ**を返す。
///
/// ItemCollectionを実データと同じディレクトリに置いているので、
/// 文書からの相対はファイル名そのものになる。
fn asset_href(file: &str) -> String {
    match file.rsplit_once('/') {
        Some((_, name)) => name.to_string(),
        None => file.to_string(),
    }
}

/// bboxから矩形のGeoJSONを作る。
///
/// STACのItemは `geometry` を必須にしている。中身のジオメトリを全部書くわけには
/// いかないので、収録範囲の矩形を置く (`bbox` と同じ内容)。
fn bbox_geometry([west, south, east, north]: [f64; 4]) -> Value {
    json!({
        "type": "Polygon",
        "coordinates": [[
            [west, south], [east, south], [east, north], [west, north], [west, south],
        ]],
    })
}

/// 複数の範囲を包む範囲。
fn union_bbox(boxes: &[[f64; 4]]) -> Option<[f64; 4]> {
    boxes.iter().copied().reduce(|a, b| {
        [
            a[0].min(b[0]),
            a[1].min(b[1]),
            a[2].max(b[2]),
            a[3].max(b[3]),
        ]
    })
}

/// 語彙をファイルをまたいで束ねる。**先に出た順を保つ**ので、
/// 件数の多い用途が上に来る並びがそのまま残る。
fn merge_summaries(entries: &[&DatasetEntry]) -> BTreeMap<String, Vec<String>> {
    let mut merged: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for entry in entries {
        for (column, values) in &entry.summaries {
            let target = merged.entry(column.clone()).or_default();
            for value in values {
                if !target.contains(value) {
                    target.push(value.clone());
                }
            }
        }
    }
    merged
}

fn columns_json(columns: &[ColumnEntry]) -> Value {
    json!(columns)
}

/// 種別を機械が読むための独自項目。
///
/// STACにはこの概念が無い (アプリ固有の意味) ので、独自項目として持つ。
/// **接頭辞を付ける**のがSTACの作法 (`sci:` `msft:` などと同じ)。
fn duck_kind(kind: DatasetKind) -> Value {
    json!(kind)
}

/// 配布元へのリンク。
///
/// STACの `via` は「**このEntityが作られる元になったメタデータ/データ**」を指す関係
/// (best-practices)。ここにあるのは変換した複製なので、**原典へ辿れるようにする。**
/// 出典表示のリンク (`duck:attribution_url`) とは役割が違う。
fn via_link(href: &str) -> Value {
    json!({ "rel": "via", "href": href, "title": "配布元" })
}

fn item(entry: &DatasetEntry, dir: &str) -> Value {
    let mut properties = json!({
        // STACは datetime を必須にしているが、このパイプラインは元データの時点を
        // 読んでいない。**null は本来 start/end とセットで使うもの**なので、
        // 検証にかけると警告になる。時点を読めるようにするのが宿題。
        "datetime": Value::Null,
        "table:row_count": entry.row_count,
    });
    if !entry.geometry_types.is_empty() {
        properties["duck:geometry_types"] = json!(entry.geometry_types);
    }
    // **原典にどのLODがあるか。** 配信しているものより細かいものが原典にあると
    // 分かるようにする (PLATEAUの建物はLOD0しか読んでいないが、原典はLOD3まである)。
    // **都市ごとに違う**のでItemに出す (`via` と同じ判断)。
    if let Some(source_lod) = &entry.source_lod {
        properties["duck:source_lod"] = json!(source_lod);
    }

    let mut links = vec![
        json!({ "rel": "root", "href": root_href(dir), "type": JSON_MEDIA_TYPE }),
        json!({
            "rel": "collection",
            "href": collection_file(entry.collection),
            "type": JSON_MEDIA_TYPE,
        }),
        json!({
            "rel": "parent",
            "href": collection_file(entry.collection),
            "type": JSON_MEDIA_TYPE,
        }),
    ];
    // ファイルごとに配布元が違うもの (PLATEAUの都市ごとのzip) だけが持つ。
    if let Some(via) = &entry.via {
        links.push(via_link(via));
    }

    json!({
        "type": "Feature",
        "stac_version": STAC_VERSION,
        "stac_extensions": [TABLE_EXTENSION],
        "id": entry.id,
        "collection": entry.collection,
        "bbox": entry.bbox,
        "geometry": entry.bbox.map(bbox_geometry),
        "properties": properties,
        "assets": {
            "data": {
                // **ファイル名だけ。** 実データはこの文書と同じディレクトリにある。
                "href": asset_href(&entry.file),
                "type": PARQUET_MEDIA_TYPE,
                "title": entry.title,
                "roles": ["data"],
            }
        },
        "links": links,
    })
}

fn collection(id: &str, entries: &[&DatasetEntry], dir: &str) -> Result<Value> {
    let Some(first) = entries.first() else {
        bail!("{id} に1件も入っていない");
    };
    // 同じCollectionに入るものは同じ Description から来ているので、
    // 種別も出典も一致しているはず。ずれていたら組み立て方を間違えている。
    for entry in entries {
        if entry.kind != first.kind {
            bail!("{id} に種別の違うものが混ざっている: {}", entry.id);
        }
    }

    let boxes: Vec<[f64; 4]> = entries.iter().filter_map(|entry| entry.bbox).collect();
    // STACの空間範囲は「先頭が全体、以降は内訳 (任意)」。
    //
    // **内訳は入れない。** ファイルごとの範囲はItemが持っていて、ファイルを選ぶには
    // どのみち `href` が要るのでItemを読むことになる。両方に書くと、
    // Collectionがファイル数に比例して膨らむだけになる (人口メッシュ47件で
    // 2.3KB→8.3KB、PLATEAUを306都市に広げれば40KB超)。
    // Collectionは「何があるか」を知るために起動時に読むので、小さく保つ。
    let extent_boxes = match union_bbox(&boxes) {
        Some(overall) => vec![json!(overall)],
        // 名称だけのデータセットのようにジオメトリを持たないものもある。
        // STACは extent を必須にしているので、範囲なしを表す形で置く。
        None => vec![json!([null, null, null, null])],
    };

    let summaries = merge_summaries(entries);
    let mut body = json!({
        "type": "Collection",
        "stac_version": STAC_VERSION,
        "stac_extensions": [TABLE_EXTENSION],
        "id": id,
        "title": first.title,
        "description": first.description,
        "license": first.attribution.license,
        // **使う人が知りたい条件** (商用可か・出典表示・改変・継承) の要約。
        // `license` の識別子 (`other` を含む) だけでは何ができるか分からない。
        "duck:terms": first.attribution.terms,
        // 表示義務のある文言。STACに専用の項目が無いので独自項目で持つ。
        // providers[].name は組織名なので、そちらとは別に要る。
        "duck:attribution": first.attribution.text,
        "duck:attribution_url": first.attribution.url,
        "duck:kind": duck_kind(first.kind),
        "providers": [{
            "name": first.attribution.provider,
            "roles": ["producer", "licensor"],
            "url": first.attribution.url,
        }],
        "extent": {
            "spatial": { "bbox": extent_boxes },
            // 元データの時点を読んでいないので、期間は開いたままにする。
            "temporal": { "interval": [[null, null]] },
        },
        "item_assets": {
            "data": {
                "type": PARQUET_MEDIA_TYPE,
                "roles": ["data"],
                "table:columns": columns_json(&first.columns),
            }
        },
        "links": [
            { "rel": "root", "href": root_href(dir), "type": JSON_MEDIA_TYPE },
            // 親は同じディレクトリのサブカタログ。起点直下に置いたときはルートが
            // 親になるが、どちらもこの文書からは `catalog.json` で届く。
            { "rel": "parent", "href": CATALOG_FILE, "type": JSON_MEDIA_TYPE },
            { "rel": "self", "href": collection_file(id), "type": JSON_MEDIA_TYPE },
            { "rel": "items", "href": items_file(id), "type": GEOJSON_MEDIA_TYPE },
            via_link(first.collection_via),
        ],
    });
    if !summaries.is_empty() {
        body["summaries"] = json!(summaries);
    }
    // 同じ人口メッシュでも細かさの違うCollectionが並ぶので、UIがどれを引くかを
    // これで決める。メッシュ以外には出さない。
    if let Some(digits) = first.mesh_digits {
        body["duck:mesh_digits"] = json!(digits);
    }
    // **粗い段があるか。** あればUIが引いた表示で `lod = 0` を引く。
    // メッシュと同じく、**揃っているときだけ**出す — 一部のファイルにしか段が
    // 無いのに出すと、段の無いファイルを引いて空になる。
    let tolerances: std::collections::BTreeSet<String> = entries
        .iter()
        .filter_map(|entry| entry.coarse_lod_tolerance_m.map(|m| m.to_string()))
        .collect();
    if tolerances.len() == 1
        && entries
            .iter()
            .all(|entry| entry.coarse_lod_tolerance_m.is_some())
    {
        body["duck:coarse_lod_tolerance_m"] = json!(first.coarse_lod_tolerance_m);
    }
    // **どのCollectionの整備範囲か。** UIがこれで建物に結び付ける。
    if let Some(covers) = &first.covers {
        body["duck:covers"] = json!(covers);
    }
    // **重要度の段の規則。** 段はデータの列ではなく規則として載せるので、
    // UIはこれを読んで問い合わせの条件を組み立てる。
    if let Some(tiers) = first.tiers {
        body["duck:tiers"] = json!(tiers);
        // **段で間引ける列があるか。** 全ファイルが持つときだけ名乗る — 一部にしか
        // 無いのに名乗ると、無いファイルを `lod <= 0` で引いて空になる (粗い段と同じ考え方)。
        if entries.iter().all(|entry| entry.lod_by_tier) {
            body["duck:tiers"]["lod_column"] = json!("lod");
        }
    }
    // **いつ時点のデータか。** ファイルごとに違いうる (PLATEAUは都市ごとに
    // 更新年度が揃っていない) ので、**揃っているときだけ**Collectionに出す。
    // 揃っていないものを代表値で1つに丸めると、古い都市を新しいと誤解させる。
    let vintages: std::collections::BTreeSet<&str> = entries
        .iter()
        .filter_map(|entry| entry.vintage.as_deref())
        .collect();
    if vintages.len() == 1 && entries.iter().all(|entry| entry.vintage.is_some()) {
        body["duck:vintage"] = json!(vintages.iter().next());
    }
    Ok(body)
}

/// PMTiles のメディアタイプ (protomaps の仕様が名乗っているもの)。
const PMTILES_MEDIA_TYPE: &str = "application/vnd.pmtiles";

/// **外部のタイルセット**の Collection。Item は無く、アセットが公開元を直接指す。
///
/// GeoParquet の Collection と違って SQL では引けないので、`duck:kind` を
/// `vector_tiles` にして UI が「重ねて見るもの」として扱えるようにする。
/// 層の一覧・ズーム・属性はスナップショット (PMTiles のメタデータ) から書く。
fn external_collection(tileset: &ExternalTileset, dir: &str) -> Result<Value> {
    tileset.validate()?;
    let snapshot = tileset.snapshot()?;
    let layer = |id: &str| {
        snapshot
            .metadata
            .vector_layers
            .iter()
            .find(|layer| layer.id == id)
    };
    // テーマごとに、層の人向けの名前と、出るズーム・属性・**形の種類**を添える。
    // 形があれば、配布元の描き方に頼らず UI が面・線・点で描き分けられる。
    let themes: Vec<Value> = tileset
        .themes
        .iter()
        .map(|theme| {
            let layers: Vec<Value> = theme
                .layers
                .iter()
                .map(|(id, title)| {
                    // validate が層の有無を確かめてある。
                    let found = layer(id).expect("validate 済み");
                    json!({
                        "id": id,
                        "title": title,
                        "minzoom": found.minzoom,
                        "maxzoom": found.maxzoom,
                        "fields": found.fields.keys().collect::<Vec<_>>(),
                        "geometry": found.geometry,
                        "count": found.count,
                    })
                })
                .collect();
            json!({ "id": theme.id, "title": theme.title, "layers": layers })
        })
        .collect();

    let mut body = json!({
        "type": "Collection",
        "stac_version": STAC_VERSION,
        // アセットの `file:size` と、`rel: "pmtiles"` のリンクの出どころ。
        "stac_extensions": [FILE_EXTENSION, WEB_MAP_LINKS_EXTENSION],
        "id": tileset.id,
        "title": tileset.title,
        "description": tileset.description,
        "license": tileset.attribution.license,
        "duck:terms": tileset.attribution.terms,
        "duck:attribution": tileset.attribution.text,
        "duck:attribution_url": tileset.attribution.url,
        "duck:kind": "vector_tiles",
        "duck:vintage": tileset.vintage,
        "duck:themes": themes,
        "providers": [{
            "name": tileset.attribution.provider,
            // **配信も向こう。** うちは指しているだけ。
            "roles": ["producer", "licensor", "host"],
            "url": tileset.via,
        }],
        "extent": {
            "spatial": { "bbox": [snapshot.bounds] },
            "temporal": { "interval": [[null, null]] },
        },
        "assets": {
            "data": {
                "href": snapshot.url,
                "type": PMTILES_MEDIA_TYPE,
                "title": tileset.title,
                "roles": ["data"],
                "file:size": snapshot.bytes,
                "duck:zoom": [snapshot.min_zoom, snapshot.max_zoom],
            },
        },
        "links": [
            { "rel": "root", "href": root_href(dir), "type": JSON_MEDIA_TYPE },
            { "rel": "parent", "href": CATALOG_FILE, "type": JSON_MEDIA_TYPE },
            { "rel": "self", "href": collection_file(tileset.id), "type": JSON_MEDIA_TYPE },
            via_link(tileset.via),
            // 地図に重ねる道具 (QGIS・stac-browser など) が読める形でも指す (web-map-links)。
            {
                "rel": "pmtiles",
                "href": snapshot.url,
                "type": PMTILES_MEDIA_TYPE,
                "title": tileset.title,
                "pmtiles:layers": snapshot
                    .metadata
                    .vector_layers
                    .iter()
                    .map(|layer| layer.id.as_str())
                    .collect::<Vec<_>>(),
            },
        ],
    });
    // **どう作ったか。** 簡略化の度合い (tippecanoe の `-S`) がここで分かるので、
    // 「表示用に加工されている」ことの根拠として残す。
    if let Some(generator) = &snapshot.metadata.generator_options {
        body["duck:generator_options"] = json!(generator);
    }
    Ok(body)
}

/// 地図タイルへのリンク (`rel: "xyz"` / `"tilejson"` / `"pmtiles"`) の出どころ。
const WEB_MAP_LINKS_EXTENSION: &str =
    "https://stac-extensions.github.io/web-map-links/v1.3.0/schema.json";

/// **外部のラスタタイル** (背景地図・標高) の Collection。Item もアセットも無く、
/// web-map-links 拡張のリンクでタイルを指す (タイルは1ファイルではないので、アセットにならない)。
fn raster_collection(
    raster: &ExternalRaster,
    dir: &str,
    dirs: &BTreeMap<String, String>,
) -> Result<Value> {
    let tiles = match &raster.link {
        TileLink::Xyz {
            template,
            media_type,
        } => Some(
            json!({ "rel": "xyz", "href": template, "type": media_type, "title": raster.title }),
        ),
        TileLink::TileJson { url } => Some(
            json!({ "rel": "tilejson", "href": url, "type": JSON_MEDIA_TYPE, "title": raster.title }),
        ),
        TileLink::ThreeDTiles { url } => Some(
            json!({ "rel": "3d-tiles", "href": url, "type": JSON_MEDIA_TYPE, "title": raster.title }),
        ),
        // 同じデータを公開元が STAC で配っている。この文書の別の姿なので `alternate`
        // (ビューアの `alternate` とは型 (JSON か HTML か) で見分ける)。
        TileLink::Stac { url } => Some(
            json!({ "rel": "alternate", "href": url, "type": JSON_MEDIA_TYPE, "title": "公開元の STAC (COG)" }),
        ),
        TileLink::None => None,
    };
    let mut links = vec![
        json!({ "rel": "root", "href": root_href(dir), "type": JSON_MEDIA_TYPE }),
        json!({ "rel": "parent", "href": CATALOG_FILE, "type": JSON_MEDIA_TYPE }),
        json!({ "rel": "self", "href": collection_file(raster.id), "type": JSON_MEDIA_TYPE }),
        via_link(raster.via),
    ];
    links.extend(tiles);
    // **何から作られたか。** 行き先はこのカタログの Collection (無ければ作り方の誤り)。
    for source in raster.derived_from {
        let Some(target_dir) = dirs.get(*source) else {
            bail!(
                "{} の derived_from {source:?} がカタログにありません",
                raster.id
            );
        };
        let href = if target_dir == dir {
            collection_file(source)
        } else {
            format!("../{}", in_dir(target_dir, &collection_file(source)))
        };
        links.push(json!({ "rel": "derived_from", "href": href, "type": JSON_MEDIA_TYPE }));
    }
    // この地図で描けないもの (3D Tiles) を見る先。HTML のページなので `alternate`。
    if let Some(viewer) = raster.viewer {
        links.push(json!({ "rel": "alternate", "href": viewer, "type": "text/html", "title": "公式のビューア" }));
    }
    let mut body = json!({
        "type": "Collection",
        "stac_version": STAC_VERSION,
        "stac_extensions": [WEB_MAP_LINKS_EXTENSION],
        "id": raster.id,
        "title": raster.title,
        "description": raster.description,
        "license": raster.attribution.license,
        "duck:terms": raster.attribution.terms,
        "duck:attribution": raster.attribution.text,
        "duck:attribution_url": raster.attribution.url,
        // UI が重ね方を決める: 背景地図はいちばん下に敷き、標高は地図を立体にする。
        "duck:kind": match raster.role {
            RasterRole::Basemap => "raster_tiles",
            RasterRole::Terrain => "terrain",
            RasterRole::ThreeDTiles => "3d_tiles",
            RasterRole::Reference => "reference",
        },
        "providers": [{
            "name": raster.attribution.provider,
            "roles": ["producer", "licensor", "host"],
            "url": raster.via,
        }],
        "extent": {
            "spatial": { "bbox": [raster.bounds] },
            "temporal": { "interval": [[null, null]] },
        },
        "links": links,
    });
    // **タイルが実際にあるズームと大きさ。** 無いズームを要求すると 404 を撃ち続ける。
    // 地図タイル (背景地図・標高) だけが持つ。3D Tiles と参照だけの元データには書かない
    // (以前は 0 を書いていて、STAC Browser に「Tile Size 0」と出た)。
    if matches!(raster.role, RasterRole::Basemap | RasterRole::Terrain) {
        body["duck:zoom"] = json!([raster.minzoom, raster.maxzoom]);
        body["duck:tile_size"] = json!(raster.tile_size);
    }
    // 同じ役割 (背景地図・地形) の中で既定に使うもの。
    if raster.default {
        body["duck:default"] = json!(true);
    }
    if let Some(dem) = &raster.dem {
        body["duck:dem"] = json!(dem);
    }
    Ok(body)
}

/// カタログをSTACの文書一式にする。
///
/// 返るのは「配信の起点からの相対パス」と中身の組。書き出しは呼び出し側の仕事。
/// `externals` と `rasters` は外部で公開されている配信物 ([`crate::external`])。
pub fn build(
    datasets: &[DatasetEntry],
    externals: &[ExternalTileset],
    rasters: &[ExternalRaster],
) -> Result<Vec<Document>> {
    // BTreeMapなので、Collectionの並びはIDの順で安定する
    // (作り直すたびに差分が出ないように)。
    let mut grouped: BTreeMap<&str, Vec<&DatasetEntry>> = BTreeMap::new();
    for entry in datasets {
        grouped.entry(entry.collection).or_default().push(entry);
    }
    if grouped.is_empty() {
        bail!("データセットが1件もありません");
    }

    let mut documents = Vec::new();
    // ディレクトリ → そこに置くCollectionへの child リンク。
    let mut by_dir: BTreeMap<String, Vec<Value>> = BTreeMap::new();

    for (id, entries) in &grouped {
        // **実データと同じディレクトリに置く。** ルートを `catalog.json` だけにするため。
        let dir = collection_dir(entries)?;

        by_dir.entry(dir.clone()).or_default().push(json!({
            "rel": "child",
            // 親 (サブカタログ) と同じディレクトリにあるので、ファイル名だけでよい。
            "href": collection_file(id),
            "type": JSON_MEDIA_TYPE,
            "title": entries[0].title,
        }));

        documents.push(Document {
            path: in_dir(&dir, &collection_file(id)),
            body: collection(id, entries, &dir)?,
        });
        documents.push(Document {
            path: in_dir(&dir, &items_file(id)),
            body: json!({
                "type": "FeatureCollection",
                "features": entries
                    .iter()
                    .map(|entry| item(entry, &dir))
                    .collect::<Vec<_>>(),
                "links": [
                    // **この文書からの相対。** 以前は "catalog.json" と書いていて、
                    // サブディレクトリから引くと同じ階層の (無い) ファイルを指していた。
                    { "rel": "root", "href": root_href(&dir), "type": JSON_MEDIA_TYPE },
                    { "rel": "collection", "href": collection_file(id), "type": JSON_MEDIA_TYPE },
                ],
            }),
        });
    }

    // 背景地図を先に並べる (一覧でも、国土地理院の見出しの下で地図が先に来る)。
    // Collection の ID → 置き場所。`derived_from` のリンクを相対で書くのに使う。
    let mut dirs: BTreeMap<String, String> = BTreeMap::new();
    for (id, entries) in &grouped {
        dirs.insert(id.to_string(), collection_dir(entries)?);
    }
    for tileset in externals {
        dirs.insert(tileset.id.to_string(), tileset.dir.to_string());
    }
    for raster in rasters {
        dirs.insert(raster.id.to_string(), raster.dir.to_string());
    }

    for raster in rasters {
        by_dir
            .entry(raster.dir.to_string())
            .or_default()
            .push(json!({
                "rel": "child",
                "href": collection_file(raster.id),
                "type": JSON_MEDIA_TYPE,
                "title": raster.title,
            }));
        documents.push(Document {
            path: in_dir(raster.dir, &collection_file(raster.id)),
            body: raster_collection(raster, raster.dir, &dirs)?,
        });
    }
    for tileset in externals {
        by_dir
            .entry(tileset.dir.to_string())
            .or_default()
            .push(json!({
                "rel": "child",
                "href": collection_file(tileset.id),
                "type": JSON_MEDIA_TYPE,
                "title": tileset.title,
            }));
        documents.push(Document {
            path: in_dir(tileset.dir, &collection_file(tileset.id)),
            body: external_collection(tileset, tileset.dir)?,
        });
    }

    let mut links = vec![
        json!({ "rel": "root", "href": CATALOG_FILE, "type": JSON_MEDIA_TYPE }),
        json!({ "rel": "self", "href": CATALOG_FILE, "type": JSON_MEDIA_TYPE }),
    ];

    // 起点直下に置いたCollectionはサブカタログを挟まず、ルートから直接指す。
    if let Some(children) = by_dir.remove("") {
        links.extend(children);
    }

    // **サブカタログは `SUB_CATALOGS` の順に並べる。** UIの一覧の並びになるので、
    // 既定で出ているもの (PLATEAUの建物) を先頭に置けるよう、IDの順にはしない。
    // 表に無いディレクトリは先に弾く (`sub_catalog` がエラーにする)。
    for dir in by_dir.keys() {
        sub_catalog(dir)?;
    }
    for sub in SUB_CATALOGS {
        let Some(children) = by_dir.remove(sub.dir) else {
            continue;
        };
        links.push(json!({
            "rel": "child",
            "href": in_dir(sub.dir, CATALOG_FILE),
            "type": JSON_MEDIA_TYPE,
            "title": sub.title,
        }));

        let mut sub_links = vec![
            json!({ "rel": "root", "href": root_href(sub.dir), "type": JSON_MEDIA_TYPE }),
            json!({ "rel": "parent", "href": root_href(sub.dir), "type": JSON_MEDIA_TYPE }),
            json!({ "rel": "self", "href": CATALOG_FILE, "type": JSON_MEDIA_TYPE }),
        ];
        sub_links.extend(children);
        documents.push(Document {
            path: in_dir(sub.dir, CATALOG_FILE),
            body: json!({
                "type": "Catalog",
                "stac_version": STAC_VERSION,
                "id": format!("{CATALOG_ID}-{}", sub.dir),
                "title": sub.title,
                "description": sub.description,
                "links": sub_links,
            }),
        });
    }

    documents.push(Document {
        path: "catalog.json".to_string(),
        body: json!({
            "type": "Catalog",
            "stac_version": STAC_VERSION,
            "id": CATALOG_ID,
            "title": "duck-geocoder のデータ",
            // 使う条件の要約 (`duck:terms`) は独自に規約を読んだもの。STAC Browser など、
            // カタログだけを見る人にも届くように、ルートの説明に書く。
            "description": "日本のオープンな地理空間データを GeoParquet にしたものです。ブラウザから DuckDB-WASM で直接読めます。\
                            各 Collection の使う条件の要約 (duck:terms) は、このカタログが独自に規約を読んでまとめた参考情報で、\
                            正確さは保証しません。使う前に、必ず各配布元の規約の本文を確かめてください。",
            "links": links,
        }),
    });

    Ok(documents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Attribution;
    use crate::external::GSI_OPTIMAL_BVMAP;

    /// 外部のタイルセット無しで組み立てる。ほとんどのテストは GeoParquet 側だけを見る。
    fn build(datasets: &[DatasetEntry]) -> Result<Vec<Document>> {
        super::build(datasets, &[], &[])
    }

    /// **外部のタイルセットは公開元を直接指す。** Item は無く、層はテーマに束ねて載る。
    #[test]
    fn external_rasters_link_their_tiles() {
        use crate::external::EXTERNAL_RASTERS;
        // Re:Earth Buildings の元 (derived_from) になる Overture の建物。
        let mut overture = entry(
            "overture_buildings_1312212",
            "overture/overture_buildings_1312212.parquet",
            None,
        );
        overture.collection = "overture-buildings";
        let datasets = vec![
            entry("mesh_pop_13", "estat/mesh_pop_13.parquet", None),
            overture,
        ];
        let documents = super::build(&datasets, &[GSI_OPTIMAL_BVMAP], EXTERNAL_RASTERS).unwrap();

        // **何から作られたか**を辿れる。別のサブカタログへは `../` で。
        let derived = |document: &Value| -> Vec<String> {
            document["links"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|link| link["rel"] == "derived_from")
                .map(|link| link["href"].as_str().unwrap().to_string())
                .collect()
        };
        let mapterhorn = find(&documents, "mapterhorn/mapterhorn-terrain.json");
        assert_eq!(derived(mapterhorn), ["../gsi/gsi-dem-source.json"]);
        assert_eq!(mapterhorn["duck:dem"]["encoding"], "terrarium");
        // 地形の既定は Mapterhorn (並び順ではなくカタログが示す)。ほかは名乗らない。
        assert_eq!(mapterhorn["duck:default"], true);
        assert!(find(&documents, "gsi/gsi-dem.json")["duck:default"].is_null());
        let gsi_dem = find(&documents, "gsi/gsi-dem.json");
        assert_eq!(derived(gsi_dem), ["gsi-dem-source.json"]);
        assert_eq!(gsi_dem["duck:dem"]["encoding"], "gsi");
        assert_eq!(
            find(&documents, "gsi/gsi-dem-source.json")["duck:kind"],
            "reference"
        );
        // 3D Tiles は rel "3d-tiles" で指し、公式のビューアを添える。
        let buildings = find(&documents, "reearth/reearth-buildings.json");
        assert_eq!(buildings["duck:kind"], "3d_tiles");
        let rels: Vec<&str> = buildings["links"]
            .as_array()
            .unwrap()
            .iter()
            .map(|link| link["rel"].as_str().unwrap())
            .collect();
        assert!(
            rels.contains(&"3d-tiles") && rels.contains(&"alternate"),
            "{rels:?}"
        );
        assert_eq!(
            derived(buildings),
            [
                "../overture/overture-buildings.json",
                "reearth-terrain.json"
            ]
        );
        // タイルの大きさとズームは地図タイルだけ。3D Tiles と参照には書かない (0 と書かない)。
        assert!(buildings["duck:tile_size"].is_null());
        assert!(buildings["duck:zoom"].is_null());
        assert!(find(&documents, "gsi/gsi-dem-source.json")["duck:tile_size"].is_null());
        assert_eq!(mapterhorn["duck:tile_size"], 512);

        // AW3D30 は参照だけ。公開元の STAC Collection を JSON の `alternate` で指す
        // (ビューアの `alternate` は HTML)。商用は「事前に連絡」で、「可」と言い切らない。
        let aw3d30 = find(&documents, "jaxa/jaxa-aw3d30.json");
        assert_eq!(aw3d30["duck:kind"], "reference");
        let stac = aw3d30["links"]
            .as_array()
            .unwrap()
            .iter()
            .find(|link| link["rel"] == "alternate")
            .unwrap();
        assert_eq!(stac["type"], "application/json");
        assert!(
            stac["href"]
                .as_str()
                .unwrap()
                .ends_with("AW3D30.v4.1_global/collection.json")
        );
        assert_eq!(aw3d30["duck:terms"]["commercial"], "allowed_with_notice");
        assert!(aw3d30["duck:tile_size"].is_null());
        // NASA の2つも参照だけ。サブカタログは出所ごと。
        assert_eq!(
            find(&documents, "nasa/nasa-aster-gdem.json")["license"],
            "CC0-1.0"
        );
        assert_eq!(
            find(&documents, "nasa/nasa-nasadem.json")["duck:kind"],
            "reference"
        );
        // PLATEAU の公式の 3D Tiles は、うちの PLATEAU のサブカタログに並べ、PLATEAU VIEW を添える。
        let plateau_tiles = find(&documents, "plateau/plateau-3dtiles.json");
        assert_eq!(plateau_tiles["duck:kind"], "3d_tiles");
        assert!(
            plateau_tiles["links"]
                .as_array()
                .unwrap()
                .iter()
                .any(|link| link["rel"] == "alternate" && link["type"] == "text/html")
        );

        // 背景地図は XYZ のリンクで指す。範囲 (ズーム) を書く — 白地図は5〜14しか無い。
        let blank = find(&documents, "gsi/gsi-blank.json");
        assert_eq!(blank["duck:kind"], "raster_tiles");
        assert_eq!(blank["duck:zoom"], json!([5, 14]));
        let xyz = blank["links"]
            .as_array()
            .unwrap()
            .iter()
            .find(|link| link["rel"] == "xyz")
            .unwrap();
        assert!(
            xyz["href"]
                .as_str()
                .unwrap()
                .contains("/xyz/blank/{z}/{x}/{y}.png")
        );
        assert!(blank.get("assets").is_none());

        // 標高は TileJSON で指す。別の出所 (Mapterhorn) のサブカタログに入る。
        let terrain = find(&documents, "mapterhorn/mapterhorn-terrain.json");
        assert_eq!(terrain["duck:kind"], "terrain");
        assert!(
            terrain["links"]
                .as_array()
                .unwrap()
                .iter()
                .any(|link| link["rel"] == "tilejson")
        );
        assert!(
            terrain["duck:attribution"]
                .as_str()
                .unwrap()
                .contains("国土地理院長承認")
        );

        // 国土地理院の見出しの下では、背景地図がベクトルタイルより先に並ぶ。
        let gsi = find(&documents, "gsi/catalog.json");
        let children: Vec<&str> = gsi["links"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|link| link["rel"] == "child")
            .map(|link| link["href"].as_str().unwrap())
            .collect();
        assert_eq!(children.first(), Some(&"gsi-pale.json"));
        assert_eq!(children.last(), Some(&"gsi-optimal-bvmap.json"));
    }

    /// `derived_from` の行き先がカタログに無ければ止める (黙って壊れたリンクを書かない)。
    #[test]
    fn rejects_derived_from_outside_the_catalog() {
        use crate::external::EXTERNAL_RASTERS;
        let datasets = vec![entry("mesh_pop_13", "estat/mesh_pop_13.parquet", None)];
        // overture-buildings が無いので、Re:Earth Buildings の derived_from が解決できない。
        let Err(error) = super::build(&datasets, &[GSI_OPTIMAL_BVMAP], EXTERNAL_RASTERS) else {
            panic!("通ってしまった");
        };
        assert!(error.to_string().contains("overture-buildings"), "{error}");
    }

    #[test]
    fn external_tilesets_point_at_the_publisher() {
        let datasets = vec![entry("mesh_pop_13", "estat/mesh_pop_13.parquet", None)];
        let documents = super::build(&datasets, &[GSI_OPTIMAL_BVMAP], &[]).unwrap();

        let root = find(&documents, "catalog.json");
        let children: Vec<&str> = root["links"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|link| link["rel"] == "child")
            .map(|link| link["href"].as_str().unwrap())
            .collect();
        assert!(children.contains(&"gsi/catalog.json"), "{children:?}");

        let collection = find(&documents, "gsi/gsi-optimal-bvmap.json");
        assert_eq!(collection["duck:kind"], "vector_tiles");
        assert!(
            collection["assets"]["data"]["href"]
                .as_str()
                .unwrap()
                .starts_with("https://cyberjapandata.gsi.go.jp/")
        );
        assert_eq!(collection["assets"]["data"]["type"], PMTILES_MEDIA_TYPE);
        // 配布元の描き方 (スタイル) は載せない。描き方は形の種類から決める。
        assert!(collection["assets"]["style"].is_null());
        // Item は無い。
        assert!(
            collection["links"]
                .as_array()
                .unwrap()
                .iter()
                .all(|link| link["rel"] != "items")
        );
        assert!(
            !documents
                .iter()
                .any(|document| document.path.starts_with("gsi/")
                    && document.path.ends_with("-items.json"))
        );
        // 層はテーマに束ね、出るズームを添える (建物はズーム14から)。
        let themes = collection["duck:themes"].as_array().unwrap();
        let building = themes
            .iter()
            .find(|theme| theme["id"] == "building")
            .unwrap();
        assert_eq!(building["layers"][0]["id"], "BldA");
        assert_eq!(building["layers"][0]["minzoom"], 14);
        assert_eq!(building["layers"][0]["geometry"], "Polygon");
        let layers: usize = themes
            .iter()
            .map(|theme| theme["layers"].as_array().unwrap().len())
            .sum();
        assert_eq!(layers, 24);
        assert!(collection["duck:terms"]["commercial"] == "allowed");
    }

    fn attribution() -> Attribution {
        Attribution {
            text: "「出典」（どこか）をもとに作成",
            url: "https://example.invalid/",
            license: "other",
            provider: "どこか",
            terms: crate::catalog::Terms {
                name: "どこかの規約",
                url: "https://example.invalid/terms",
                commercial: crate::catalog::Commercial::Allowed,
                attribution_required: true,
                note_modification: true,
                share_alike: false,
            },
        }
    }

    fn entry(id: &str, file: &str, bbox: Option<[f64; 4]>) -> DatasetEntry {
        DatasetEntry {
            id: id.to_string(),
            file: file.to_string(),
            kind: DatasetKind::PopulationMesh,
            collection: "estat-mesh-pop",
            title: "人口メッシュ",
            description: "説明",
            attribution: attribution(),
            geometry_types: vec!["Polygon".to_string()],
            bbox,
            row_count: 10,
            columns: vec![ColumnEntry {
                name: "population".to_string(),
                data_type: "INT32".to_string(),
            }],
            summaries: BTreeMap::new(),
            mesh_digits: Some(11),
            via: None,
            vintage: None,
            source_lod: None,
            coarse_lod_tolerance_m: None,
            covers: None,
            tiers: None,
            lod_by_tier: false,
            collection_via: "https://example.invalid/download",
        }
    }

    fn find<'a>(documents: &'a [Document], path: &str) -> &'a Value {
        &documents
            .iter()
            .find(|document| document.path == path)
            .unwrap_or_else(|| panic!("{path} が無い"))
            .body
    }

    #[test]
    fn writes_a_catalog_a_collection_and_an_item_collection() {
        let datasets = vec![
            entry(
                "mesh_pop_13",
                "estat/mesh_pop_13.parquet",
                Some([139.0, 35.0, 140.0, 36.0]),
            ),
            entry(
                "mesh_pop_14",
                "estat/mesh_pop_14.parquet",
                Some([139.0, 35.0, 139.5, 35.5]),
            ),
        ];
        let documents = build(&datasets).unwrap();

        let catalog = find(&documents, "catalog.json");
        assert_eq!(catalog["type"], "Catalog");
        assert_eq!(catalog["stac_version"], STAC_VERSION);
        let children: Vec<&Value> = catalog["links"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|link| link["rel"] == "child")
            .collect();
        assert_eq!(children.len(), 1);
        // **ルートの子は出所ごとのサブカタログ。** Collectionはその下にいる。
        assert_eq!(children[0]["href"], "estat/catalog.json");
        assert_eq!(children[0]["title"], "国勢調査");

        let sub = find(&documents, "estat/catalog.json");
        assert_eq!(sub["type"], "Catalog");
        assert_eq!(sub["title"], "国勢調査");
        let sub_children: Vec<&Value> = sub["links"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|link| link["rel"] == "child")
            .collect();
        assert_eq!(sub_children.len(), 1);
        // サブカタログと同じディレクトリにあるので、ファイル名だけ。
        assert_eq!(sub_children[0]["href"], "estat-mesh-pop.json");

        let collection = find(&documents, "estat/estat-mesh-pop.json");
        assert_eq!(collection["type"], "Collection");
        assert_eq!(collection["duck:kind"], "population_mesh");

        let items = find(&documents, "estat/estat-mesh-pop-items.json");
        assert_eq!(items["type"], "FeatureCollection");
        assert_eq!(items["features"].as_array().unwrap().len(), 2);
    }

    /// **STACの相対リンクはその文書からの相対。**
    ///
    /// 起点からのパスを書くと、仕様どおりに解決する読み手 (stac-browser など) が
    /// `estat/estat/...` を引きに行って壊れる。平置きの間は両者が一致していて
    /// ずれが表に出なかったが、階層を作ると出る。
    #[test]
    fn links_are_relative_to_the_document() {
        let datasets = vec![entry(
            "mesh_pop_13",
            "estat/mesh_pop_13.parquet",
            Some([139.0, 35.0, 140.0, 36.0]),
        )];
        let documents = build(&datasets).unwrap();

        // アセットは同じディレクトリにあるので、ファイル名だけ。
        let items = find(&documents, "estat/estat-mesh-pop-items.json");
        assert_eq!(
            items["features"][0]["assets"]["data"]["href"],
            "mesh_pop_13.parquet"
        );

        let href = |document: &Value, rel: &str| -> String {
            document["links"]
                .as_array()
                .unwrap()
                .iter()
                .find(|link| link["rel"] == rel)
                .unwrap_or_else(|| panic!("{rel} が無い"))["href"]
                .as_str()
                .unwrap()
                .to_string()
        };

        // 1つ下にいるので、起点へは `../`。
        let collection = find(&documents, "estat/estat-mesh-pop.json");
        assert_eq!(href(collection, "root"), "../catalog.json");
        // 親は同じディレクトリのサブカタログ。
        assert_eq!(href(collection, "parent"), "catalog.json");
        // 兄弟なのでファイル名だけ。
        assert_eq!(href(collection, "items"), "estat-mesh-pop-items.json");
        assert_eq!(href(collection, "self"), "estat-mesh-pop.json");

        assert_eq!(href(&items["features"][0], "root"), "../catalog.json");
        assert_eq!(
            href(&items["features"][0], "collection"),
            "estat-mesh-pop.json"
        );
        // **ItemCollection自身の root も文書からの相対。** 以前は "catalog.json" と
        // 書いていて、同じ階層の (存在しない) ファイルを指していた。
        assert_eq!(href(items, "root"), "../catalog.json");

        // サブカタログから見ると、ルートは1つ上。
        let sub = find(&documents, "estat/catalog.json");
        assert_eq!(href(sub, "root"), "../catalog.json");
        assert_eq!(href(sub, "parent"), "../catalog.json");
        assert_eq!(href(sub, "self"), "catalog.json");
    }

    /// **表に無いディレクトリはエラーにする。** 題名の無い見出しを黙って作ると、
    /// 一覧に置き場所の名前 (「newsource」) がそのまま出てしまう。
    #[test]
    fn rejects_a_directory_without_a_sub_catalog() {
        let datasets = vec![entry(
            "mesh_pop_13",
            "newsource/mesh_pop_13.parquet",
            Some([139.0, 35.0, 140.0, 36.0]),
        )];
        let error = build(&datasets)
            .err()
            .expect("エラーになるはず")
            .to_string();
        assert!(error.contains("newsource"), "{error}");
        assert!(error.contains("SUB_CATALOGS"), "{error}");
    }

    /// **サブカタログは定義の順に並ぶ。** UIの一覧の並びになるので、IDの順
    /// (estat → ... → plateau) にすると既定で出ているPLATEAUが最後に来る。
    #[test]
    fn orders_sub_catalogs_as_defined_not_alphabetically() {
        let mut plateau = entry(
            "plateau_bldg_13103",
            "plateau/b.parquet",
            Some([139.0, 35.0, 140.0, 36.0]),
        );
        plateau.collection = "plateau-buildings";
        let datasets = vec![
            entry(
                "mesh_pop_13",
                "estat/mesh_pop_13.parquet",
                Some([139.0, 35.0, 140.0, 36.0]),
            ),
            plateau,
        ];
        let documents = build(&datasets).unwrap();
        let titles: Vec<&str> = find(&documents, "catalog.json")["links"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|link| link["rel"] == "child")
            .map(|link| link["title"].as_str().unwrap())
            .collect();
        assert_eq!(titles, ["PLATEAU", "国勢調査"]);
    }

    /// 起点直下に実データがある場合は、`../` を付けない。
    #[test]
    fn keeps_links_flat_when_the_data_sits_at_the_root() {
        let datasets = vec![entry(
            "mesh_pop_13",
            "mesh_pop_13.parquet",
            Some([139.0, 35.0, 140.0, 36.0]),
        )];
        let documents = build(&datasets).unwrap();
        let collection = find(&documents, "estat-mesh-pop.json");
        let root = collection["links"]
            .as_array()
            .unwrap()
            .iter()
            .find(|link| link["rel"] == "root")
            .unwrap()["href"]
            .as_str()
            .unwrap();
        assert_eq!(root, "catalog.json");
    }

    /// 粗い段は**全ファイルに揃っているときだけ**Collectionに出す。
    ///
    /// 一部にしか段が無いのに名乗ると、UIが `lod = 0` を引いて
    /// **段の無いファイルだけ空になる** (歯抜けの地図になって原因が分かりにくい)。
    #[test]
    fn announces_the_coarse_level_only_when_every_file_has_one() {
        let with_level = |file: &str, tolerance: Option<f64>| {
            let mut entry = entry("mesh_pop_13", file, Some([139.0, 35.0, 140.0, 36.0]));
            entry.coarse_lod_tolerance_m = tolerance;
            entry
        };
        let key = "duck:coarse_lod_tolerance_m";

        // 揃っている。
        let documents = build(&[
            with_level("estat/a.parquet", Some(100.0)),
            with_level("estat/b.parquet", Some(100.0)),
        ])
        .unwrap();
        assert_eq!(find(&documents, "estat/estat-mesh-pop.json")[key], 100.0);

        // 片方に無い。**出さない。**
        let documents = build(&[
            with_level("estat/a.parquet", Some(100.0)),
            with_level("estat/b.parquet", None),
        ])
        .unwrap();
        assert!(find(&documents, "estat/estat-mesh-pop.json")[key].is_null());

        // 誤差が揃っていない。片方を代表値にすると、粗い方で細かいズームまで
        // 使ってしまう。**出さない。**
        let documents = build(&[
            with_level("estat/a.parquet", Some(100.0)),
            with_level("estat/b.parquet", Some(500.0)),
        ])
        .unwrap();
        assert!(find(&documents, "estat/estat-mesh-pop.json")[key].is_null());
    }

    /// 1つのCollectionのファイルが複数のディレクトリに散っていたら気付けるようにする。
    /// **どこに文書を置けばよいか決まらない**ので、黙って片方を選んではいけない。
    #[test]
    fn rejects_a_collection_split_across_directories() {
        let datasets = vec![
            entry("mesh_pop_13", "estat/mesh_pop_13.parquet", None),
            entry("mesh_pop_14", "elsewhere/mesh_pop_14.parquet", None),
        ];
        let Err(err) = build(&datasets) else {
            panic!("散っているのにエラーにならなかった");
        };
        assert!(err.to_string().contains("複数のディレクトリ"));
    }

    // 空間範囲は全体の1件だけ。ファイルごとの範囲はItemが持っているので、
    // Collectionに並べるとファイル数に比例して膨らむだけになる。
    // Collectionは起動時に読むものなので、件数で増えない形を保つ。
    #[test]
    fn spatial_extent_is_only_the_overall_box() {
        let datasets = vec![
            entry("a", "a.parquet", Some([139.0, 35.0, 140.0, 36.0])),
            entry("b", "b.parquet", Some([138.0, 34.0, 139.0, 35.0])),
        ];
        let documents = build(&datasets).unwrap();
        let boxes = find(&documents, "estat-mesh-pop.json")["extent"]["spatial"]["bbox"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(boxes, vec![json!([138.0, 34.0, 140.0, 36.0])]);
    }

    // 出典は表示義務がある。STACに専用の項目が無いので独自項目で持っているが、
    // 落ちるとライセンス違反になるので必ず入っていること。
    #[test]
    fn collection_carries_the_attribution_text() {
        let datasets = vec![entry("a", "a.parquet", None)];
        let documents = build(&datasets).unwrap();
        let collection = find(&documents, "estat-mesh-pop.json");
        assert_eq!(collection["duck:attribution"], attribution().text);
        assert_eq!(collection["duck:attribution_url"], attribution().url);
        assert_eq!(collection["providers"][0]["name"], "どこか");
    }

    // ジオメトリを持たないデータセット (名称だけのもの) でも、STACは extent を必須にする。
    #[test]
    fn handles_datasets_without_geometry() {
        let datasets = vec![entry("a", "a.parquet", None)];
        let documents = build(&datasets).unwrap();
        let collection = find(&documents, "estat-mesh-pop.json");
        assert_eq!(
            collection["extent"]["spatial"]["bbox"],
            json!([[null, null, null, null]])
        );
        let items = find(&documents, "estat-mesh-pop-items.json");
        assert_eq!(items["features"][0]["geometry"], Value::Null);
    }

    // 語彙は Collection の summaries に入る。UIの絞り込みの選択肢がここから
    // 作られるので、ファイルをまたいで束ねたうえで、順序も保つ必要がある。
    #[test]
    fn merges_vocabularies_across_files_keeping_order() {
        let mut first = entry("a", "a.parquet", None);
        first.summaries = BTreeMap::from([(
            "usage".to_string(),
            vec!["住宅".to_string(), "共同住宅".to_string()],
        )]);
        let mut second = entry("b", "b.parquet", None);
        second.summaries = BTreeMap::from([(
            "usage".to_string(),
            vec!["共同住宅".to_string(), "工場".to_string()],
        )]);

        let documents = build(&[first, second]).unwrap();
        let usage = &find(&documents, "estat-mesh-pop.json")["summaries"]["usage"];
        assert_eq!(usage, &json!(["住宅", "共同住宅", "工場"]));
    }

    // 語彙が無いデータセットまで summaries を持つと、UIは「絞れる列がある」と
    // 誤って判断する。空なら項目ごと出さない。
    #[test]
    fn omits_summaries_when_there_is_no_vocabulary() {
        let documents = build(&[entry("a", "a.parquet", None)]).unwrap();
        let collection = find(&documents, "estat-mesh-pop.json");
        assert!(collection.get("summaries").is_none(), "{collection}");
    }

    // 列構成は Collection の item_assets に1つだけ置く。Item ごとに繰り返すと、
    // ファイルが増えたぶんだけ同じ内容が並ぶ (独自形式でそうなっていた)。
    #[test]
    fn columns_live_on_the_collection_not_on_every_item() {
        let documents =
            build(&[entry("a", "a.parquet", None), entry("b", "b.parquet", None)]).unwrap();
        let collection = find(&documents, "estat-mesh-pop.json");
        assert_eq!(
            collection["item_assets"]["data"]["table:columns"][0]["name"],
            "population"
        );
        let items = find(&documents, "estat-mesh-pop-items.json");
        for feature in items["features"].as_array().unwrap() {
            assert!(
                feature["properties"].get("table:columns").is_none(),
                "Itemに列構成が入っている: {feature}"
            );
        }
    }

    /// 配布元へのリンク。**ここにあるのは変換した複製で、原典は配布元にある。**
    /// 実物が欲しくなった人が辿れるようにするためのもの。
    fn via_hrefs(document: &Value) -> Vec<&str> {
        document["links"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|link| link["rel"] == "via")
            .map(|link| link["href"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn collection_links_to_where_the_data_came_from() {
        let documents = build(&[entry("a", "a.parquet", None)]).unwrap();
        assert_eq!(
            via_hrefs(find(&documents, "estat-mesh-pop.json")),
            vec!["https://example.invalid/download"]
        );
    }

    // ファイルごとに配布元が違うもの (PLATEAUは都市ごとにzipのURLが違う) は、
    // Item側にも出す。変換時にGeoParquetへ書いたものを拾っている。
    #[test]
    fn item_links_to_its_own_source_when_the_file_knows_it() {
        let mut with_source = entry("a", "a.parquet", None);
        with_source.via = Some("https://example.invalid/13103.zip".to_string());
        let plain = entry("b", "b.parquet", None);

        let documents = build(&[with_source, plain]).unwrap();
        let features = find(&documents, "estat-mesh-pop-items.json")["features"]
            .as_array()
            .unwrap()
            .clone();

        assert_eq!(
            via_hrefs(&features[0]),
            vec!["https://example.invalid/13103.zip"]
        );
        // 分からないものは書かない。**推測で埋めない。**
        assert!(via_hrefs(&features[1]).is_empty());
    }

    /// **原典にどのLODがあるか**をItemに出す。
    ///
    /// 配信しているのはLOD0だけなので、画面で「原典はLOD3まで」と言うための手掛かり。
    /// 都市ごとに違うので、Collectionにまとめず1件ずつ持つ。
    #[test]
    fn item_says_which_lods_the_source_has() {
        let mut with_lod = entry("a", "a.parquet", None);
        with_lod.source_lod = Some("1,2,3".to_string());
        let plain = entry("b", "b.parquet", None);

        let documents = build(&[with_lod, plain]).unwrap();
        let features = find(&documents, "estat-mesh-pop-items.json")["features"]
            .as_array()
            .unwrap()
            .clone();

        assert_eq!(features[0]["properties"]["duck:source_lod"], "1,2,3");
        // LODの概念が無いデータセットには出さない。
        assert!(features[1]["properties"].get("duck:source_lod").is_none());
        // Collectionには出さない (都市ごとに違うため)。
        assert!(
            find(&documents, "estat-mesh-pop.json")
                .get("duck:source_lod")
                .is_none()
        );
    }

    #[test]
    fn rejects_an_empty_catalog() {
        assert!(build(&[]).is_err());
    }
}
