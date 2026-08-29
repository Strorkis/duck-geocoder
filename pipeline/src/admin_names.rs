/// 行政区域データセットから、検索に使う名称だけを抜き出すSQLを組み立てる。
///
/// UIは地名検索のために全行政区域の名称を必要とするが、これを行政区域の
/// GeoParquetから直接引くと、HTTP越しでは極端に遅くなる。名称の列は
/// 合計65KB程度しかないのに、64MBのファイル全体に row group の数だけ
/// 散らばっているためで、実測では42回のRangeリクエストと約24秒を要した。
/// 転送量ではなく往復回数の問題なので、まとまった小さなファイルに分ける。
///
/// ジオメトリを持たないので、これはGeoParquetではなく素のParquetになる。
pub fn build_extract_sql(input: &str, output: &str) -> String {
    format!(
        "COPY (
  SELECT DISTINCT
    admin_id,
    pref_name,
    coalesce(county_name, '') AS county_name,
    coalesce(city_name, '') AS city_name,
    coalesce(ward_name, '') AS ward_name
  FROM read_parquet('{input}')
  ORDER BY pref_name, county_name, city_name, ward_name
) TO '{output}' (FORMAT PARQUET);"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_the_columns_used_for_search() {
        let sql = build_extract_sql("/tmp/admin.parquet", "/tmp/names.parquet");

        assert!(sql.contains("SELECT DISTINCT"));
        for column in [
            "admin_id",
            "pref_name",
            "county_name",
            "city_name",
            "ward_name",
        ] {
            assert!(sql.contains(column), "{column} が無い");
        }
        // ジオメトリを含めると小さくならないので、入れないこと。
        assert!(!sql.contains("geometry"));
        assert!(!sql.contains("bbox"));
    }

    // UIは連結した名称に対して部分一致を取るので、NULLが混ざると
    // その行が丸ごと一致しなくなる。空文字にしておく。
    #[test]
    fn replaces_missing_names_with_empty_strings() {
        let sql = build_extract_sql("/tmp/admin.parquet", "/tmp/names.parquet");

        for column in ["county_name", "city_name", "ward_name"] {
            assert!(
                sql.contains(&format!("coalesce({column}, '') AS {column}")),
                "{column} がNULLのままになる"
            );
        }
    }

    #[test]
    fn embeds_input_and_output() {
        let sql = build_extract_sql("/tmp/admin.parquet", "/tmp/names.parquet");
        assert!(sql.contains("read_parquet('/tmp/admin.parquet')"));
        assert!(sql.contains("TO '/tmp/names.parquet'"));
    }
}
