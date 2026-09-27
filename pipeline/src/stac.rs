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
//! catalog.json                         ← Catalog。各Collectionへの child リンク
//! estat/estat-mesh-pop.json            ← Collection
//! estat/estat-mesh-pop-items.json      ← ItemCollection (Itemをまとめたもの)
//! estat/mesh_pop_13.parquet            ← 実データ
//! ```
//!
//! 以前は起点に平置きしていたが、**出所が増えるたびにルートにJSONが積み上がった**
//! (12コレクションで25ファイル)。実データは元から出所ごとに分かれていたので、
//! そこへ寄せた。
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
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const STAC_VERSION: &str = "1.1.0";
/// `table:columns` / `table:row_count` の出どころ。
const TABLE_EXTENSION: &str = "https://stac-extensions.github.io/table/v1.2.0/schema.json";
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
            { "rel": "parent", "href": root_href(dir), "type": JSON_MEDIA_TYPE },
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
    // **何で絞ったか。** 「60m以上だけ」と画面で断るために出す。
    if let Some(height) = first.min_height_m {
        body["duck:min_height_m"] = json!(height);
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

/// カタログをSTACの文書一式にする。
///
/// 返るのは「配信の起点からの相対パス」と中身の組。書き出しは呼び出し側の仕事。
pub fn build(datasets: &[DatasetEntry]) -> Result<Vec<Document>> {
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
    let mut child_links = Vec::new();

    for (id, entries) in &grouped {
        // **実データと同じディレクトリに置く。** ルートを `catalog.json` だけにするため。
        let dir = collection_dir(entries)?;

        child_links.push(json!({
            "rel": "child",
            // catalog.json は起点にあるので、ここは起点からのパスでよい。
            "href": in_dir(&dir, &collection_file(id)),
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
                    { "rel": "root", "href": "catalog.json", "type": JSON_MEDIA_TYPE },
                    { "rel": "collection", "href": collection_file(id), "type": JSON_MEDIA_TYPE },
                ],
            }),
        });
    }

    let mut links = vec![
        json!({ "rel": "root", "href": "catalog.json", "type": JSON_MEDIA_TYPE }),
        json!({ "rel": "self", "href": "catalog.json", "type": JSON_MEDIA_TYPE }),
    ];
    links.extend(child_links);

    documents.push(Document {
        path: "catalog.json".to_string(),
        body: json!({
            "type": "Catalog",
            "stac_version": STAC_VERSION,
            "id": CATALOG_ID,
            "title": "duck-geocoder のデータ",
            "description": "日本のオープン地理空間データをGeoParquetにしたもの。ブラウザからDuckDB-WASMで直接読む。",
            "links": links,
        }),
    });

    Ok(documents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Attribution;

    fn attribution() -> Attribution {
        Attribution {
            text: "「出典」（どこか）をもとに作成",
            url: "https://example.invalid/",
            license: "other",
            provider: "どこか",
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
            min_height_m: None,
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
        // **実データと同じディレクトリに置く。** ルートは catalog.json だけ。
        assert_eq!(children[0]["href"], "estat/estat-mesh-pop.json");

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
        assert_eq!(href(collection, "parent"), "../catalog.json");
        // 兄弟なのでファイル名だけ。
        assert_eq!(href(collection, "items"), "estat-mesh-pop-items.json");
        assert_eq!(href(collection, "self"), "estat-mesh-pop.json");

        assert_eq!(href(&items["features"][0], "root"), "../catalog.json");
        assert_eq!(
            href(&items["features"][0], "collection"),
            "estat-mesh-pop.json"
        );
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
        let documents = build(&vec![
            with_level("estat/a.parquet", Some(100.0)),
            with_level("estat/b.parquet", Some(100.0)),
        ])
        .unwrap();
        assert_eq!(find(&documents, "estat/estat-mesh-pop.json")[key], 100.0);

        // 片方に無い。**出さない。**
        let documents = build(&vec![
            with_level("estat/a.parquet", Some(100.0)),
            with_level("estat/b.parquet", None),
        ])
        .unwrap();
        assert!(find(&documents, "estat/estat-mesh-pop.json")[key].is_null());

        // 誤差が揃っていない。片方を代表値にすると、粗い方で細かいズームまで
        // 使ってしまう。**出さない。**
        let documents = build(&vec![
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
