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
}
