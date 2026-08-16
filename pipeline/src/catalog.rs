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
    /// 出典。
    pub source: String,
    /// ジオメトリの種類 (Point / MultiPolygon など)。UIの表示方法がこれで決まる。
    pub geometry_types: Vec<String>,
    /// 収録範囲 [xmin, ymin, xmax, ymax] (WGS84)。
    pub bbox: Option<[f64; 4]>,
    pub row_count: i64,
    pub columns: Vec<ColumnEntry>,
}

/// データセットの種別。ジオメトリの型と用途が種別ごとに決まる。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DatasetKind {
    /// 行政区域 (面)。ハイライトや逆ジオコーディングに使う。
    Admin,
    /// 大字・町丁目 (点)。住所検索に使う。
    Oaza,
    /// 街区 (点)。より細かい住所検索に使う。
    Block,
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

/// ファイル名からデータセットの素性を引く。
/// 変換バイナリの出力名 (n03_*.parquet など) と対応している。
fn describe(file_stem: &str) -> Option<(DatasetKind, &'static str, &'static str)> {
    if file_stem.starts_with("n03") {
        Some((
            DatasetKind::Admin,
            "行政区域",
            "国土数値情報 行政区域データ (N03)",
        ))
    } else if file_stem.starts_with("isj_oaza") {
        Some((
            DatasetKind::Oaza,
            "大字・町丁目",
            "位置参照情報 (大字・町丁目レベル)",
        ))
    } else if file_stem.starts_with("isj_block") {
        Some((DatasetKind::Block, "街区", "位置参照情報 (街区レベル)"))
    } else {
        None
    }
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

    let (kind, title, source) =
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
        .and_then(|entry| entry.value.as_deref())
        .with_context(|| format!("GeoParquetの `geo` メタデータがありません: {file_name}"))?;
    let (geometry_types, bbox) = read_geo_metadata(geo_json)?;

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
        kind,
        title: title.to_string(),
        source: source.to_string(),
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
        assert_eq!(describe("n03_all").unwrap().0, DatasetKind::Admin);
        assert_eq!(describe("isj_oaza_13").unwrap().0, DatasetKind::Oaza);
        assert_eq!(describe("isj_block_14").unwrap().0, DatasetKind::Block);
        assert!(describe("unknown_data").is_none());
    }
}
