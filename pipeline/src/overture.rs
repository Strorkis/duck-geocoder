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

/// Overtureの海域 (base/water の `subtype='ocean'`) を切り出すSQLを組み立てる。
///
/// 行政区域から海の部分を削るために使う。OSMの海岸線から作られたポリゴンなので、
/// これで削ると陸地の形が残る。出所がdivisionsと同じOvertureなので、
/// ODbLの扱いは変わらない。
pub fn build_ocean_extract_sql(release: &str, bbox: BoundingBox, output: &str) -> String {
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
    -- 範囲が重なるものだけを相手にするので、bbox列は落とさない。
    bbox,
    geometry
  FROM read_parquet(
    's3://overturemaps-us-west-2/release/{release}/theme=base/type=water/*',
    hive_partitioning=1
  )
  -- divisionsの切り出しと同じく、covering列で先に絞ってrow groupを読み飛ばす。
  WHERE bbox.xmin BETWEEN {xmin} AND {xmax}
    AND bbox.ymin BETWEEN {ymin} AND {ymax}
    AND subtype = 'ocean'
) TO '{output}' (FORMAT PARQUET);"
    )
}

/// 破片とみなす面積の上限 (平方度)。
///
/// `ST_Difference` は、区画の境界が海域ポリゴンの縁と重なるところに面積がほぼ0の
/// 破片を残す。そのままにすると、ハイライトが海の上に直線を引き、bboxも広がって
/// `fitBounds` が必要以上に引く (対馬市で南西へ約20km)。
///
/// 実測では、残る破片は最大 3.7e-15、本物の最小の部分は 8.1e-12 で**3桁離れている**。
/// 1e-12 平方度は約0.01平方メートルで、この大きさの島は無い。
/// 全国で254個の破片 (173市区町村) が落ち、本物の部分74,025個はすべて残る。
const SLIVER_AREA: &str = "1e-12";

