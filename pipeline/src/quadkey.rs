//! QuadKey (Bing Maps のタイル番号を4進数の文字列にしたもの)。
//!
//! **世界のデータを分けるときに使う。** 日本のデータは地域メッシュ (JIS X 0410) で
//! 分けているが、あれは日本の基準なので、Overture のような世界のデータには使わない。
//!
//! QuadKey を選んだ理由:
//! - **緯度経度から計算で決まる。** 境界データも拡張も要らない (H3 は DuckDB の
//!   コミュニティ拡張に依存する)
//! - **矩形。** ファイルの bbox とタイルが一致するので、表示範囲で読み飛ばす
//!   (`filesInView`) がそのまま効く
//! - **前から切ると親になる** (`"1330"` の親は `"133"`)。地域メッシュと同じ性質
//!
//! 座標は Web メルカトル (EPSG:3857) のタイル分割に従う。緯度は ±85.05112878° で切る。

use anyhow::{Result, bail};
use std::f64::consts::PI;

/// Web メルカトルで扱える緯度の上限。
const MAX_LATITUDE: f64 = 85.051_128_78;

/// 緯度経度の点が入るタイル `(x, y)`。
pub fn tile(lon: f64, lat: f64, zoom: u8) -> (u32, u32) {
    let n = f64::from(1u32 << zoom);
    let lat = lat.clamp(-MAX_LATITUDE, MAX_LATITUDE).to_radians();
    let x = ((lon + 180.0) / 360.0 * n).floor();
    let y = ((1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / PI) / 2.0 * n).floor();
    // 東端・南端ちょうどの点は次のタイルを指すので、端のタイルに収める。
    let max = n - 1.0;
    (x.clamp(0.0, max) as u32, y.clamp(0.0, max) as u32)
}

/// タイル `(x, y)` の QuadKey。桁数がズームになる。
pub fn from_tile(x: u32, y: u32, zoom: u8) -> String {
    (1..=zoom)
        .rev()
        .map(|i| {
            let bit = 1u32 << (i - 1);
            let digit = u8::from(x & bit != 0) + 2 * u8::from(y & bit != 0);
            char::from(b'0' + digit)
        })
        .collect()
}

/// 緯度経度の点が入るタイルの QuadKey。
pub fn quadkey(lon: f64, lat: f64, zoom: u8) -> String {
    let (x, y) = tile(lon, lat, zoom);
    from_tile(x, y, zoom)
}

/// QuadKey が覆う範囲 `[west, south, east, north]` (度)。
pub fn bounds(key: &str) -> Result<[f64; 4]> {
    let mut x = 0u32;
    let mut y = 0u32;
    for ch in key.chars() {
        let digit = match ch {
            '0'..='3' => ch as u32 - '0' as u32,
            other => bail!("QuadKey に使えない文字です: {other:?} ({key})"),
        };
        x = (x << 1) | (digit & 1);
        y = (y << 1) | (digit >> 1);
    }
    let n = f64::from(1u32 << key.len());
    let lon = |x: f64| x / n * 360.0 - 180.0;
    let lat = |y: f64| (PI * (1.0 - 2.0 * y / n)).sinh().atan().to_degrees();
    Ok([
        lon(f64::from(x)),
        lat(f64::from(y) + 1.0),
        lon(f64::from(x) + 1.0),
        lat(f64::from(y)),
    ])
}

/// DuckDB で QuadKey を求める式。`lon` `lat` は列や式 (度)。
///
/// [`quadkey`] と同じ計算。**Rust側と結果が一致することをテストで見ている**
/// (`tests/quadkey_sql.rs`)。
pub fn sql_expression(lon: &str, lat: &str, zoom: u8) -> String {
    let n = 1u64 << zoom;
    let max = n - 1;
    let lat = format!("radians(least(greatest({lat}, -{MAX_LATITUDE}), {MAX_LATITUDE}))");
    let x = format!("least(greatest(floor(({lon} + 180.0) / 360.0 * {n}), 0), {max})::BIGINT");
    let y = format!(
        "least(greatest(floor((1.0 - ln(tan({lat}) + 1.0 / cos({lat})) / pi()) / 2.0 * {n}), 0), {max})::BIGINT"
    );
    format!(
        "array_to_string(list_transform(range({zoom}, 0, -1), \
         lambda i: (((({x}) >> (i - 1)) & 1) + 2 * ((({y}) >> (i - 1)) & 1))::VARCHAR), '')"
    )
}

