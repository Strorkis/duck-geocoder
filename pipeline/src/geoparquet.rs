use anyhow::{Context, Result, bail};
use arrow::array::{ArrayRef, BinaryArray, Float64Array, RecordBatch, StructArray};
use arrow::datatypes::{DataType, Field, Fields, Schema};
use geo_traits::GeometryTrait;
use parquet::arrow::arrow_writer::ArrowWriter;
use parquet::file::metadata::KeyValue;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use wkb::writer::{WriteOptions, geometry_wkb_size, write_geometry};

/// GeoParquet 1.1 の `covering.bbox` が指す列。
/// 仕様上のパスは配列だが、ここでは `[構造体列, フィールド]` の2要素だけを扱う
/// (このパイプラインが書き出すものも Overture が配布しているものも2要素)。
#[derive(Debug, Clone, PartialEq)]
pub struct CoveringBbox {
    /// 4つのフィールドを持つ構造体列の名前。
    pub column: String,
    pub xmin: String,
    pub ymin: String,
    pub xmax: String,
    pub ymax: String,
}

/// `geo` メタデータから covering bbox 列の位置を読み取る。
///
/// 列名を決め打ちしないのは、この情報がファイル自身に書かれているため。
/// covering が無いファイルはエラーにする。無いということは、読み手が
/// ジオメトリ本体を読まずに絞り込む手段が無いということで、
/// 空間的な並べ替えをしても意味がない。
pub fn covering_bbox(geo_json: &str) -> Result<CoveringBbox> {
    let geo: serde_json::Value =
        serde_json::from_str(geo_json).context("`geo` メタデータがJSONとして読めない")?;

    let primary = geo
        .get("primary_column")
        .and_then(|v| v.as_str())
        .context("primary_column がない")?;
    let bbox = geo
        .get("columns")
        .and_then(|c| c.get(primary))
        .context("primary_column に対応する定義がない")?
        .get("covering")
        .and_then(|c| c.get("bbox"))
        .with_context(|| {
            format!("`{primary}` に covering.bbox がない (GeoParquet 1.1 の covering が必要)")
        })?;

    let mut column: Option<String> = None;
    let mut field = |name: &str| -> Result<String> {
        let path = bbox
            .get(name)
            .and_then(|v| v.as_array())
            .with_context(|| format!("covering.bbox.{name} がない"))?;
        let parts: Vec<&str> = path.iter().filter_map(|v| v.as_str()).collect();
        let [struct_name, field_name] = parts.as_slice() else {
            bail!("covering.bbox.{name} が [列名, フィールド名] の形ではない: {path:?}");
        };
        match &column {
            Some(existing) if existing != struct_name => {
                bail!("covering.bbox が複数の列にまたがっている: {existing} と {struct_name}")
            }
            _ => column = Some(struct_name.to_string()),
        }
        Ok(field_name.to_string())
    };

    let xmin = field("xmin")?;
    let ymin = field("ymin")?;
    let xmax = field("xmax")?;
    let ymax = field("ymax")?;

    Ok(CoveringBbox {
        column: column.expect("4つのフィールドを読めた時点で列名は決まっている"),
        xmin,
        ymin,
        xmax,
        ymax,
    })
}

/// GeoParquet 1.1 の `geo` メタデータJSONを組み立てる。
///
/// DuckDBの `COPY ... TO ... (FORMAT PARQUET)` は、GEOMETRY列があると自前で
/// `geo` を書くが、その内容はGeoParquet **1.0.0** で `covering` の宣言が落ちる。
/// coveringが無いとrow group統計での絞り込みができず、配信用の最適化
/// ([`crate::spatial_pack`]) も適用できないので、こちらで書いたものを
/// `KV_METADATA` で渡す (その際ジオメトリはBLOBとして書き、DuckDBに
/// `geo` を書かせないようにすること。両方書かれると `geo` キーが重複する)。
pub fn geo_metadata_json(
    primary_column: &str,
    covering: &CoveringBbox,
    geometry_types: &[String],
    bbox: [f64; 4],
) -> Result<String> {
    let path = |field: &str| serde_json::json!([covering.column, field]);
    let geo = serde_json::json!({
        "version": "1.1.0",
        "primary_column": primary_column,
        "columns": {
            primary_column: {
                "encoding": "WKB",
                "geometry_types": geometry_types,
                "bbox": bbox,
                "covering": {
                    "bbox": {
                        "xmin": path(&covering.xmin),
                        "ymin": path(&covering.ymin),
                        "xmax": path(&covering.xmax),
                        "ymax": path(&covering.ymax),
                    }
                }
            }
        }
    });
    serde_json::to_string(&geo).context("`geo` メタデータをJSONにできない")
}

