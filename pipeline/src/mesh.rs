//! 地域メッシュ (JIS X 0410) のコードから範囲を計算する。
//!
//! **ここが「境界データを落とさなくてよい」理由。** 地域メッシュは経緯度から
//! 機械的に決まる方眼で、測量成果ではない。コードさえあれば範囲は計算で出せるので、
//! 境界データのダウンロードが要らず、測量法の懸念も原理的に発生しない。
//! (小地域 (町丁・字等) の境界は測量成果に基づく図形を含むので扱いが違う)
//!
//! 対応する桁数:
//!
//! | 桁 | 呼び名 | 大きさ |
//! | ---: | --- | --- |
//! | 4 | 1次メッシュ | 約80km |
//! | 6 | 2次メッシュ | 約10km |
//! | 8 | 3次メッシュ (基準地域メッシュ) | 約1km |
//! | 9 | 2分の1地域メッシュ | 約500m |
//! | 10 | 4分の1地域メッシュ | 約250m |
//! | 11 | 8分の1地域メッシュ | 約125m |

use anyhow::{Result, bail};
use geo_types::{Coord, LineString, Polygon};

/// 地球の平均半径 (m)。IUGG の平均半径。
/// 面積は回転楕円体で解くと0.5%程度しか変わらないので、球で足りる
/// (人口密度の区分に効く桁ではない)。
const EARTH_RADIUS_M: f64 = 6_371_008.8;

/// メッシュの範囲 `[west, south, east, north]` (WGS84)。
pub type Bounds = [f64; 4];

/// メッシュコードから範囲を求める。
///
/// 桁数から階層が決まる。**知らない桁数はエラーにする** (推測して通すと、
/// 1桁多い/少ないコードを黙って別の場所として扱ってしまう)。
pub fn bounds(code: &str) -> Result<Bounds> {
    let digits: Vec<u32> = code
        .chars()
        .map(|c| {
            c.to_digit(10)
                .ok_or_else(|| anyhow::anyhow!("メッシュコードに数字以外が入っています: {code:?}"))
        })
        .collect::<Result<_>>()?;

    if !matches!(digits.len(), 4 | 6 | 8 | 9 | 10 | 11) {
        bail!(
            "メッシュコードの桁数が 4/6/8/9/10/11 のいずれでもありません: {code:?} ({}桁)",
            digits.len()
        );
    }

    // 1次メッシュ。緯度は1.5倍した整数部、経度は100を引いた整数部で表す。
    let mut lat_size = 2.0 / 3.0;
    let mut lon_size = 1.0;
    let mut south = (digits[0] * 10 + digits[1]) as f64 / 1.5;
    let mut west = (digits[2] * 10 + digits[3]) as f64 + 100.0;

    // 2次メッシュ。1次を縦横8分割し、南西を0として行・列で指す。
    if digits.len() >= 6 {
        let (row, col) = (digits[4], digits[5]);
        if row > 7 || col > 7 {
            bail!("2次メッシュの区画番号は0〜7です: {code:?}");
        }
        lat_size /= 8.0;
        lon_size /= 8.0;
        south += row as f64 * lat_size;
        west += col as f64 * lon_size;
    }

    // 3次メッシュ。2次を縦横10分割する。
    if digits.len() >= 8 {
        lat_size /= 10.0;
        lon_size /= 10.0;
        south += digits[6] as f64 * lat_size;
        west += digits[7] as f64 * lon_size;
    }

    // 分割メッシュ。ここから先は1桁ごとに4分割で、1=南西 2=南東 3=北西 4=北東。
    for &quadrant in &digits[8.min(digits.len())..] {
        if !(1..=4).contains(&quadrant) {
            bail!("分割メッシュの区画番号は1〜4です: {code:?}");
        }
        let index = quadrant - 1;
        lat_size /= 2.0;
        lon_size /= 2.0;
        south += (index / 2) as f64 * lat_size;
        west += (index % 2) as f64 * lon_size;
    }

    Ok([west, south, west + lon_size, south + lat_size])
}

/// メッシュコードから矩形のポリゴンを作る。外周は右回り (GeoJSON/OGCの外周の向き)。
pub fn polygon(code: &str) -> Result<Polygon<f64>> {
    let [west, south, east, north] = bounds(code)?;
    let ring = LineString::from(vec![
        Coord { x: west, y: south },
        Coord { x: east, y: south },
        Coord { x: east, y: north },
        Coord { x: west, y: north },
        Coord { x: west, y: south },
    ]);
    Ok(Polygon::new(ring, Vec::new()))
}

