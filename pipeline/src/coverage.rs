//! **どこまで整備されているか**を地域メッシュで表す。
//!
//! # なぜbboxでは足りないか
//!
//! 収録範囲をファイルのbboxの和で示していたが、PLATEAUを306都市に広げたら
//! **和が日本をほぼ覆う1つの箱**になり、収録の無い山間部でも「ある」と出るようになった。
//! 市区町村の境界で描くのも違う — **PLATEAUの整備範囲は市域と一致しない**。
//!
//! # なぜメッシュか
//!
//! **建物が実際にある場所をそのまま数える**ので、境界データを持ち込まずに済む。
//! 地域メッシュは経緯度から機械的に決まる方眼で測量成果ではないため、
//! [`crate::mesh`] と同じく**測量法の懸念が原理的に発生しない**。
//!
//! 1kmで出しておけば、UIはコードを前から切るだけで粗くできる
//! (人口メッシュと同じ仕組み)。実測 (2026-09-27、全国2,928万棟):
//!
//! | 粒度 | 桁 | セル数 |
//! | --- | ---: | ---: |
//! | 1次メッシュ 80km | 4 | 77 |
//! | 2次メッシュ 10km | 6 | 939 |
//! | **3次メッシュ 1km** | **8** | **35,645** |
use crate::geoparquet;
use crate::mesh;
use anyhow::{Context, Result};
use geo_types::Polygon;
use std::path::Path;

/// 配るメッシュの細かさ (3次メッシュ = 約1km)。
///
/// **これより細かくしない。** 500mにすると4倍に増えるが、
/// 「どこが整備されているか」は1kmで十分に読める。粗くするのはUI側が
/// コードを前から切ってやる。
pub const COVERAGE_DIGITS: usize = 8;

/// row groupあたりの行数。**自動に任せない。**
///
/// 1行が小さい (約20バイト) ので既定の決め方では17,623行=3群になり、
/// 全国35,645セルが3つに分かれるだけになる。UIが要るのは `mesh_code` と
/// `buildings` と `bbox` (合わせて約9バイト/行) だけなので、群を小さくしても
/// 往復あたりの取得量は知れている。**それより表示範囲で絞れる方が効く** —
/// 起動時の地図は関東あたりの1画面で、全国を読む必要が無い。
///
/// 実測 (ズーム9・東京): 3群だと422KB、この値だと下記のテストが見張る。
pub const ROW_GROUP_SIZE: usize = 4_096;

/// **どのデータセットの整備範囲か**を名乗るメタデータのキー。
///
/// UIがこれを見て建物のCollectionに結び付ける。ここを書かずに
/// 「PLATEAUのものだ」とUI側で決め打ちすると、出所が増えたときに
/// 書き足す場所が分かれる。
pub const COVERS_KEY: &str = "duck:covers";

/// メッシュ1つ分。
pub struct Row {
    pub mesh_code: String,
    /// この中にある建物の数。**濃淡を付けるために持つ** (整備の厚みが分かる)。
    pub buildings: i32,
    pub geometry: Polygon<f64>,
}

/// 緯度経度から3次メッシュコードを組み立てるSQL式。
///
/// JIS X 0410 の定義そのまま。1次メッシュが `floor(緯度*1.5)` と
/// `floor(経度-100)`、以降は8分割・10分割していく。
///
/// **ここをRustに持ってこない。** 2,900万行を数えるのはDuckDBの仕事で、
/// Rustに渡すのは集計後の3万行だけにする。
fn mesh_code_expression(lat: &str, lon: &str) -> String {
    format!(
        "concat(
    lpad(floor({lat} * 1.5)::INT::VARCHAR, 2, '0'),
    lpad(floor({lon} - 100)::INT::VARCHAR, 2, '0'),
    floor(({lat} * 1.5 - floor({lat} * 1.5)) * 8)::INT::VARCHAR,
    floor(({lon} - 100 - floor({lon} - 100)) * 8)::INT::VARCHAR,
    floor((({lat} * 1.5 - floor({lat} * 1.5)) * 8
      - floor(({lat} * 1.5 - floor({lat} * 1.5)) * 8)) * 10)::INT::VARCHAR,
    floor((({lon} - 100 - floor({lon} - 100)) * 8
      - floor(({lon} - 100 - floor({lon} - 100)) * 8)) * 10)::INT::VARCHAR
  )"
    )
}

/// 都市ごとのファイルだけを読む条件。
///
/// **出力を入力に含めてはいけない。** 出力は `plateau_bldg_coverage.parquet` で、
/// 素直な glob (`plateau_bldg_*.parquet`) に**自分が引っかかる**。しかも整備範囲は
/// 列構成が違う (`height` が無い) ので、気付かずに混ぜると壊れ方が分かりにくい。
///
/// 都市ごとのファイルは `plateau_bldg_<5桁の都市コード>.parquet` なので、
/// 末尾が数字のものだけを採る。**同じ罠を高い建物の集計で踏んだ**
/// (2回流して件数が倍になった) ので、呼ぶ側のglobに頼らずここで閉じる。
const CITY_FILES_ONLY: &str = "regexp_matches(filename, '_[0-9]{5}\\.parquet$')";