/// DuckDBの `ST_GeometryType` が返す名前を、GeoParquetの `geometry_types` の
/// 表記に直す。知らない名前はエラーにする (綴りを推測して黙って通すと、
/// 読み手が種別で分岐したときに気付けない)。
pub fn geoparquet_geometry_type(duckdb_name: &str) -> Result<&'static str> {
    Ok(match duckdb_name.trim().to_ascii_uppercase().as_str() {
        "POINT" => "Point",
        "LINESTRING" => "LineString",
        "POLYGON" => "Polygon",
        "MULTIPOINT" => "MultiPoint",
        "MULTILINESTRING" => "MultiLineString",
        "MULTIPOLYGON" => "MultiPolygon",
        "GEOMETRYCOLLECTION" => "GeometryCollection",
        other => bail!("未知のジオメトリ種別: {other:?}"),
    })
}

/// 文字列1列分。値は必ず埋まっている前提 (行政区域コードなど欠損しない列用)。
pub fn utf8_column(name: &str, values: impl Iterator<Item = String>) -> (Field, ArrayRef) {
    let array: ArrayRef = Arc::new(arrow::array::StringArray::from_iter_values(values));
    (Field::new(name, DataType::Utf8, false), array)
}

/// 文字列1列分。NULLを許す (N03の支庁・郡・行政区名など、無い自治体があるため)。
pub fn utf8_nullable_column(
    name: &str,
    values: impl Iterator<Item = Option<String>>,
) -> (Field, ArrayRef) {
    let array: ArrayRef = Arc::new(arrow::array::StringArray::from_iter(values));
    (Field::new(name, DataType::Utf8, true), array)
}

/// 浮動小数点1列分。NULLを許す (PLATEAUの高さなど、欠けうる数値用)。
pub fn f64_nullable_column(
    name: &str,
    values: impl Iterator<Item = Option<f64>>,
) -> (Field, ArrayRef) {
    let array: ArrayRef = Arc::new(Float64Array::from_iter(values));
    (Field::new(name, DataType::Float64, true), array)
}

/// 整数1列分。NULLを許す (PLATEAUの階数など、「不明」がありうる数値用)。
pub fn i32_nullable_column(
    name: &str,
    values: impl Iterator<Item = Option<i32>>,
) -> (Field, ArrayRef) {
    let array: ArrayRef = Arc::new(arrow::array::Int32Array::from_iter(values));
    (Field::new(name, DataType::Int32, true), array)
}

/// ジオメトリの列から、WKBのバイナリ列と `covering.bbox` 用のstruct列を作る。
///
/// `bbox` はジオメトリ1件から外接矩形 `[xmin, ymin, xmax, ymax]` を求める関数。
/// PointとMultiPolygonで計算の仕方が違う (前者はそのまま、後者は全頂点を舐める)
/// ので、この関数自体はジオメトリの種類を問わないようにして呼び出し側から渡す。
///
/// 返り値の3つ目はファイル全体のbbox (`geo` メタデータの `bbox` に使う)。
pub fn geometry_columns<G: GeometryTrait<T = f64>>(
    geometries: &[G],
    bbox: impl Fn(&G) -> [f64; 4],
) -> Result<(ArrayRef, ArrayRef, [f64; 4])> {
    let mut wkb_values: Vec<Vec<u8>> = Vec::with_capacity(geometries.len());
    let mut xmin = Vec::with_capacity(geometries.len());
    let mut ymin = Vec::with_capacity(geometries.len());
    let mut xmax = Vec::with_capacity(geometries.len());
    let mut ymax = Vec::with_capacity(geometries.len());
    let mut file_bbox = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];

    for geom in geometries {
        let mut buf = Vec::with_capacity(geometry_wkb_size(geom));
        write_geometry(&mut buf, geom, &WriteOptions::default())
            .context("WKBの書き出しに失敗しました")?;
        wkb_values.push(buf);

        let [x0, y0, x1, y1] = bbox(geom);
        xmin.push(x0);
        ymin.push(y0);
        xmax.push(x1);
        ymax.push(y1);
        file_bbox[0] = file_bbox[0].min(x0);
        file_bbox[1] = file_bbox[1].min(y0);
        file_bbox[2] = file_bbox[2].max(x1);
        file_bbox[3] = file_bbox[3].max(y1);
    }

    let geometry_array: ArrayRef = Arc::new(BinaryArray::from_iter_values(
        wkb_values.iter().map(|v| v.as_slice()),
    ));

    let bbox_fields = Fields::from(vec![
        Field::new("xmin", DataType::Float64, false),
        Field::new("ymin", DataType::Float64, false),
        Field::new("xmax", DataType::Float64, false),
        Field::new("ymax", DataType::Float64, false),
    ]);
    let bbox_array: ArrayRef = Arc::new(StructArray::new(
        bbox_fields,
        vec![
            Arc::new(Float64Array::from(xmin)) as ArrayRef,
            Arc::new(Float64Array::from(ymin)) as ArrayRef,
            Arc::new(Float64Array::from(xmax)) as ArrayRef,
            Arc::new(Float64Array::from(ymax)) as ArrayRef,
        ],
        None,
    ));

    Ok((geometry_array, bbox_array, file_bbox))
}

