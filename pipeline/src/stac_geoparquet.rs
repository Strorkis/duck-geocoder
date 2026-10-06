//! STAC の Item を **stac-geoparquet** (STAC GeoParquet 1.1.0) にまとめて書く。
//!
//! 以前は Collection ごとに ItemCollection の JSON を置いていた (15個、合わせて約1.4MB。
//! PLATEAU 306都市で 607KB、Overture の建物で 711KB)。これを**1つの Parquet** にまとめる。
//!
//! - **使う Collection の分だけ読む。** Collection ごとに行グループを分けて書く (`flush`)。
//!   `collection` 列の統計で行グループを読み飛ばせるので、DuckDB の `WHERE collection = …` は
//!   その Collection の行グループだけを Range で取る。JSON のときの「使わないデータの Item は
//!   起動時に読まない」(E2E のテスト) がそのまま保てる
//! - **小さい。** 同じ文字列 (リンク・型・拡張の URL) が並ぶので、圧縮がよく効く。
//!   フッターも削る (統計は読み飛ばしに使う列だけ。`write` のコメント)
//!
//! 仕様: <https://github.com/radiantearth/stac-geoparquet-spec>。`properties` の中身は
//! 最上位の列に出し、`datetime` はタイムスタンプ、ジオメトリは WKB (GeoParquet 1.1)。
//! ファイルのメタデータ `stac-geoparquet` には版だけを書く。仕様は Collection の JSON を
//! 入れることも勧めているが、**入れない** — 行グループを1つ読むたびにフッターを読むので、
//! Collection 32個ぶん (数十KB) がその都度ついてくる。Collection は別の JSON にある。
//!
//! **相対リンクとアセットの href は、この Parquet の置き場所 (配信の起点) からの相対。**
//!
//! STAC Browser はこの形を読めない (Item の一覧が出なくなる)。Collection の JSON は
//! 文書ごとに残すので、Collection までは辿れる。
use crate::geoparquet::{CoveringBbox, geo_metadata_json};
use anyhow::{Context, Result, bail};
use arrow::array::{ArrayRef, BinaryArray, Float64Array, RecordBatch, StructArray};
use arrow::buffer::NullBuffer;
use arrow::datatypes::{DataType, Field, Fields, Schema, TimeUnit};
use parquet::arrow::arrow_writer::{ArrowWriter, ArrowWriterOptions};
use parquet::basic::{Compression, ZstdLevel};
use parquet::file::metadata::KeyValue;
use parquet::file::properties::{EnabledStatistics, WriterProperties};
use parquet::schema::types::ColumnPath;
use serde_json::{Value, json};
use std::fs::File;
use std::path::Path;
use std::sync::Arc;

/// まとめた Item の置き場所 (配信の起点からのパス)。
pub const ITEMS_FILE: &str = "items.parquet";
/// stac-geoparquet の仕様の版。
const SPEC_VERSION: &str = "1.1.0";

/// 文字列のリスト。
fn utf8_list() -> DataType {
    DataType::List(Arc::new(Field::new("item", DataType::Utf8, true)))
}

/// ジオメトリと bbox 以外の列 (JSON から arrow に読む)。**Item の `properties` は最上位へ出す。**
fn json_fields() -> Vec<Field> {
    let asset = Fields::from(vec![
        Field::new("href", DataType::Utf8, false),
        Field::new("type", DataType::Utf8, true),
        Field::new("title", DataType::Utf8, true),
        Field::new("roles", utf8_list(), true),
    ]);
    let link = Fields::from(vec![
        Field::new("href", DataType::Utf8, false),
        Field::new("rel", DataType::Utf8, false),
        Field::new("type", DataType::Utf8, true),
        Field::new("title", DataType::Utf8, true),
    ]);
    vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("collection", DataType::Utf8, false),
        Field::new("stac_version", DataType::Utf8, false),
        Field::new("stac_extensions", utf8_list(), false),
        // 仕様は datetime をタイムスタンプで持つよう求めている。いまは時点を読んでいないので空。
        Field::new(
            "datetime",
            // 名前 ("UTC") だと arrow の chrono-tz が要るので、時差で書く (意味は同じ)。
            DataType::Timestamp(TimeUnit::Microsecond, Some("+00:00".into())),
            true,
        ),
        Field::new("table:row_count", DataType::Int64, true),
        Field::new("duck:geometry_types", utf8_list(), true),
        Field::new("duck:source_lod", DataType::Utf8, true),
        Field::new(
            "assets",
            DataType::Struct(Fields::from(vec![Field::new(
                "data",
                DataType::Struct(asset),
                false,
            )])),
            false,
        ),
        Field::new(
            "links",
            DataType::List(Arc::new(Field::new("item", DataType::Struct(link), true))),
            false,
        ),
    ]
}