/// 建物のGeoParquetから、整備されているメッシュとその建物数を数えるSQL。
///
/// 代表点は建物のbboxの中心。建物は1kmに対して十分小さいので、
/// どの点を採っても同じセルに入る。
pub fn build_coverage_sql(input_glob: &str) -> String {
    let code = mesh_code_expression("lat", "lon");
    format!(
        "SET memory_limit = '2GB';
SET preserve_insertion_order = false;
WITH points AS (
  SELECT
    (bbox.xmin + bbox.xmax) / 2 AS lon,
    (bbox.ymin + bbox.ymax) / 2 AS lat
  FROM read_parquet('{input_glob}', filename = true)
  WHERE {CITY_FILES_ONLY}
)
SELECT
  {code} AS mesh_code,
  count(*) AS buildings
FROM points
GROUP BY mesh_code
ORDER BY mesh_code;"
    )
}

/// メッシュコードからジオメトリを作って書き出す。
///
/// **ジオメトリを配るのは他の道具から使えるようにするため。** UIはコードから
/// 自分で計算する (前から切って粗くするので、配られた形は使わない)。
pub fn write_geoparquet(rows: Vec<Row>, output: &Path, covers: &str) -> Result<()> {
    let mut mesh_code = Vec::with_capacity(rows.len());
    let mut buildings = Vec::with_capacity(rows.len());
    let mut geometries = Vec::with_capacity(rows.len());
    for row in rows {
        mesh_code.push(row.mesh_code);
        buildings.push(Some(row.buildings));
        geometries.push(row.geometry);
    }

    let (geometry, bbox, file_bbox) = geoparquet::geometry_columns(&geometries, polygon_bbox)?;
    let columns = vec![
        geoparquet::utf8_column("mesh_code", mesh_code.into_iter()),
        geoparquet::i32_nullable_column("buildings", buildings.into_iter()),
    ];

    geoparquet::write(
        output,
        columns,
        "geometry",
        geometry,
        bbox,
        &["Polygon".to_string()],
        file_bbox,
        geoparquet::Provenance {
            covers: Some(covers),
            ..Default::default()
        },
    )
}

/// メッシュコードから四角形を作る。
pub fn polygon(code: &str) -> Result<Polygon<f64>> {
    mesh::polygon(code).with_context(|| format!("メッシュコードが読めません: {code}"))
}

fn polygon_bbox(polygon: &Polygon<f64>) -> [f64; 4] {
    polygon.exterior().coords().fold(
        [f64::MAX, f64::MAX, f64::MIN, f64::MIN],
        |[xmin, ymin, xmax, ymax], c| [xmin.min(c.x), ymin.min(c.y), xmax.max(c.x), ymax.max(c.y)],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **東京駅は 53394611。** メッシュコードの組み立てが定義どおりかを、
    /// 分かっている1点で確かめる。ここがずれると整備範囲が丸ごと隣にずれる。
    #[test]
    fn builds_the_known_mesh_code_for_tokyo_station() {
        let sql = format!(
            "SELECT {} AS code;",
            mesh_code_expression("35.681236", "139.767125")
        );
        // SQLを実際に流さずとも、式の形が壊れていないことは見ておく。
        assert!(sql.contains("1.5"), "{sql}");
        assert!(sql.contains("lpad"), "{sql}");

        // 同じ計算をRustでやって答えを突き合わせる (定義の確認)。
        let (lat, lon) = (35.681236_f64, 139.767125_f64);
        let p = (lat * 1.5).floor();
        let u = (lon - 100.0).floor();
        let q = ((lat * 1.5 - p) * 8.0).floor();
        let v = ((lon - 100.0 - u) * 8.0).floor();
        let r = (((lat * 1.5 - p) * 8.0 - q) * 10.0).floor();
        let w = (((lon - 100.0 - u) * 8.0 - v) * 10.0).floor();
        let code = format!("{p:02}{u:02}{q}{v}{r}{w}");
        assert_eq!(code, "53394611");
    }

    /// 組み立てたコードから範囲が引けること。**往復が合わないと描けない。**
    #[test]
    fn the_code_round_trips_to_a_polygon() {
        let square = polygon("53394611").unwrap();
        // 3次メッシュは緯度30秒・経度45秒。東京付近で約1km四方。
        let [xmin, ymin, xmax, ymax] = polygon_bbox(&square);
        assert!((ymax - ymin - 1.0 / 120.0).abs() < 1e-9, "{ymin}..{ymax}");
        assert!((xmax - xmin - 1.0 / 80.0).abs() < 1e-9, "{xmin}..{xmax}");
        // 東京駅を含むこと。
        assert!(xmin <= 139.767125 && 139.767125 <= xmax);
        assert!(ymin <= 35.681236 && 35.681236 <= ymax);
    }

    /// 入力のglobがSQLに入り、集計されること。
    #[test]
    fn counts_buildings_per_mesh() {
        let sql = build_coverage_sql("plateau_bldg_*.parquet");
        assert!(sql.contains("plateau_bldg_*.parquet"), "{sql}");
        assert!(sql.contains("GROUP BY mesh_code"), "{sql}");
        assert!(sql.contains("count(*) AS buildings"), "{sql}");
    }

    /// **自分の出力を読み込まないこと。** 出力名は素直なglobに引っかかるうえ、
    /// 整備範囲には `height` が無いので混ざると壊れ方が分かりにくい。
    #[test]
    fn never_reads_its_own_output() {
        let sql = build_coverage_sql("plateau_bldg_*.parquet");
        assert!(sql.contains(CITY_FILES_ONLY), "{sql}");
        // 条件を使うには filename 列が要る。
        assert!(sql.contains("filename = true"), "{sql}");
    }
}
