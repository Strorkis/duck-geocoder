//! **DuckDB の QuadKey の式が、Rust 側の計算と一致すること。**
//!
//! 建物を QuadKey で分けるときは DuckDB の式で振り分け、ファイル名や範囲は Rust 側で
//! 計算する。両者がずれると、建物が隣のタイルのファイルに入って `filesInView` から
//! 漏れる (黙って欠ける)。
//!
//! `duckdb` が無い環境 (CI の Rust ジョブなど) ではスキップする。
use duck_geocoder::quadkey;
use std::process::Command;

#[test]
fn sql_matches_rust() {
    // 東京・大阪・札幌・那覇・南鳥島、東端・南端に近い点、タイルの境目のすぐ内側。
    let points = [
        (139.7671, 35.6812),
        (135.5023, 34.6937),
        (141.3544, 43.0621),
        (127.6809, 26.2124),
        (153.9806, 24.2867),
        (179.999, -84.0),
        (139.21875, 35.746_512_259_918_5),
    ];
    for zoom in [1u8, 7, 8, 12] {
        let values = points
            .iter()
            .map(|(lon, lat)| format!("({lon}, {lat})"))
            .collect::<Vec<_>>()
            .join(", ");
        let expression = quadkey::sql_expression("lon", "lat", zoom);
        let sql = format!("SELECT {expression} FROM (VALUES {values}) t(lon, lat);");
        let output = match Command::new("duckdb")
            .args(["-noheader", "-list", "-c", &sql])
            .output()
        {
            Ok(output) => output,
            Err(_) => {
                eprintln!("skipping: duckdb が見つからない");
                return;
            }
        };
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let from_sql: Vec<String> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        let from_rust: Vec<String> = points
            .iter()
            .map(|(lon, lat)| quadkey::quadkey(*lon, *lat, zoom))
            .collect();
        assert_eq!(from_sql, from_rust, "zoom {zoom}");
    }
}