/// メッシュの面積 (km²)。
///
/// **緯度で変わる。** 経度方向の幅は高緯度ほど狭くなるので、3次メッシュでも
/// 沖縄と北海道では1割以上違う。人口密度を出すときに定数で割ってはいけない。
pub fn area_km2(code: &str) -> Result<f64> {
    let [west, south, east, north] = bounds(code)?;
    // 球面上の緯度経度の矩形の面積。R² × Δ経度(rad) × (sin(北緯) - sin(南緯))。
    let area_m2 = EARTH_RADIUS_M
        * EARTH_RADIUS_M
        * (east - west).to_radians()
        * (north.to_radians().sin() - south.to_radians().sin());
    Ok(area_m2 / 1_000_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 東京駅。分割メッシュの区画番号の並び (1=南西 2=南東 3=北西 4=北東) を
    /// 取り違えていないかは、既知の地点が入るかどうかで見るのが確実。
    const TOKYO_STATION: (f64, f64) = (139.7671, 35.6812);

    fn contains(code: &str, (lon, lat): (f64, f64)) -> bool {
        let [west, south, east, north] = bounds(code).unwrap();
        (west..east).contains(&lon) && (south..north).contains(&lat)
    }

    #[test]
    fn third_level_mesh_contains_tokyo_station() {
        assert!(contains("53394611", TOKYO_STATION));
    }

    // 東京駅は3次メッシュ 53394611 の北西寄りにあるので、500mメッシュは末尾3。
    // ここを取り違えると、南北・東西が入れ替わったまま全部が通ってしまう。
    #[test]
    fn half_mesh_quadrant_numbering_is_southwest_first() {
        assert!(contains("533946113", TOKYO_STATION));
        for code in ["533946111", "533946112", "533946114"] {
            assert!(!contains(code, TOKYO_STATION), "{code} に入ってしまった");
        }
    }

    // 1次メッシュ 5339 は北緯35°20′〜36°00′、東経139°〜140°。
    #[test]
    fn first_level_mesh_matches_the_definition() {
        let [west, south, east, north] = bounds("5339").unwrap();
        assert!((west - 139.0).abs() < 1e-9, "{west}");
        assert!((east - 140.0).abs() < 1e-9, "{east}");
        assert!((south - 53.0 / 1.5).abs() < 1e-9, "{south}");
        assert!((north - 36.0).abs() < 1e-9, "{north}");
    }

    // 隙間なく敷き詰められること。1つでもずれると、人口を面積で割った値が
    // 境界付近だけ跳ねるが、地図で見ても気づきにくい。
    #[test]
    fn neighbouring_meshes_share_an_edge() {
        let [_, _, east, north] = bounds("53394611").unwrap();
        let [east_west, _, _, _] = bounds("53394612").unwrap();
        let [_, north_south, _, _] = bounds("53394621").unwrap();
        assert!((east - east_west).abs() < 1e-9, "{east} vs {east_west}");
        assert!(
            (north - north_south).abs() < 1e-9,
            "{north} vs {north_south}"
        );
    }

    // 分割するたびに面積が4分の1になること。
    #[test]
    fn each_split_quarters_the_area() {
        let third = area_km2("53394611").unwrap();
        let half = area_km2("533946113").unwrap();
        let quarter = area_km2("5339461131").unwrap();
        assert!((third / half - 4.0).abs() < 0.01, "{third} / {half}");
        assert!((half / quarter - 4.0).abs() < 0.01, "{half} / {quarter}");
    }

    // 3次メッシュは「約1km四方」。桁が合っていることを確かめる
    // (半径や度→ラジアンの取り違えは、面積が桁で狂うので比で見れば分かる)。
    #[test]
    fn third_level_mesh_is_about_one_square_kilometre() {
        let area = area_km2("53394611").unwrap();
        assert!((0.9..1.1).contains(&area), "{area} km²");
    }

    // 経度方向の幅は高緯度ほど狭い。定数で割ってはいけないことの裏付け。
    #[test]
    fn area_shrinks_towards_the_north() {
        let okinawa = area_km2("39272000").unwrap(); // 北緯26°付近
        let hokkaido = area_km2("68412000").unwrap(); // 北緯45°付近
        assert!(okinawa > hokkaido, "{okinawa} <= {hokkaido}");
        assert!(
            okinawa / hokkaido > 1.1,
            "差が小さすぎる: {okinawa} / {hokkaido}"
        );
    }

    #[test]
    fn rejects_codes_we_do_not_understand() {
        assert!(bounds("533946").is_ok());
        assert!(bounds("5339461").is_err(), "7桁は定義が無い");
        assert!(bounds("533946115").is_err(), "区画番号5は無い");
        assert!(bounds("533984").is_err(), "2次メッシュの区画に8は無い");
        assert!(bounds("533949").is_err(), "2次メッシュの区画に9は無い");
        assert!(bounds("5339461a").is_err(), "数字以外");
    }

    #[test]
    fn polygon_is_closed_and_matches_bounds() {
        let polygon = polygon("53394611").unwrap();
        let ring = polygon.exterior();
        assert_eq!(ring.0.len(), 5, "閉じた矩形は5点");
        assert_eq!(ring.0.first(), ring.0.last());
    }
}