/// Item (STAC の JSON) を、列の形の行 (`properties` を最上位へ出したもの) にする。
fn flatten(item: &Value) -> Result<Value> {
    let properties = item["properties"]
        .as_object()
        .context("Item に properties がありません")?;
    let known = [
        "datetime",
        "table:row_count",
        "duck:geometry_types",
        "duck:source_lod",
    ];
    if let Some(unknown) = properties.keys().find(|key| !known.contains(&key.as_str())) {
        // **黙って落とさない。** 新しい項目を Item に足したら、ここの列にも足すこと。
        bail!(
            "stac-geoparquet の列に無い properties があります: {unknown} (stac_geoparquet.rs に足すこと)"
        );
    }
    let mut row = json!({
        "id": item["id"],
        "collection": item["collection"],
        "stac_version": item["stac_version"],
        "stac_extensions": item["stac_extensions"],
        "assets": item["assets"],
        "links": item["links"],
    });
    for key in known {
        row[key] = properties.get(key).cloned().unwrap_or(Value::Null);
    }
    Ok(row)
}

/// bbox を範囲の矩形 (WKB の Polygon) にする。
fn bbox_wkb([west, south, east, north]: [f64; 4]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(93);
    buf.push(1); // リトルエンディアン
    buf.extend_from_slice(&3u32.to_le_bytes()); // Polygon
    buf.extend_from_slice(&1u32.to_le_bytes()); // 環は1つ
    buf.extend_from_slice(&5u32.to_le_bytes()); // 点は5つ (閉じる)
    for (x, y) in [
        (west, south),
        (east, south),
        (east, north),
        (west, north),
        (west, south),
    ] {
        buf.extend_from_slice(&x.to_le_bytes());
        buf.extend_from_slice(&y.to_le_bytes());
    }
    buf
}

/// Item の bbox。**範囲を持たないもの** (名称だけのデータセット) は `None`。
fn item_bbox(item: &Value) -> Option<[f64; 4]> {
    let values = item["bbox"].as_array()?;
    let numbers: Vec<f64> = values.iter().filter_map(Value::as_f64).collect();
    <[f64; 4]>::try_from(numbers).ok()
}

/// 1つの Collection の Item を、1つの RecordBatch にする。
fn batch(items: &[&Value], schema: &Arc<Schema>) -> Result<RecordBatch> {
    let rows = items
        .iter()
        .map(|item| flatten(item))
        .collect::<Result<Vec<_>>>()?;
    let json_schema = Arc::new(Schema::new(json_fields()));
    let mut decoder = arrow::json::ReaderBuilder::new(json_schema)
        .build_decoder()
        .context("JSON の読み手を作れません")?;
    decoder.serialize(&rows).context("Item を列にできません")?;
    let decoded = decoder.flush()?.context("Item が1件もありません")?;

    let boxes: Vec<Option<[f64; 4]>> = items.iter().map(|item| item_bbox(item)).collect();
    let geometry: ArrayRef = Arc::new(BinaryArray::from_iter(
        boxes.iter().map(|b| b.map(bbox_wkb)),
    ));
    let coordinate = |index: usize| -> ArrayRef {
        Arc::new(Float64Array::from_iter(
            boxes.iter().map(|b| b.map(|b| b[index])),
        ))
    };
    let bbox: ArrayRef = Arc::new(StructArray::try_new(
        bbox_fields(),
        vec![coordinate(0), coordinate(1), coordinate(2), coordinate(3)],
        Some(NullBuffer::from_iter(boxes.iter().map(Option::is_some))),
    )?);

    let mut columns = decoded.columns().to_vec();
    columns.push(geometry);
    columns.push(bbox);
    RecordBatch::try_new(schema.clone(), columns).context("RecordBatch を組み立てられません")
}

