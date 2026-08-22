use anyhow::{Context, Result, bail};

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
}
