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
    -- 表示範囲での絞り込みに使う covering 列。
    -- これを落とすと、あとで毎回ジオメトリ本体を評価する羽目になる。
    bbox,
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

/// 日本を含む範囲 (WGS84)。南は波照間島、北は択捉島、東は南鳥島、西は与那国島を含む。
/// ここには台湾やロシアの一部も入るので、国の絞り込みと併用すること。
pub const JAPAN_BBOX: BoundingBox = BoundingBox {
    xmin: 122.0,
    ymin: 20.0,
    xmax: 154.0,
    ymax: 46.0,
};

/// Overtureの行政区域 (divisions) から1つの国の分を切り出すSQLを組み立てる。
///
/// `subtype` では絞り込まない。どの粒度を採用するかは手元のファイルを見てから
/// 決めたいので、取得は1回で済ませ、絞り込みはローカルでやり直せるようにしておく。
///
/// 都道府県名は `subtype='region'` の行を同じスキャン内で結合して付ける
/// (CTEを MATERIALIZED にしてあるので、S3を2回読みには行かない)。
pub fn build_divisions_extract_sql(
    release: &str,
    country: &str,
    bbox: BoundingBox,
    output: &str,
) -> String {
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
  WITH divisions AS MATERIALIZED (
    SELECT
      id,
      names.primary AS name,
      subtype,
      region,
      -- 表示範囲での絞り込みに使う covering 列。
      bbox,
      geometry
    FROM read_parquet(
      's3://overturemaps-us-west-2/release/{release}/theme=divisions/type=division_area/*',
      hive_partitioning=1
    )
    -- covering列で先に絞る。これがrow groupの読み飛ばしに効くので、
    -- 国名だけで絞るより取得量がずっと小さくなる。
    -- 範囲の交差判定ではなく xmin が範囲内という条件にしているのは、
    -- 交差判定だと「この経度より東の全row group」が通ってしまい枝刈りが効かないため。
    WHERE bbox.xmin BETWEEN {xmin} AND {xmax}
      AND bbox.ymin BETWEEN {ymin} AND {ymax}
      -- bboxには近隣国も入るので、国で正確に絞る。
      AND country = '{country}'
      -- class='land' で海域の区画を落とす。
      AND class = 'land'
  ),
  regions AS (
    SELECT region, name FROM divisions WHERE subtype = 'region'
  )
  SELECT
    divisions.id,
    divisions.name,
    divisions.subtype,
    divisions.region,
    regions.name AS pref_name,
    divisions.bbox,
    divisions.geometry
  FROM divisions LEFT JOIN regions USING (region)
) TO '{output}' (FORMAT PARQUET);"
    )
}

/// 切り出したdivisionsから市区町村にあたる行を選ぶ条件。
///
/// Overtureの `locality` は市区町村(1,741)に郡(370)とOSM由来の雑多な地名を
/// 加えたもの。郡が混ざると1点が市区町村と郡の両方にヒットして逆ジオコーディングが
/// 壊れるので、接尾辞で絞る。日本の市区町村は必ず市・町・村・区で終わり、
/// この条件で残るのはちょうど1,741件で市区町村の総数と一致する
/// (郡は「郡」または「郡(十勝国)」のように終わるので外れる)。
///
/// なお `county` サブタイプは同じ市区町村のローマ字表記なので使わない。
const MUNICIPALITY_FILTER: &str = "subtype = 'locality' AND name SIMILAR TO '.*(市|町|村|区)'";

/// 市区町村の収録範囲とジオメトリ種別を求めるSQL。`geo` メタデータに書く値を、
/// 決め打ちではなく実データから取るために使う。
pub fn build_admin_stats_sql(input: &str) -> String {
    format!(
        "INSTALL spatial; LOAD spatial;
SELECT
  min(bbox.xmin) AS xmin,
  min(bbox.ymin) AS ymin,
  max(bbox.xmax) AS xmax,
  max(bbox.ymax) AS ymax,
  -- ST_GeometryType は列挙型を返すので、そのままだとJSONにできない。
  list_sort(list_distinct(list(ST_GeometryType(geometry)::VARCHAR))) AS geometry_types
FROM read_parquet('{input}')
WHERE {MUNICIPALITY_FILTER};"
    )
}