/// 非ジオメトリ列とジオメトリ列 (`geometry_columns` で作ったもの) を合わせて
/// GeoParquetとして書き出す。圧縮はしない。空間的な並べ替えと圧縮は配信用の
/// 最適化 ([`crate::spatial_pack`] / `optimize_geoparquet`) の役目で、
/// ここでは変換直後の中間ファイルを書くだけでよい。
#[allow(clippy::too_many_arguments)]
pub fn write(
    path: &Path,
    other_columns: Vec<(Field, ArrayRef)>,
    primary_column: &str,
    geometry: ArrayRef,
    bbox: ArrayRef,
    geometry_types: &[String],
    file_bbox: [f64; 4],
) -> Result<()> {
    let mut fields: Vec<Field> = other_columns.iter().map(|(f, _)| f.clone()).collect();
    let mut arrays: Vec<ArrayRef> = other_columns.into_iter().map(|(_, a)| a).collect();

    fields.push(Field::new(primary_column, DataType::Binary, false));
    arrays.push(geometry);
    fields.push(Field::new("bbox", bbox.data_type().clone(), false));
    arrays.push(bbox);

    let schema = Arc::new(Schema::new(fields));
    let batch =
        RecordBatch::try_new(schema.clone(), arrays).context("RecordBatchの構築に失敗しました")?;

    let covering = CoveringBbox {
        column: "bbox".to_string(),
        xmin: "xmin".to_string(),
        ymin: "ymin".to_string(),
        xmax: "xmax".to_string(),
        ymax: "ymax".to_string(),
    };
    let geo_json = geo_metadata_json(primary_column, &covering, geometry_types, file_bbox)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("ディレクトリを作れません: {}", parent.display()))?;
    }
    let file = File::create(path).with_context(|| format!("作れません: {}", path.display()))?;
    let mut writer =
        ArrowWriter::try_new(file, schema, None).context("ArrowWriterの作成に失敗しました")?;
    writer.write(&batch).context("書き込みに失敗しました")?;
    writer.append_key_value_metadata(KeyValue::new("geo".to_string(), geo_json));
    writer.close().context("ファイルを閉じられません")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GEO: &str = r#"{
        "version": "1.1.0",
        "primary_column": "geometry",
        "columns": {
            "geometry": {
                "encoding": "WKB",
                "geometry_types": ["MultiPolygon"],
                "covering": { "bbox": {
                    "xmin": ["bbox", "xmin"],
                    "ymin": ["bbox", "ymin"],
                    "xmax": ["bbox", "xmax"],
                    "ymax": ["bbox", "ymax"]
                }},
                "bbox": [138.9, 35.1, 139.8, 35.6]
            }
        }
    }"#;

    #[test]
    fn reads_covering_bbox_paths() {
        let covering = covering_bbox(GEO).unwrap();
        assert_eq!(
            covering,
            CoveringBbox {
                column: "bbox".to_string(),
                xmin: "xmin".to_string(),
                ymin: "ymin".to_string(),
                xmax: "xmax".to_string(),
                ymax: "ymax".to_string(),
            }
        );
    }

    #[test]
    fn rejects_metadata_without_covering() {
        let without_covering = r#"{
            "version": "1.0.0",
            "primary_column": "geometry",
            "columns": { "geometry": { "encoding": "WKB" } }
        }"#;
        let err = covering_bbox(without_covering).unwrap_err();
        assert!(err.to_string().contains("covering"));
    }

    #[test]
    fn rejects_covering_spanning_multiple_columns() {
        let mixed = GEO.replace(r#"["bbox", "ymax"]"#, r#"["other", "ymax"]"#);
        assert!(covering_bbox(&mixed).is_err());
    }

    #[test]
    fn rejects_nested_covering_path() {
        let nested = GEO.replace(r#"["bbox", "xmin"]"#, r#"["a", "b", "c"]"#);
        assert!(covering_bbox(&nested).is_err());
    }

    // 書いたものを自分で読み戻せること。covering の宣言が本題なので、
    // ここが通らなければ配信用の最適化にかけられない。
    #[test]
    fn writes_metadata_that_can_be_read_back() {
        let covering = CoveringBbox {
            column: "bbox".to_string(),
            xmin: "xmin".to_string(),
            ymin: "ymin".to_string(),
            xmax: "xmax".to_string(),
            ymax: "ymax".to_string(),
        };
        let json = geo_metadata_json(
            "geometry",
            &covering,
            &["Polygon".to_string(), "MultiPolygon".to_string()],
            [122.0, 20.0, 154.0, 46.0],
        )
        .unwrap();

        assert_eq!(covering_bbox(&json).unwrap(), covering);

        // カタログ生成が読む項目も入っていること。
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let column = &value["columns"]["geometry"];
        assert_eq!(value["version"], "1.1.0");
        assert_eq!(column["geometry_types"][1], "MultiPolygon");
        assert_eq!(column["bbox"][0], 122.0);
    }

    #[test]
    fn maps_duckdb_geometry_type_names() {
        assert_eq!(geoparquet_geometry_type("POLYGON").unwrap(), "Polygon");
        assert_eq!(
            geoparquet_geometry_type("MULTIPOLYGON").unwrap(),
            "MultiPolygon"
        );
        assert_eq!(geoparquet_geometry_type("Point").unwrap(), "Point");
    }

    #[test]
    fn rejects_unknown_geometry_type() {
        assert!(geoparquet_geometry_type("TRIANGLE").is_err());
    }

    // write() が実際に書いたファイルのスキーマと `geo` メタデータを確かめる。
    // 3つの変換器 (isj_oaza / isj_block / n03) が同じ関数を経由するので、
    // ここで型と列順を固定しておけば、既存の配信ファイルとの互換が壊れたときに気付ける。
    #[test]
    fn writes_points_with_expected_schema_and_readable_geo_metadata() {
        use geo_types::Point;
        use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

        let points = vec![Point::new(139.0, 35.0), Point::new(140.0, 36.0)];
        let (geometry, bbox, file_bbox) =
            geometry_columns(&points, |p| [p.x(), p.y(), p.x(), p.y()]).unwrap();
        let columns = vec![utf8_column(
            "name",
            vec!["a".to_string(), "b".to_string()].into_iter(),
        )];

        let path = std::env::temp_dir().join("duck_geocoder_test_geoparquet_write_points.parquet");
        write(
            &path,
            columns,
            "geometry",
            geometry,
            bbox,
            &["Point".to_string()],
            file_bbox,
        )
        .unwrap();

        let file = File::open(&path).unwrap();
        let builder = ParquetRecordBatchReaderBuilder::try_new(file).unwrap();
        let schema = builder.schema();

        let field = |name: &str| schema.field_with_name(name).unwrap();
        assert_eq!(field("name").data_type(), &DataType::Utf8);
        assert_eq!(field("geometry").data_type(), &DataType::Binary);
        match field("bbox").data_type() {
            DataType::Struct(fields) => {
                let names: Vec<&str> = fields.iter().map(|f| f.name().as_str()).collect();
                assert_eq!(names, vec!["xmin", "ymin", "xmax", "ymax"]);
                assert!(fields.iter().all(|f| f.data_type() == &DataType::Float64));
            }
            other => panic!("bboxはstructのはず: {other:?}"),
        }

        let geo_json = builder
            .metadata()
            .file_metadata()
            .key_value_metadata()
            .unwrap()
            .iter()
            .find(|kv| kv.key == "geo")
            .and_then(|kv| kv.value.clone())
            .unwrap();
        let covering = covering_bbox(&geo_json).unwrap();
        assert_eq!(covering.column, "bbox");

        std::fs::remove_file(&path).ok();
    }
}
