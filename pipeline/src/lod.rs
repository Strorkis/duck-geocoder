//! 引いた表示のための**粗い段**を、同じファイルの中に作る。
//!
//! # なぜ同じファイルに入れるか
//!
//! 解像度ごとにファイルを分けると配信物が種別×段だけ増える。PMTilesが
//! タイルを1ファイルに寄せているのと同じ理由で、**数が増えるほど運用が破綻する**。
//!
//! # なぜ列ではなく行として足すか
//!
//! COGPの `overviews` のように「1行ごとに簡略化したジオメトリ」を列で持つ形は、
//! **行数がそのまま床になる**。WKBは1行あたり21バイト前後のヘッダを持つので、
//! 行を減らさないと縮まない。実測 (2026-09-27):
//!
//! | | 行数 | 粗い列 |
//! | --- | ---: | ---: |
//! | 高速道路 | 35,130 | 740KB |
//! | 鉄道 | 21,933 | 422KB |
//! | 国道 | 288,126 | **4,678KB** ← 使えない |
//!
//! 断片を統合してから簡略化すると行が減るので効く。国道は 288,126区間 →
//! **2,381本 / 888KB** になり、ファイル全体24.9MBのうちそこだけ読めば済む。
//!
//! # なぜ統合が要るか (簡略化だけでは足りない)
//!
//! 統合せずに簡略化しても 9,432KB → 5,938KB (1.6倍) にしかならない。
//! 「長い区間だけ選ぶ」は無損失だが 4,001区間で3,685KBかつ**線が途切れて
//! 地図が壊れる**。縮むのは簡略化から来ている。
//!
//! # COGPとの関係
//!
//! **これはCOGPではない。** 物理配置 (粗→細の順に行グループを並べる) は
//! COGPの `geo.lod` と同じなので、採用するときに並べ替えをやり直す必要は無い。
//! ただし仕様の考え方が違う。COGPは行を段に**分配**し (各行は1度だけ現れる)、
//! 簡略化は `overviews` 列で与える。これは行政区域のような**独立した地物**には
//! 合うが、道路網では行を選ぶと線が途切れるうえ、上の表のとおり列は行数の壁に
//! 当たる。そこでこちらは**統合した行を足す**形にした。
//!
//! 段の区切り (`row_group_end`) はParquetのrow group統計からいつでも導けるので、
//! 将来COGPに寄せるときもデータの作り直しにはならない。
use crate::geoparquet::VINTAGE_KEY;

/// 粗い段の簡略化の許容誤差 (メートル)。
///
/// 緯度36°で `m/px = 126,643 / 2^z` なので、100mはズーム10で0.8px、11で1.6px、
/// 12で3.2px。**粗い段はズーム11まで**で、12から原寸に切り替える。
pub const COARSE_TOLERANCE_M: f64 = 100.0;

/// 段を持つファイルが名乗るメタデータのキー。
pub const LOD_KEY: &str = "duck:lod";

/// `duck:lod` から**粗い段の解像度 (メートル)** を読む。段が無ければ `None`。
///
/// カタログがこれを読んでCollectionに載せ、UIが「どのズームまで粗い段で足りるか」を
/// 自分で決める。**ズーム閾値を表示側に書かない**ための道筋。
pub fn coarse_resolution_m(lod_json: &str) -> Option<f64> {
    let parsed: serde_json::Value = serde_json::from_str(lod_json).ok()?;
    parsed
        .get("levels")?
        .as_array()?
        .iter()
        .find(|level| {
            level.get("lod").and_then(serde_json::Value::as_u64) == Some(COARSE_LOD.into())
        })?
        .get("resolution_m")?
        .as_f64()
        // 0は「簡略化していない」の意味なので、段として数えない。
        .filter(|resolution| *resolution > 0.0)
}

/// 粗い段 (最初の段)。
pub const COARSE_LOD: u8 = 0;
/// 原寸 (最後の段)。
pub const EXACT_LOD: u8 = 1;

/// 緯度1度あたりのメートル。許容誤差を度に直すのに使う。
///
/// **経度方向は緯度36°で90,060m/度**と短いので、同じ度数だと経度方向の
/// 実効誤差は約81mになる。`ST_Simplify` は軸を区別しないため、ここは
/// 「緯度方向で100m、経度方向でそれ以下」という意味になる。
const METERS_PER_DEGREE_LAT: f64 = 111_320.0;

/// 許容誤差をメートルから度に直す。
pub fn tolerance_degrees(meters: f64) -> f64 {
    meters / METERS_PER_DEGREE_LAT
}

