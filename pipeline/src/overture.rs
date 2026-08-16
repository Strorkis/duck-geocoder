use anyhow::{Context, Result, bail};

/// Overtureのリリース。更新する場合は https://docs.overturemaps.org/release/ を確認する。
pub const DEFAULT_RELEASE: &str = "2026-07-22.0";

/// 切り出す範囲 (WGS84)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoundingBox {
    pub xmin: f64,
    pub ymin: f64,
    pub xmax: f64,
    pub ymax: f64,
}

impl BoundingBox {
    pub fn parse(xmin: &str, ymin: &str, xmax: &str, ymax: &str) -> Result<Self> {
        let parse_one = |label: &str, value: &str| -> Result<f64> {
            value
                .parse::<f64>()
                .with_context(|| format!("{label} が数値として読めません: {value:?}"))
        };
        let bbox = Self {
            xmin: parse_one("xmin", xmin)?,
            ymin: parse_one("ymin", ymin)?,
            xmax: parse_one("xmax", xmax)?,
            ymax: parse_one("ymax", ymax)?,
        };
        if bbox.xmin >= bbox.xmax || bbox.ymin >= bbox.ymax {
            bail!("範囲が不正です (min >= max): {bbox:?}");
        }
        Ok(bbox)
    }
}

/// Overtureの建物を切り出すSQLを組み立てる。
///
/// Overtureは最初からGeoParquetで配布されているので、こちらでの変換は不要。
/// DuckDBがS3から直接読み、必要な範囲だけを書き出す
/// (ブラウザのDuckDB-WASMはhttpfs拡張を持たないため、この切り出しは手元で行う)。
pub fn build_extract_sql(release: &str, bbox: BoundingBox, output: &str) -> String {
    let BoundingBox {
        xmin,
        ymin,
        xmax,
        ymax,
    } = bbox;
    format!(
        "INSTALL spatial; LOAD spatial;
INSTALL httpfs; LOAD httpfs;
SET s3_region='us-west-2';
COPY (
  SELECT
    id,
    names.primary AS name,
    class,
    subtype,
    height,
    num_floors,
    geometry
  FROM read_parquet(
    's3://overturemaps-us-west-2/release/{release}/theme=buildings/type=building/*',
    hive_partitioning=1
  )
  WHERE bbox.xmin BETWEEN {xmin} AND {xmax}
    AND bbox.ymin BETWEEN {ymin} AND {ymax}
) TO '{output}' (FORMAT PARQUET);"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bbox() {
        let bbox = BoundingBox::parse("139.73", "35.63", "139.78", "35.68").unwrap();
        assert_eq!(bbox.xmin, 139.73);
        assert_eq!(bbox.ymax, 35.68);
    }

    #[test]
    fn rejects_inverted_bbox() {
        assert!(BoundingBox::parse("139.78", "35.63", "139.73", "35.68").is_err());
    }

    #[test]
    fn rejects_non_numeric_bbox() {
        assert!(BoundingBox::parse("east", "35.63", "139.78", "35.68").is_err());
    }

    #[test]
    fn embeds_release_bbox_and_output_in_sql() {
        let bbox = BoundingBox::parse("139.73", "35.63", "139.78", "35.68").unwrap();
        let sql = build_extract_sql("2026-07-22.0", bbox, "/tmp/out.parquet");
        assert!(sql.contains("release/2026-07-22.0/theme=buildings"));
        assert!(sql.contains("bbox.xmin BETWEEN 139.73 AND 139.78"));
        assert!(sql.contains("bbox.ymin BETWEEN 35.63 AND 35.68"));
        assert!(sql.contains("TO '/tmp/out.parquet'"));
    }
}