fn bbox_fields() -> Fields {
    Fields::from(
        ["xmin", "ymin", "xmax", "ymax"]
            .map(|name| Field::new(name, DataType::Float64, true))
            .to_vec(),
    )
}

/// Item を stac-geoparquet にして書く。**Collection ごとに行グループを分ける。**
///
/// **Item の多い Collection を前に、少ないものを後ろ (フッターの隣) に置く。** 読む側
/// (DuckDB-WASM) は 16KB のブロック単位で取り、取ったブロックは使い回す。起動時に要るのは
/// 行政区域や整備範囲のような1〜2件の Collection なので、フッターと同じブロックに入れておけば
/// 読み足さずに済む。件数が同じなら渡された順。
pub fn write(path: &Path, items: &[Value]) -> Result<()> {
    let mut fields = json_fields();
    fields.push(Field::new("geometry", DataType::Binary, true));
    fields.push(Field::new("bbox", DataType::Struct(bbox_fields()), true));
    let schema = Arc::new(Schema::new(fields));

    // Collection ごとに束ねる (出てきた順を保つ)。
    let mut groups: Vec<(String, Vec<&Value>)> = Vec::new();
    for item in items {
        let collection = item["collection"]
            .as_str()
            .context("Item に collection がありません")?;
        match groups.last_mut() {
            Some((id, members)) if id == collection => members.push(item),
            _ => {
                if groups.iter().any(|(id, _)| id == collection) {
                    bail!(
                        "{collection} の Item が離れて並んでいます (Collection ごとにまとめて渡すこと)"
                    );
                }
                groups.push((collection.to_string(), vec![item]));
            }
        }
    }
    // 安定な並べ替えなので、件数が同じものは渡された順のまま。
    groups.sort_by_key(|(_, members)| std::cmp::Reverse(members.len()));

    let mut file_bbox = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for [west, south, east, north] in items.iter().filter_map(item_bbox) {
        file_bbox = [
            file_bbox[0].min(west),
            file_bbox[1].min(south),
            file_bbox[2].max(east),
            file_bbox[3].max(north),
        ];
    }
    let covering = CoveringBbox {
        column: "bbox".to_string(),
        xmin: "xmin".to_string(),
        ymin: "ymin".to_string(),
        xmax: "xmax".to_string(),
        ymax: "ymax".to_string(),
    };
    let geo = geo_metadata_json("geometry", &covering, &["Polygon".to_string()], file_bbox)?;

    let file = File::create(path).with_context(|| format!("作れません: {}", path.display()))?;
    let mut properties = WriterProperties::builder()
        .set_compression(Compression::ZSTD(ZstdLevel::try_new(3)?))
        // **フッターを小さくする。** 行グループ15 × 列21 で列の情報が300を超え、
        // 何もしないとフッターだけで44KB (ファイルの3分の1) あった。起動時はフッターを必ず読む。
        // - 統計は読み飛ばしに使う列 (collection と bbox) にだけ付ける。href などの長い文字列の
        //   最小・最大は使い道がないのに、行グループごとに2つずつ並ぶ
        // - 辞書は付けない。行グループが数件しかなく、辞書のページの分だけ大きくなる
        // - ページの索引 (offset index) は書かない。行グループに1ページしかないので使い道がない
        .set_statistics_enabled(EnabledStatistics::None)
        .set_dictionary_enabled(false)
        .set_offset_index_disabled(true);
    // 列の道筋は要素ごとに分けて渡す (`"bbox.xmin"` と書くと、その名前の1つの列と読まれる)。
    let mut stats_columns = vec![ColumnPath::new(vec!["collection".to_string()])];
    for corner in ["xmin", "ymin", "xmax", "ymax"] {
        stats_columns.push(ColumnPath::new(vec![
            "bbox".to_string(),
            corner.to_string(),
        ]));
    }
    for column in stats_columns {
        properties = properties.set_column_statistics_enabled(column, EnabledStatistics::Chunk);
    }
    // arrow の型 (ARROW:schema, 2KB) もフッターに入るが、読む側は Parquet の型で足りる。
    let options = ArrowWriterOptions::new()
        .with_properties(properties.build())
        .with_skip_arrow_metadata(true);
    let mut writer = ArrowWriter::try_new_with_options(file, schema.clone(), options)?;
    for (_, members) in &groups {
        writer.write(&batch(members, &schema)?)?;
        // **ここで行グループを閉じる。** 1つの行グループに1つの Collection だけが入るので、
        // `collection` 列の統計 (最小・最大) で、ほかの Collection の行グループを読み飛ばせる。
        writer.flush()?;
    }
    writer.append_key_value_metadata(KeyValue::new("geo".to_string(), geo));
    writer.append_key_value_metadata(KeyValue::new(
        "stac-geoparquet".to_string(),
        json!({ "version": SPEC_VERSION }).to_string(),
    ));
    writer.close().context("ファイルを閉じられません")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use parquet::file::reader::{FileReader, SerializedFileReader};

    fn item(id: &str, collection: &str, bbox: Option<[f64; 4]>) -> Value {
        json!({
            "type": "Feature",
            "stac_version": "1.1.0",
            "stac_extensions": ["https://stac-extensions.github.io/table/v1.2.0/schema.json"],
            "id": id,
            "collection": collection,
            "bbox": bbox,
            "geometry": null,
            "properties": { "datetime": null, "table:row_count": 3, "duck:geometry_types": ["Polygon"] },
            "assets": { "data": { "href": format!("x/{id}.parquet"), "type": "application/vnd.apache.parquet", "roles": ["data"] } },
            "links": [{ "rel": "collection", "href": format!("x/{collection}.json"), "type": "application/json" }],
        })
    }

    /// **Collection ごとに行グループが分かれる。** 読み飛ばしはこれで効く。
    /// Item の多いものが前、少ないものが後ろ (フッターの隣)。
    #[test]
    fn writes_one_row_group_per_collection() {
        let dir = std::env::temp_dir().join(format!("stac-geoparquet-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("items.parquet");
        let items = vec![
            item("s1", "small", None),
            item("a1", "a", Some([139.0, 35.0, 140.0, 36.0])),
            item("a2", "a", Some([140.0, 35.0, 141.0, 36.0])),
        ];
        write(&path, &items).unwrap();

        let reader = SerializedFileReader::new(File::open(&path).unwrap()).unwrap();
        let metadata = reader.metadata();
        assert_eq!(metadata.num_row_groups(), 2);
        assert_eq!(metadata.row_group(0).num_rows(), 2);
        assert_eq!(metadata.row_group(1).num_rows(), 1);

        // 統計は読み飛ばしに使う列にだけ (フッターを小さくするため)。
        let stats = |group: usize, path: &str| {
            metadata
                .row_group(group)
                .columns()
                .iter()
                .find(|column| column.column_path().string() == path)
                .unwrap_or_else(|| panic!("{path} がありません"))
                .statistics()
                .is_some()
        };
        assert!(stats(0, "collection") && stats(1, "collection"));
        assert!(stats(0, "bbox.xmin"));
        assert!(!stats(0, "id") && !stats(0, "assets.data.href"));

        let keys: Vec<&str> = metadata
            .file_metadata()
            .key_value_metadata()
            .unwrap()
            .iter()
            .map(|entry| entry.key.as_str())
            .collect();
        assert_eq!(keys, ["geo", "stac-geoparquet"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_properties_without_a_column() {
        let mut odd = item("a1", "a", None);
        odd["properties"]["duck:new_field"] = json!(1);
        let message = flatten(&odd).unwrap_err().to_string();
        assert!(message.contains("duck:new_field"), "{message}");
    }

    #[test]
    fn rejects_collections_split_apart() {
        let path = std::env::temp_dir().join(format!(
            "stac-geoparquet-split-{}.parquet",
            std::process::id()
        ));
        let items = vec![
            item("a1", "a", None),
            item("b1", "b", None),
            item("a2", "a", None),
        ];
        assert!(write(&path, &items).is_err());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn bbox_becomes_a_closed_polygon() {
        let wkb = bbox_wkb([1.0, 2.0, 3.0, 4.0]);
        assert_eq!(wkb.len(), 1 + 4 + 4 + 4 + 5 * 16);
        assert_eq!(&wkb[1..5], &3u32.to_le_bytes());
    }
}