/// 粗い段の作り方。**データセットごとに列が違う**ので呼ぶ側が渡す。
#[derive(Debug, Clone, Copy)]
pub struct CoarseLevel<'a> {
    /// 統合の単位。ここが同じ行が1本にまとまる (`GROUP BY`)。
    pub merge_key: &'a [&'a str],
    /// キー以外の列を粗い段でどう畳むか。`(列名, 式)` の組。
    ///
    /// 原寸の段ではそのまま出すので、**列の並びはここから決まる**。
    pub folded: &'a [(&'a str, &'a str)],
    /// 粗い段に入れる行の条件。`None` なら全部入れる。
    ///
    /// 道路では `road_name IS NOT NULL` を渡す。高速35,130区間のうち17,951本は
    /// ランプ・JCT連絡路で、引いた表示では見えない。**これは選択であって
    /// 近似ではない。**
    pub require: Option<&'a str>,
}

impl CoarseLevel<'_> {
    /// ジオメトリとbbox以外の列を、ファイル上の並びで返す。
    fn columns(&self) -> Vec<&str> {
        self.merge_key
            .iter()
            .copied()
            .chain(self.folded.iter().map(|(name, _)| *name))
            .collect()
    }
}

/// `duck:lod` の中身。段ごとの解像度を名乗る。
fn lod_metadata_json(tolerance_m: f64) -> String {
    // row_group_end は書かない。**並べ替えを決めるのは repack** であって
    // ここではないし、Parquetのrow group統計からいつでも導ける。
    serde_json::json!({
        "levels": [
            { "lod": COARSE_LOD, "resolution_m": tolerance_m },
            { "lod": EXACT_LOD, "resolution_m": 0.0 },
        ]
    })
    .to_string()
}