/// 切り出したdivisionsから、行政区域データセットを組み立てるSQL。
///
/// 列名は国土数値情報(N03)から作るものと揃えてある。出所が変わってもUIを
/// 書き換えずに済むようにするため。Overtureには郡と政令指定都市の行政区が
/// 独立した区画として無いので、`county_name` と `ward_name` はNULLになる
/// (列自体は残す。将来N03が加わったときに形が揃っている必要があるため)。
///
/// ジオメトリをBLOBとして書くのは、DuckDBに `geo` メタデータを書かせないため。
/// DuckDBが書くものはGeoParquet 1.0.0で `covering` の宣言が落ちるうえ、
/// `KV_METADATA` と併用すると `geo` キーが2つ並んでしまう。
pub fn build_admin_sql(input: &str, output: &str, geo_metadata_json: &str) -> String {
    let escaped = geo_metadata_json.replace('\'', "''");
    format!(
        "INSTALL spatial; LOAD spatial;
COPY (
  SELECT
    id AS admin_id,
    pref_name,
    NULL::VARCHAR AS county_name,
    name AS city_name,
    NULL::VARCHAR AS ward_name,
    bbox,
    ST_AsWKB(geometry)::BLOB AS geometry
  FROM read_parquet('{input}')
  WHERE {MUNICIPALITY_FILTER}
) TO '{output}' (FORMAT PARQUET, KV_METADATA {{ geo: '{escaped}' }});"
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
        // 表示範囲での絞り込みに必要なので、bbox列を落とさないこと。
        assert!(sql.contains("    bbox,\n"));
    }

    #[test]
    fn divisions_sql_filters_by_covering_bbox_and_country() {
        let sql = build_divisions_extract_sql("2026-07-22.0", "JP", JAPAN_BBOX, "/tmp/div.parquet");

        assert!(sql.contains("theme=divisions/type=division_area"));
        // covering列での絞り込みが無いと、row groupを読み飛ばせず取得量が跳ね上がる。
        assert!(sql.contains("bbox.xmin BETWEEN 122 AND 154"));
        assert!(sql.contains("bbox.ymin BETWEEN 20 AND 46"));
        assert!(sql.contains("country = 'JP'"));
        assert!(sql.contains("class = 'land'"));
        assert!(sql.contains("TO '/tmp/div.parquet'"));
    }

    // 粒度は手元で確かめてから決めるので、取得の時点では subtype を絞らない。
    // subtype への言及は、都道府県名を付ける自己結合の1箇所だけであるべき。
    #[test]
    fn divisions_sql_filters_by_subtype_only_for_the_region_join() {
        let sql = build_divisions_extract_sql("2026-07-22.0", "JP", JAPAN_BBOX, "/tmp/div.parquet");
        assert_eq!(sql.matches("subtype = ").count(), 1);
        assert!(sql.contains("subtype = 'region'"));
    }

    // S3を2回読まないよう、CTEは MATERIALIZED にしておく。
    #[test]
    fn divisions_sql_materializes_the_scan() {
        let sql = build_divisions_extract_sql("2026-07-22.0", "JP", JAPAN_BBOX, "/tmp/div.parquet");
        assert!(sql.contains("WITH divisions AS MATERIALIZED"));
    }

    // 統計と書き出しが別の条件で行を選ぶと、メタデータに書く収録範囲が
    // 実際の中身とずれる。同じ条件を使っていることを固定する。
    #[test]
    fn admin_stats_and_output_select_the_same_rows() {
        let stats = build_admin_stats_sql("/tmp/div.parquet");
        let copy = build_admin_sql("/tmp/div.parquet", "/tmp/admin.parquet", "{}");

        assert!(stats.contains(MUNICIPALITY_FILTER));
        assert!(copy.contains(MUNICIPALITY_FILTER));
    }

    #[test]
    fn admin_sql_maps_columns_to_the_shared_schema() {
        let sql = build_admin_sql("/tmp/div.parquet", "/tmp/admin.parquet", "{}");

        assert!(sql.contains("id AS admin_id"));
        assert!(sql.contains("name AS city_name"));
        // 出所が変わってもUIを書き換えずに済むよう、無い階層も列としては残す。
        assert!(sql.contains("NULL::VARCHAR AS county_name"));
        assert!(sql.contains("NULL::VARCHAR AS ward_name"));
        // 表示範囲での絞り込みに使う covering 列。
        assert!(sql.contains("    bbox,\n"));
    }

    // DuckDBに `geo` を書かせるとGeoParquet 1.0.0になり covering が落ちるので、
    // ジオメトリはBLOBとして書き、メタデータは自前のものを渡す。
    #[test]
    fn admin_sql_writes_its_own_geo_metadata() {
        let sql = build_admin_sql("/tmp/div.parquet", "/tmp/admin.parquet", r#"{"version":"1.1.0"}"#);

        assert!(sql.contains("ST_AsWKB(geometry)::BLOB AS geometry"));
        assert!(sql.contains(r#"KV_METADATA { geo: '{"version":"1.1.0"}' }"#));
    }

    // メタデータJSONに引用符が入ってもSQLが壊れないこと。
    #[test]
    fn admin_sql_escapes_quotes_in_metadata() {
        let sql = build_admin_sql("/tmp/div.parquet", "/tmp/admin.parquet", "it's");
        assert!(sql.contains("geo: 'it''s'"));
    }
}