/// 行政区域から海域を削るSQLを組み立てる。入力と同じ列を出す。
///
/// Overtureの `division_area` は `class='land'` で絞ってもなお湾を跨いでいて、
/// 東京湾の真ん中を逆ジオコーディングすると江戸川区が返る。海岸線で削ると
/// 「どの市区町村でもない」が正しく返るようになる。
///
/// 削ったあとの `bbox` は作り直す。`optimize_geoparquet` はこの列をそのまま読んで
/// 空間パッキングに使うので、海まで広がったままだとrow groupの統計が効かなくなる。
pub fn build_clip_ocean_sql(divisions: &str, ocean: &str, output: &str) -> String {
    format!(
        "INSTALL spatial; LOAD spatial;
-- 空間関数の中で確保されるメモリはDuckDBの memory_limit の外側にあり、
-- 並列度をそのまま掛けた分だけ実メモリを踏む。既定の並列度で流すと
-- 7GBの環境ではOSごと巻き込んで落ちたので、控えめに固定する。
SET threads=4;
COPY (
  -- 削るのは市区町村だけ。国 (1件) や都道府県 (47件) の区画は日本中の海域と
  -- 範囲が重なるので、同じことをすると海を丸ごと1ポリゴンに束ねる羽目になる。
  -- 配信しているのは市区町村なので、それ以外はそのまま通す。
  WITH sea AS (
    SELECT id, ST_Union_Agg(part) AS geometry
    FROM (
      -- 先に区画で切ってから束ねる。海域ポリゴンをそのまま束ねると、
      -- 1つ数万頂点のタイルが積み上がって現実的なメモリに収まらない。
      -- 交差部分は必ず区画の中に収まるので、束ねても小さいままになる。
      SELECT d.id AS id, ST_Intersection(d.geometry, o.geometry) AS part
      FROM read_parquet('{divisions}') d
      JOIN read_parquet('{ocean}') o
        ON o.bbox.xmin <= d.bbox.xmax AND o.bbox.xmax >= d.bbox.xmin
       AND o.bbox.ymin <= d.bbox.ymax AND o.bbox.ymax >= d.bbox.ymin
      WHERE {MUNICIPALITY_FILTER}
    )
    WHERE NOT ST_IsEmpty(part)
    GROUP BY id
  ),
  clipped AS (
    SELECT
      d.id,
      d.name,
      d.subtype,
      d.region,
      d.pref_name,
      -- 海に接していない区画は結合相手が無い。元の形をそのまま使う。
      -- 削った区画からは破片を落とす (下記 SLIVER_AREA)。
      CASE
        WHEN sea.geometry IS NULL THEN d.geometry
        ELSE ST_Collect(list_transform(
               list_filter(
                 ST_Dump(ST_Difference(d.geometry, sea.geometry)),
                 lambda part: ST_Area(part.geom) > {SLIVER_AREA}
               ),
               lambda part: part.geom
             ))
      END AS geometry
    FROM read_parquet('{divisions}') d
    LEFT JOIN sea ON sea.id = d.id
  )
  SELECT
    id,
    name,
    subtype,
    region,
    pref_name,
    {{
      xmin: ST_XMin(geometry),
      xmax: ST_XMax(geometry),
      ymin: ST_YMin(geometry),
      ymax: ST_YMax(geometry)
    }} AS bbox,
    geometry
  FROM clipped
  -- 海しか無かった区画は消える。
  WHERE NOT ST_IsEmpty(geometry)
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

/// 収録する道路の `class`。
///
/// Overtureの `class` はOSM由来で、`residential` や `service` まで入れると桁が変わる
/// (全国で1,000万件規模)。**ドローンのリスクとして見たいのは交通量の多い幹線**なので
/// ここで切る。おおよそ `motorway`=高速、`trunk`=国道、`primary`=主要地方道・県道。
pub const ROAD_CLASSES: [&str; 3] = ["motorway", "trunk", "primary"];

fn road_class_list() -> String {
    ROAD_CLASSES
        .iter()
        .map(|c| format!("'{c}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Overtureの道路 (transportation/segment) を切り出すSQLを組み立てる。
///
/// **`id` (GERS ID) は落とす。** 36バイトの文字列が全行に付き、実測で首都圏の
/// ファイルの28%を占めていた。こちらでは地物の同定に使っていない。
///
/// **`routes` はリストのまま持つ。** 1つの区間が複数の路線に属することがあり
/// (実測で首都圏の約半分が2本以上、最大10本)、先頭だけ取ると
/// 「国道4号かつ6号」の片方が消える。
pub fn build_roads_extract_sql(release: &str, bbox: BoundingBox, output: &str) -> String {
    let BoundingBox {
        xmin,
        ymin,
        xmax,
        ymax,
    } = bbox;
    let classes = road_class_list();
    format!(
        "INSTALL spatial; LOAD spatial;
INSTALL httpfs; LOAD httpfs;
SET s3_region='us-west-2';
-- **メモリを絞って流す。** 全国の幹線は87万区間あり、既定のままだと
-- 書き出しまで抱え込んでOOMで殺される (実測: 81MBまで書いたところで落ちた)。
-- 取り出しは射影と絞り込みだけなので、順序さえ保たなければ流しながら書ける。
-- 並べ替えはこのあと optimize_geoparquet が空間充填曲線でやり直すので、
-- ここでの行順には意味が無い。
SET preserve_insertion_order = false;
SET memory_limit = '2GB';
COPY (
  SELECT
    names.primary AS road_name,
    class,
    -- routes が丸ごとNULLのこともあるので、空リストに寄せてから展開する。
    -- **先に routes を絞ってから2つのリストを作る。** 名前と系統を別々に絞ると、
    -- 名前だけ欠けた路線があったときに長さがずれ、添字で対応づけると違う組になる
    -- (実測で6.3万区間がずれていた)。
    list_transform(
      list_filter(coalesce(routes, []), lambda r: r.name IS NOT NULL), lambda r: r.name
    ) AS route_names,
    list_transform(
      list_filter(coalesce(routes, []), lambda r: r.name IS NOT NULL), lambda r: r.network
    ) AS networks,
    -- 表示範囲での絞り込みに使う covering 列。
    bbox,
    geometry
  FROM read_parquet(
    's3://overturemaps-us-west-2/release/{release}/theme=transportation/type=segment/*',
    hive_partitioning=1
  )
  -- covering列で先に絞る。divisionsと同じ理由で、交差判定ではなく
  -- xmin/yminが範囲内という条件にしてrow groupの読み飛ばしを効かせる。
  WHERE bbox.xmin BETWEEN {xmin} AND {xmax}
    AND bbox.ymin BETWEEN {ymin} AND {ymax}
    AND subtype = 'road'
    AND class IN ({classes})
) TO '{output}' (FORMAT PARQUET);"
    )
}

/// 日本の道路だけを残す条件。`r` という別名の道路テーブルを前提にする。
///
/// **Overtureの道路には国の列が無い。** 日本を囲む矩形で切り出すと、
/// 朝鮮半島と中国東北部がまるごと入る (実測で21.7万区間、`봉영로` `京抚线` など)。
/// 経度緯度では切り分けられない — 対馬 (129.2〜129.5) と釜山 (129.0〜129.3) が重なる。
///
/// 判定は**市区町村ポリゴンとの交差**で行う。都道府県ポリゴンだと、
/// Overture側が小さい島を含んでおらず、**しまなみ海道の県道や沖縄の国道58号が
/// 巻き添えで消える** (実測で2,547区間)。市区町村なら島も市町村に属するので拾える。
///
/// それでも市区町村ポリゴンには隙間があり、米原や下仁田のあたりで377区間が落ちる。
/// **`JP:` で始まる系統を持つものは無条件で残す**ことで拾い直す。
/// 残る取りこぼしは、系統を持たずかな入りの名前を持つ**2区間**だけ。
fn japan_road_filter(divisions: &str) -> String {
    format!(
        "(
    EXISTS (
      SELECT 1 FROM read_parquet('{divisions}') jp
      WHERE {MUNICIPALITY_FILTER}
        AND jp.bbox.xmin <= r.bbox.xmax AND jp.bbox.xmax >= r.bbox.xmin
        AND jp.bbox.ymin <= r.bbox.ymax AND jp.bbox.ymax >= r.bbox.ymin
        AND ST_Intersects(jp.geometry, r.geometry)
    )
    OR len(list_filter(r.networks, lambda n: starts_with(n, 'JP'))) > 0
  )"
    )
}

/// 空間結合を流すときの設定。
///
/// 空間関数が確保するメモリは `memory_limit` の外側にあるので、並列度を抑える
/// ([`build_clip_ocean_sql`] と同じ理由)。行順はこのあと空間充填曲線で組み直す。
const SPATIAL_JOIN_SETTINGS: &str = "SET threads = 4;
SET memory_limit = '2GB';
SET preserve_insertion_order = false;";

/// 道路の収録範囲とジオメトリ種別を、class ごとに求めるSQL。
///
/// **書き出すものと同じ絞り込みを掛ける。** 掛けないと、収録範囲が大陸まで
/// 広がったまま `geo` メタデータに入る。
pub fn build_roads_stats_sql(input: &str, divisions: &str, class: &str) -> String {
    let japan = japan_road_filter(divisions);
    format!(
        "INSTALL spatial; LOAD spatial;
{SPATIAL_JOIN_SETTINGS}
SELECT
  min(r.bbox.xmin) AS xmin,
  min(r.bbox.ymin) AS ymin,
  max(r.bbox.xmax) AS xmax,
  max(r.bbox.ymax) AS ymax,
  list_sort(list_distinct(list(ST_GeometryType(r.geometry)::VARCHAR))) AS geometry_types
FROM read_parquet('{input}') r
WHERE r.class = '{class}'
  AND {japan};"
    )
}

/// 切り出した道路から、配信用のデータセットを class ごとに組み立てるSQL。
///
/// **class で分けて書く。** 高速・国道・県道は見たい場面が違うので、
/// ファイルから分けておけば「高速だけ表示」で残りを読まずに済む。
/// 分けても配信側は `read_parquet([...])` で1つのビューに束ねられる。
///
/// 当初はメモリのためと考えていたが、`optimize_geoparquet` の実測は
/// 最大の primary (33万行) で237MBだった。まとめても470MB程度で収まる見込みで、
/// **分ける理由はメモリではない。**
///
/// ジオメトリをBLOBとして書く理由は [`build_admin_sql`] と同じ。
pub fn build_roads_sql(
    input: &str,
    divisions: &str,
    class: &str,
    output: &str,
    geo_metadata_json: &str,
    vintage: &str,
) -> String {
    let escaped = geo_metadata_json.replace('\'', "''");
    let vintage = vintage.replace('\'', "''");
    let vintage_key = crate::geoparquet::VINTAGE_KEY;
    let japan = japan_road_filter(divisions);
    format!(
        "INSTALL spatial; LOAD spatial;
{SPATIAL_JOIN_SETTINGS}
COPY (
  SELECT
    r.road_name,
    r.class,
    r.route_names,
    r.bbox,
    ST_AsWKB(r.geometry)::BLOB AS geometry
  FROM read_parquet('{input}') r
  WHERE r.class = '{class}'
    AND {japan}
) TO '{output}' (FORMAT PARQUET, KV_METADATA {{
  geo: '{escaped}',
  '{vintage_key}': '{vintage}'
}});"
    )
}

/// 配信済みの道路ファイルから、路線の索引を作るSQL。
///
/// **同じ出所の要約**であって、別のデータではない (鉄道の駅と区間の関係と同じ)。
/// 路線ごとの範囲を持たせておくと、「国道13号」で引いたときに
/// 全区間のbbox列 (配信物の13%、約9MB) を読まずに済む。
///
/// ジオメトリを持たないので、これはGeoParquetではなく素のParquetになる
/// (`crate::admin_names` と同じ)。
///
/// **同じ名前の別路線は分けられない。** 石川バイパスは福島と沖縄にあり、
/// 束ねると範囲が日本全体に広がる。実測で散らばり3度超は58路線 (1.0%) で、
/// うち何本かはアジアハイウェイ1号線や国道58号のように**本当に長い**。
/// 鉄道の「本線」と同じで、原典に区別する手掛かりが無い。
pub fn build_road_routes_sql(input_glob: &str, output: &str) -> String {
    format!(
        "COPY (
  SELECT
    route_name,
    -- 等級は代表値。1つの路線が高速と国道をまたぐことは稀。
    mode(class) AS class,
    count(*) AS segments,
    {{
      xmin: min(bbox.xmin),
      ymin: min(bbox.ymin),
      xmax: max(bbox.xmax),
      ymax: max(bbox.ymax)
    }} AS bbox
  FROM (
    SELECT unnest(route_names) AS route_name, class, bbox
    FROM read_parquet('{input_glob}')
  )
  GROUP BY route_name
  ORDER BY route_name
) TO '{output}' (FORMAT PARQUET);"
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

    #[test]
    fn ocean_sql_filters_by_covering_bbox_and_subtype() {
        let sql = build_ocean_extract_sql("2026-07-22.0", JAPAN_BBOX, "/tmp/ocean.parquet");

        assert!(sql.contains("theme=base/type=water"));
        assert!(sql.contains("subtype = 'ocean'"));
        // divisionsと同じく、covering列で絞らないとrow groupを読み飛ばせない。
        assert!(sql.contains("bbox.xmin BETWEEN 122 AND 154"));
        assert!(sql.contains("bbox.ymin BETWEEN 20 AND 46"));
        assert!(sql.contains("TO '/tmp/ocean.parquet'"));
        // 区画との突き合わせに使うので、bbox列を落とさないこと。
        assert!(sql.contains("    bbox,\n"));
    }

    // 範囲が重なる海域だけを相手にしていること。
    #[test]
    fn clip_sql_joins_ocean_by_overlapping_bbox() {
        let sql =
            build_clip_ocean_sql("/tmp/div.parquet", "/tmp/ocean.parquet", "/tmp/out.parquet");

        assert!(sql.contains("JOIN read_parquet('/tmp/ocean.parquet')"));
        assert!(sql.contains("o.bbox.xmin <= d.bbox.xmax"));
        assert!(sql.contains("o.bbox.ymin <= d.bbox.ymax"));
    }

    // 削る相手を市区町村に限ること。国(1件)や都道府県(47件)の区画は日本中の海域と
    // 範囲が重なるので、同じ処理をすると海を丸ごと1ポリゴンに束ねることになる。
    // ここを外すと7GBの環境ではOSごと落ちる。
    #[test]
    fn clip_sql_only_touches_municipalities() {
        let sql =
            build_clip_ocean_sql("/tmp/div.parquet", "/tmp/ocean.parquet", "/tmp/out.parquet");
        assert!(sql.contains(MUNICIPALITY_FILTER));
    }

    // ST_Difference は海域ポリゴンの縁に面積ほぼ0の破片を残す。落とさないと
    // ハイライトが海の上に直線を引き、bboxも広がって fitBounds が引きすぎる。
    #[test]
    fn clip_sql_drops_slivers() {
        let sql =
            build_clip_ocean_sql("/tmp/div.parquet", "/tmp/ocean.parquet", "/tmp/out.parquet");
        assert!(sql.contains("ST_Dump(ST_Difference(d.geometry, sea.geometry))"));
        assert!(sql.contains(&format!("ST_Area(part.geom) > {SLIVER_AREA}")));
    }

    // 海域ポリゴンをそのまま束ねると、1つ数万頂点のタイルが積み上がる。
    // 先に区画で切ってから束ねること。
    #[test]
    fn clip_sql_intersects_before_aggregating() {
        let sql =
            build_clip_ocean_sql("/tmp/div.parquet", "/tmp/ocean.parquet", "/tmp/out.parquet");
        assert!(sql.contains("ST_Intersection(d.geometry, o.geometry) AS part"));
        assert!(sql.contains("ST_Union_Agg(part)"));
    }

    // 削ったあとのbboxは、optimize_geoparquet が空間パッキングに使う。
    // 元のまま (海まで広がったまま) 通すとrow groupの統計が効かなくなる。
    #[test]
    fn clip_sql_rebuilds_the_covering_bbox() {
        let sql =
            build_clip_ocean_sql("/tmp/div.parquet", "/tmp/ocean.parquet", "/tmp/out.parquet");

        assert!(sql.contains("xmin: ST_XMin(geometry)"));
        assert!(sql.contains("ymax: ST_YMax(geometry)"));
        // 海しか無かった区画は落とす。
        assert!(sql.contains("WHERE NOT ST_IsEmpty(geometry)"));
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
        let sql = build_admin_sql(
            "/tmp/div.parquet",
            "/tmp/admin.parquet",
            r#"{"version":"1.1.0"}"#,
        );

        assert!(sql.contains("ST_AsWKB(geometry)::BLOB AS geometry"));
        assert!(sql.contains(r#"KV_METADATA { geo: '{"version":"1.1.0"}' }"#));
    }

    // メタデータJSONに引用符が入ってもSQLが壊れないこと。
    #[test]
    fn admin_sql_escapes_quotes_in_metadata() {
        let sql = build_admin_sql("/tmp/div.parquet", "/tmp/admin.parquet", "it's");
        assert!(sql.contains("geo: 'it''s'"));
    }

    // **GERS ID は持ち帰らない。** 首都圏の実測でファイルの28%を占めていたが、
    // こちらでは地物の同定に使っていない。
    #[test]
    fn roads_extract_drops_the_gers_id() {
        let sql = build_roads_extract_sql("2026-07-22.0", JAPAN_BBOX, "/tmp/roads.parquet");

        assert!(sql.contains("theme=transportation/type=segment"));
        assert!(!sql.contains("    id,"));
        assert!(sql.contains("subtype = 'road'"));
    }

    // **メモリを絞らないとOOMで殺される。** 実測で81MBまで書いたところで落ちた。
    // 行順はこのあと空間充填曲線で組み直すので、保たなくてよい。
    #[test]
    fn roads_extract_streams_within_a_memory_limit() {
        let sql = build_roads_extract_sql("2026-07-22.0", JAPAN_BBOX, "/tmp/roads.parquet");

        assert!(sql.contains("SET preserve_insertion_order = false;"));
        assert!(sql.contains("SET memory_limit = '2GB';"));
    }

    // **1区間が複数の路線に属する。** 実測で首都圏の約半分が2本以上 (最大10本) なので、
    // 先頭だけ取ると「国道4号かつ6号」の片方が消える。
    #[test]
    fn roads_extract_keeps_every_route() {
        let sql = build_roads_extract_sql("2026-07-22.0", JAPAN_BBOX, "/tmp/roads.parquet");

        assert!(sql.contains(
            "lambda r: r.name
    ) AS route_names"
        ));
        assert!(sql.contains(
            "lambda r: r.network
    ) AS networks"
        ));
        // routes が丸ごとNULLの行で落ちないこと。
        assert!(sql.contains("coalesce(routes, [])"));
    }

    // 幹線だけに絞る。residential まで入れると桁が変わる。
    #[test]
    fn roads_extract_limits_the_classes() {
        let sql = build_roads_extract_sql("2026-07-22.0", JAPAN_BBOX, "/tmp/roads.parquet");

        for class in ROAD_CLASSES {
            assert!(sql.contains(&format!("'{class}'")), "{class} が無い");
        }
        assert!(!sql.contains("'residential'"));
    }

    // class ごとに分けて書く。1ファイルにすると optimize_geoparquet が
    // 全行をメモリに載せるところで苦しくなる。
    #[test]
    fn roads_sql_writes_one_class_at_a_time() {
        let sql = build_roads_sql(
            "/tmp/roads.parquet",
            "/tmp/div.parquet",
            "trunk",
            "/tmp/out.parquet",
            r#"{"version":"1.1.0"}"#,
            "2026-07-22.0",
        );

        assert!(sql.contains("WHERE r.class = 'trunk'"));
        assert!(sql.contains("ST_AsWKB(r.geometry)::BLOB AS geometry"));
        assert!(sql.contains(r#"geo: '{"version":"1.1.0"}'"#));
        assert!(sql.contains("'duck:vintage': '2026-07-22.0'"));
    }

    // **Overtureの道路には国の列が無い。** 日本を囲む矩形には朝鮮半島と
    // 中国東北部が入る (実測21.7万区間)。経度緯度では切り分けられないので、
    // 市区町村ポリゴンとの交差で判定する。
    #[test]
    fn roads_sql_keeps_japan_only() {
        let sql = build_roads_sql(
            "/tmp/roads.parquet",
            "/tmp/div.parquet",
            "trunk",
            "/tmp/out.parquet",
            "{}",
            "v",
        );

        assert!(sql.contains("ST_Intersects(jp.geometry, r.geometry)"));
        assert!(sql.contains(MUNICIPALITY_FILTER));
        // 都道府県ポリゴンでは島が抜ける。市区町村で見ること。
        assert!(!sql.contains("subtype = 'region'"));
    }

    // 市区町村ポリゴンには隙間があり、それだけだと米原や下仁田で377区間が落ちる。
    // `JP:` で始まる系統を持つものは無条件で残して拾い直す。
    #[test]
    fn roads_sql_rescues_segments_with_a_japanese_route_network() {
        let sql = build_roads_sql(
            "/tmp/roads.parquet",
            "/tmp/div.parquet",
            "trunk",
            "/tmp/out.parquet",
            "{}",
            "v",
        );

        assert!(sql.contains("starts_with(n, 'JP')"));
        assert!(sql.contains("OR len(list_filter(r.networks,"));
    }

    // **配信物に networks は載せない。** UIで使っておらず、
    // route_names と添字で対応づけたくなる罠だけが残る。
    #[test]
    fn roads_sql_does_not_ship_the_network_list() {
        let sql = build_roads_sql(
            "/tmp/roads.parquet",
            "/tmp/div.parquet",
            "trunk",
            "/tmp/out.parquet",
            "{}",
            "v",
        );

        // 書き出す列の並びに networks が無いこと (絞り込みの中の参照は別)。
        assert!(sql.contains(
            "    r.route_names,
"
        ));
        assert!(!sql.contains(
            "    r.networks,
"
        ));
    }

    // 2つのリストは同じ routes から作るので、長さが揃っていなければならない。
    #[test]
    fn roads_extract_keeps_the_two_lists_aligned() {
        let sql = build_roads_extract_sql("2026-07-22.0", JAPAN_BBOX, "/tmp/roads.parquet");

        // 先に routes を絞ってから2つのリストを作ること。
        assert!(sql.contains("list_filter(coalesce(routes, []), lambda r: r.name IS NOT NULL)"));
        // 名前と系統を別々に絞ると長さがずれる。
        assert!(!sql.contains("lambda x: x IS NOT NULL"));
    }

    // 路線の索引はジオメトリを持たない。持たせると小さくならない。
    #[test]
    fn road_routes_index_has_no_geometry() {
        let sql = build_road_routes_sql("/tmp/roads_*.parquet", "/tmp/routes.parquet");

        assert!(sql.contains("unnest(route_names) AS route_name"));
        assert!(sql.contains("GROUP BY route_name"));
        assert!(!sql.contains("geometry"));
    }

    // 収録範囲は書き出すものと同じ絞り込みで測る。
    // 掛け忘れると、範囲が大陸まで広がったまま geo メタデータに入る。
    #[test]
    fn roads_stats_use_the_same_filter_as_the_output() {
        let stats = build_roads_stats_sql("/tmp/roads.parquet", "/tmp/div.parquet", "trunk");

        assert!(stats.contains("ST_Intersects(jp.geometry, r.geometry)"));
        assert!(stats.contains("starts_with(n, 'JP')"));
        assert!(stats.contains("WHERE r.class = 'trunk'"));
    }
}