/// 既にあるGeoParquetに粗い段を足して書き直すSQLを組み立てる。
///
/// 粗い段を `lod = 0`、元の行を `lod = 1` として1つのファイルにする。
/// **元の行は何も変えない** (簡略化するのは足す方だけ)。
///
/// 並べ替えはこのあと [`crate::repack`] が段ごとにやり直すので、
/// ここでの行順には意味が無い。
pub fn build_with_coarse_lod_sql(
    input: &str,
    output: &str,
    level: &CoarseLevel,
    geo_metadata_json: &str,
    vintage: &str,
) -> String {
    let escaped_geo = geo_metadata_json.replace('\'', "''");
    let escaped_lod = lod_metadata_json(COARSE_TOLERANCE_M).replace('\'', "''");
    let vintage = vintage.replace('\'', "''");
    let tolerance = tolerance_degrees(COARSE_TOLERANCE_M);

    let columns = level.columns().join(",\n    ");
    let key = level.merge_key.join(", ");
    let folded = level
        .folded
        .iter()
        .map(|(name, expression)| format!("{expression} AS {name}"))
        .collect::<Vec<_>>()
        .join(",\n      ");
    let require = level
        .require
        .map(|condition| format!("\n    WHERE {condition}"))
        .unwrap_or_default();

    format!(
        "INSTALL spatial; LOAD spatial;
-- 統合は行を抱えるので、順序を保たせずメモリを絞る。
SET preserve_insertion_order = false;
SET memory_limit = '2GB';
COPY (
  -- 粗い段。断片を路線ごとに繋いでから簡略化する。
  SELECT
    {coarse_lod}::UTINYINT AS lod,
    {columns},
    {{
      xmin: ST_XMin(geometry),
      ymin: ST_YMin(geometry),
      xmax: ST_XMax(geometry),
      ymax: ST_YMax(geometry)
    }} AS bbox,
    ST_AsWKB(geometry)::BLOB AS geometry
  FROM (
    SELECT
      {key},
      {folded},
      ST_Simplify(ST_LineMerge(ST_Collect(list(geometry))), {tolerance}) AS geometry
    FROM read_parquet('{input}'){require}
    GROUP BY {key}
  )
  -- 簡略化で潰れて消えることがあるので、空は入れない。
  WHERE NOT ST_IsEmpty(geometry)

  UNION ALL

  -- 原寸。**元の行をそのまま通す。**
  SELECT
    {exact_lod}::UTINYINT AS lod,
    {columns},
    bbox,
    ST_AsWKB(geometry)::BLOB AS geometry
  FROM read_parquet('{input}')
) TO '{output}' (FORMAT PARQUET, KV_METADATA {{
  geo: '{escaped_geo}',
  '{lod_key}': '{escaped_lod}',
  '{vintage_key}': '{vintage}'
}});",
        coarse_lod = COARSE_LOD,
        exact_lod = EXACT_LOD,
        lod_key = LOD_KEY,
        vintage_key = VINTAGE_KEY,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROADS: CoarseLevel = CoarseLevel {
        merge_key: &["road_name"],
        folded: &[
            ("class", "mode(class)"),
            ("route_names", "list_distinct(flatten(list(route_names)))"),
        ],
        require: Some("road_name IS NOT NULL"),
    };

    fn roads_sql() -> String {
        build_with_coarse_lod_sql("in.parquet", "out.parquet", &ROADS, "{}", "2026-09")
    }

    /// 100mが度に直ること。**ここを間違えると簡略化が効きすぎるか効かない。**
    #[test]
    fn converts_the_tolerance_to_degrees() {
        let degrees = tolerance_degrees(100.0);
        // 緯度1度が約111kmなので、100mは約0.0009度。
        assert!((degrees - 0.000_898).abs() < 1e-6, "{degrees}");
        // メートルに戻ること。
        assert!((degrees * METERS_PER_DEGREE_LAT - 100.0).abs() < 1e-9);
    }

    /// 統合の単位がGROUP BYに入ること。
    #[test]
    fn groups_by_the_merge_key() {
        let sql = roads_sql();
        assert!(sql.contains("GROUP BY road_name"), "{sql}");
        assert!(sql.contains("ST_LineMerge"), "{sql}");
    }

    /// **条件に合わない行を粗い段に入れない。** 名前の無い区間 (ランプ) が
    /// 入ると、引いた表示に見えない線が積み上がる。
    #[test]
    fn keeps_unnamed_rows_out_of_the_coarse_level() {
        let sql = roads_sql();
        assert!(sql.contains("WHERE road_name IS NOT NULL"), "{sql}");
        // 原寸の段は絞らない。**元の行は1行も落とさない。**
        let exact = sql.split("UNION ALL").nth(1).expect("原寸の段がある");
        assert!(!exact.contains("road_name IS NOT NULL"), "{exact}");
    }

    /// 両方の段が同じ列を、同じ並びで出すこと。
    /// **ずれると UNION が黙って別の列を突き合わせる。**
    #[test]
    fn both_levels_select_the_same_columns() {
        let sql = roads_sql();
        let (coarse, exact) = sql.split_once("UNION ALL").expect("段が2つある");
        for column in ["road_name", "class", "route_names", "bbox", "geometry"] {
            assert!(coarse.contains(column), "粗い段に {column} が無い");
            assert!(exact.contains(column), "原寸の段に {column} が無い");
        }
    }

    /// 段の番号が入り、メタデータが段の解像度を名乗ること。
    #[test]
    fn declares_the_levels() {
        let sql = roads_sql();
        assert!(sql.contains("0::UTINYINT AS lod"), "{sql}");
        assert!(sql.contains("1::UTINYINT AS lod"), "{sql}");
        assert!(sql.contains("duck:lod"), "{sql}");
        // 解像度を書いておくと、UIがどのズームまで使えるかを自分で決められる。
        assert!(sql.contains("resolution_m"), "{sql}");
    }

    /// ジオメトリはBLOBとして書くこと。DuckDBに `geo` を書かせると重複する。
    #[test]
    fn writes_geometry_as_a_blob() {
        let sql = roads_sql();
        assert_eq!(
            sql.matches("ST_AsWKB(geometry)::BLOB AS geometry").count(),
            2
        );
    }

    /// 書いたメタデータをそのまま読み戻せること。
    /// **カタログはここを通ってUIに伝わる**ので、往復が合わないと段が無いことになる。
    #[test]
    fn reads_back_the_coarse_resolution() {
        let written = lod_metadata_json(COARSE_TOLERANCE_M);
        assert_eq!(coarse_resolution_m(&written), Some(COARSE_TOLERANCE_M));
    }

    /// 段を名乗らないファイルは `None`。原寸しか無いのに粗い段を引くと空になる。
    #[test]
    fn reports_no_coarse_level_when_there_is_none() {
        assert_eq!(coarse_resolution_m("{}"), None);
        assert_eq!(coarse_resolution_m("壊れたJSON"), None);
        // 解像度0は「簡略化していない」なので段として数えない。
        assert_eq!(
            coarse_resolution_m(r#"{"levels":[{"lod":0,"resolution_m":0.0}]}"#),
            None
        );
    }
}