/// **件数に応じて細かさを変えたタイルの組** (適応的な四分木) を選ぶ。
///
/// 同じズームで切ると、建物の密度の差が大きすぎる。実測 (日本付近の Overture 建物
/// 7,405万棟) でズーム10でも最大195万棟のタイルがあり、`repack` はファイルを丸ごと
/// メモリに読む (1棟約1.1KB) ので2GBを超える。一方で細かくすると、過疎地は数棟の
/// ファイルが数千に増える。そこで**多いタイルだけ割る。**
///
/// - `counts`: ズーム `max_zoom` の QuadKey ごとの件数 (0件のキーは入れない)
/// - `min_zoom` から始め、件数が `max_rows` を超えるタイルを4つに割る。
///   `max_zoom` まで割っても超えるものはそのまま (それ以上は割らない)
///
/// 返すキーは**互いに接頭辞にならない** (どの建物もちょうど1つのタイルに入る)。
pub fn choose_tiles(
    counts: &std::collections::BTreeMap<String, u64>,
    min_zoom: usize,
    max_zoom: usize,
    max_rows: u64,
) -> Vec<String> {
    use std::collections::BTreeMap;
    // 接頭辞ごとの合計。
    let mut totals: BTreeMap<&str, u64> = BTreeMap::new();
    for (key, count) in counts {
        assert_eq!(
            key.len(),
            max_zoom,
            "件数は max_zoom のキーで渡すこと: {key}"
        );
        for len in min_zoom..=max_zoom {
            *totals.entry(&key[..len]).or_default() += count;
        }
    }
    let mut chosen = Vec::new();
    let mut stack: Vec<String> = totals
        .keys()
        .filter(|key| key.len() == min_zoom)
        .map(|key| (*key).to_string())
        .collect();
    while let Some(key) = stack.pop() {
        let total = totals.get(key.as_str()).copied().unwrap_or(0);
        if total == 0 {
            continue;
        }
        if total <= max_rows || key.len() == max_zoom {
            chosen.push(key);
        } else {
            for digit in ['0', '1', '2', '3'] {
                stack.push(format!("{key}{digit}"));
            }
        }
    }
    chosen.sort();
    chosen
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **多いタイルだけ割る。** 割ったものと割らなかったものが混ざり、
    /// どのキーも他のキーの接頭辞にならない。
    #[test]
    fn splits_only_the_crowded_tiles() {
        use std::collections::BTreeMap;
        let counts: BTreeMap<String, u64> = [
            ("1300", 50),
            ("1301", 50),
            ("1302", 50),
            ("1310", 5),
            ("2000", 1),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let tiles = choose_tiles(&counts, 2, 4, 100);
        // "13" は155件で上限を超えるので割る。"130" は150件でまだ超えるので更に割る。
        // "131" は5件で割らない。"20" は1件で割らない。
        assert_eq!(tiles, ["1300", "1301", "1302", "131", "20"]);
        for a in &tiles {
            for b in &tiles {
                assert!(a == b || !b.starts_with(a.as_str()), "{a} は {b} の接頭辞");
            }
        }
        // 件数が失われない。
        let total: u64 = counts.values().sum();
        let covered: u64 = counts
            .iter()
            .filter(|(k, _)| tiles.iter().any(|t| k.starts_with(t.as_str())))
            .map(|(_, v)| v)
            .sum();
        assert_eq!(covered, total);
    }

    /// 最大ズームまで割っても超えるものは、そこで止める (無限に割らない)。
    #[test]
    fn stops_at_the_max_zoom() {
        use std::collections::BTreeMap;
        let counts: BTreeMap<String, u64> = [("123".to_string(), 1_000)].into_iter().collect();
        assert_eq!(choose_tiles(&counts, 1, 3, 10), ["123"]);
    }

    /// Bing Maps の解説にある例 (タイル 3,5 / ズーム3 → "213")。
    #[test]
    fn matches_the_documented_example() {
        assert_eq!(from_tile(3, 5, 3), "213");
    }

    /// 東京駅。ズーム8のタイルは (227, 100)。
    #[test]
    fn tokyo_station() {
        assert_eq!(tile(139.7671, 35.6812, 8), (227, 100));
        let key = quadkey(139.7671, 35.6812, 8);
        assert_eq!(key.len(), 8);
        let [w, s, e, n] = bounds(&key).unwrap();
        assert!(w <= 139.7671 && 139.7671 < e, "{w} {e}");
        assert!(s <= 35.6812 && 35.6812 < n, "{s} {n}");
    }

    /// **前から切ると親になる。** 子の範囲は親の範囲に収まる。
    #[test]
    fn a_prefix_is_the_parent() {
        let child = quadkey(139.7671, 35.6812, 10);
        let parent = &child[..7];
        assert_eq!(quadkey(139.7671, 35.6812, 7), parent);
        let [cw, cs, ce, cn] = bounds(&child).unwrap();
        let [pw, ps, pe, pn] = bounds(parent).unwrap();
        assert!(pw <= cw && ps <= cs && ce <= pe && cn <= pn);
    }

    #[test]
    fn clamps_edges_and_poles() {
        assert_eq!(tile(180.0, 0.0, 2).0, 3);
        assert_eq!(tile(0.0, 90.0, 2).1, 0);
        assert_eq!(tile(0.0, -90.0, 2).1, 3);
    }

    #[test]
    fn rejects_bad_digits() {
        assert!(bounds("1234").is_err());
    }
}
