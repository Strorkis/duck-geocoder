//! このプロセスがこれまでに使った最大メモリを読む。
//!
//! **並列数で資源を抑える設計の根拠を、数字で出すためにある。**
//! 1都市あたりの山が分からないと「`--jobs` を上げると比例して増える」と言えない。
//!
//! 実測 (港区・建物5.1万棟): 変換が365MB、空間パックが56MB。
//! 建物CityGMLの大きさは横浜市が469MBで港区の2.4倍なので、
//! いちばん重い都市は800MB台になる見込み。
use std::fmt;

/// Linuxの `VmHWM` (high water mark) をバイトで返す。読めなければ `None`。
///
/// **プロセス全体の最大値**なので、都市ごとの山を知るには順に見て増分を取る。
/// 並列に走らせているときは合計の山になる (それが知りたい数字でもある)。
pub fn peak_bytes() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        let Some(rest) = line.strip_prefix("VmHWM:") else {
            continue;
        };
        // "VmHWM:	  365164 kB" の形。単位はkB固定。
        let mut parts = rest.split_whitespace();
        let value: u64 = parts.next()?.parse().ok()?;
        return Some(value * 1024);
    }
    None
}

/// 人が読む形にした最大メモリ。読めなければ「不明」と出す。
///
/// **読めないことをエラーにしない。** Linux以外では `/proc` が無いが、
/// 変換そのものは動く。報告が出ないだけにする。
pub struct Peak(pub Option<u64>);

impl Peak {
    pub fn now() -> Self {
        Self(peak_bytes())
    }
}

impl fmt::Display for Peak {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            Some(bytes) => write!(f, "{:.0} MB", bytes as f64 / 1024.0 / 1024.0),
            None => write!(f, "不明"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Linuxでは読めること。**0ではないこと**まで見る
    // (パースを間違えて0を返しても気付けるように)。
    #[test]
    #[cfg(target_os = "linux")]
    fn reads_the_peak_on_linux() {
        let bytes = peak_bytes().expect("Linuxなら /proc/self/status が読める");
        assert!(bytes > 0, "最大メモリが0になっている");
    }

    // 読めないときに落ちないこと。表示は「不明」になる。
    #[test]
    fn shows_unknown_when_it_cannot_be_read() {
        assert_eq!(Peak(None).to_string(), "不明");
        assert_eq!(Peak(Some(365_164 * 1024)).to_string(), "357 MB");
    }
}
