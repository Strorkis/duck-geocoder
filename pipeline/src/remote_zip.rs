//! HTTP Range で遠隔のファイルを `Read + Seek` として扱う。
//!
//! zipは中央ディレクトリが**末尾**にあるので、末尾だけ読めばエントリ一覧が得られ、
//! 必要なエントリだけを取り出せる。PLATEAUのCityGMLは1都市で数百MB〜250GBあり、
//! 全国では1,385GBになるので、落としてから読む道は無い。
//!
//! **このモジュールは他のモジュールを参照しない。** zipにもPLATEAUにも依存せず、
//! 「範囲を取れるもの」を `Read + Seek` に見せるだけにしてある。
//! いずれ別のクレートへ出すため。
use anyhow::{Context, Result, bail};
use std::io::{self, Read, Seek, SeekFrom};
// 辿った先のURLを取るために要る (get_uri)。
use ureq::ResponseExt;

/// まとめ読みの最小。
///
/// `zip` クレートはヘッダを数バイト単位で何度も読むので、1回のreadをそのまま
/// 1リクエストにすると往復が爆発する。まとめて取って手元で切り出す。
const MIN_CHUNK: u64 = 256 * 1024;

/// まとめ読みの上限。
///
/// 実測 (PLATEAUの配信、実体URLへ直接): 256KBで0.15秒、4MBで0.54秒、16MBで1.72秒。
/// **待ち時間が支配的なので、続けて読むときは大きく取る方が速い** (256KBだと1.7MB/s、
/// 4MBだと7.6MB/s)。ただし最初から大きくすると、ヘッダを覗くだけの場面で無駄になる。
const MAX_CHUNK: u64 = 8 * 1024 * 1024;

/// 指定した範囲のバイト列を返せるもの。
///
/// ネットワークを直接持たせないのは、`Seek` の計算を通信なしで試せるようにするため。
/// zipは末尾から中央ディレクトリを探すので、末尾相対のSeekを間違えると何も読めない。
pub trait FetchRange {
    /// ファイル全体の長さ。
    fn total_len(&self) -> Result<u64>;
    /// `[start, end]` (両端を含む) のバイト列を返す。
    fn fetch(&self, start: u64, end: u64) -> Result<Vec<u8>>;
}

/// `FetchRange` を `Read + Seek` に見せる。読んだ範囲は1つ分だけ手元に置く。
pub struct RangeReader<F: FetchRange> {
    source: F,
    len: u64,
    pos: u64,
    chunk: u64,
    /// 手元にある範囲の開始位置と中身。
    buffer: Option<(u64, Vec<u8>)>,
    /// 前回取った範囲の終端。ここから続けて読んでいれば「順に読んでいる」とみなす。
    last_end: Option<u64>,
    /// まとめ読みの大きさを固定するか (テスト用)。
    fixed_chunk: bool,
    /// 何回 fetch したか。テストと転送量の確認に使う。
    fetches: usize,
    /// 取った合計バイト数。
    fetched_bytes: u64,
}

impl<F: FetchRange> RangeReader<F> {
    pub fn new(source: F) -> Result<Self> {
        let len = source.total_len()?;
        Ok(Self {
            source,
            len,
            pos: 0,
            chunk: MIN_CHUNK,
            buffer: None,
            last_end: None,
            fixed_chunk: false,
            fetches: 0,
            fetched_bytes: 0,
        })
    }

    /// まとめ読みの大きさを固定する (テスト用)。順に読んでも大きくしない。
    pub fn with_chunk_size(mut self, chunk: u64) -> Self {
        self.chunk = chunk.max(1);
        self.fixed_chunk = true;
        self
    }

    /// 実際に取りに行った回数と合計バイト数。
    pub fn stats(&self) -> (usize, u64) {
        (self.fetches, self.fetched_bytes)
    }

    /// `pos` を含む範囲を手元に用意する。
    fn ensure_buffered(&mut self) -> Result<()> {
        if let Some((start, bytes)) = &self.buffer {
            let end = start + bytes.len() as u64;
            if self.pos >= *start && self.pos < end {
                return Ok(());
            }
        }
        let start = self.pos;
        // 続きから読んでいるなら、まとめ読みを大きくする。待ち時間が支配的なので、
        // 大きなエントリを読むときは1回あたりを増やす方がずっと速い。
        // 飛んだら最小へ戻す (ヘッダを覗くだけの場面で無駄に取らないため)。
        if !self.fixed_chunk {
            self.chunk = if self.last_end == Some(start) {
                (self.chunk * 2).min(MAX_CHUNK)
            } else {
                MIN_CHUNK
            };
        }
        // 末尾を越えて要求しない。越えると416を返すサーバーがある。
        let end = (start + self.chunk).min(self.len).saturating_sub(1);
        let bytes = self.source.fetch(start, end)?;
        // 要求した範囲ではなく、実際に返ってきた長さで覚える。
        // Rangeを丸めて短く返す相手がいると、次の読みが「続き」と判定されず
        // まとめ読みが育たなくなるため (PLATEAUの配信では短く返らないので、
        // これは備えであって実測で効いた修正ではない)。
        self.last_end = Some(start + bytes.len() as u64);
        if bytes.is_empty() {
            bail!("範囲 {start}-{end} が空で返りました");
        }
        self.fetches += 1;
        self.fetched_bytes += bytes.len() as u64;
        self.buffer = Some((start, bytes));
        Ok(())
    }
}

impl<F: FetchRange> Read for RangeReader<F> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len || out.is_empty() {
            return Ok(0);
        }
        self.ensure_buffered()
            .map_err(|e| io::Error::other(format!("{e:#}")))?;
        let (start, bytes) = self.buffer.as_ref().expect("ensure_buffered で必ず入る");
        let offset = (self.pos - start) as usize;
        let n = out.len().min(bytes.len() - offset);
        out[..n].copy_from_slice(&bytes[offset..offset + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl<F: FetchRange> Seek for RangeReader<F> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        // zip は中央ディレクトリを探すために末尾から相対でSeekする。
        // ここを取り違えると、エントリ一覧の時点で何も読めない。
        let next = match to {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::End(n) => self.len as i128 + n as i128,
            SeekFrom::Current(n) => self.pos as i128 + n as i128,
        };
        if next < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("先頭より前へのSeek: {next}"),
            ));
        }
        // 末尾より後ろへのSeekは許す (read が 0 を返す)。File と同じ振る舞い。
        self.pos = next as u64;
        Ok(self.pos)
    }
}

/// HTTPで範囲を取る `FetchRange`。
///
/// **リダイレクトは最初の1回だけ辿り、以降は実体のURLへ直接行く。**
/// PLATEAUの配信URLは302で実体へ飛ぶが、毎回辿ると実測で1リクエストあたり
/// 約1.2秒を余計に払う (256KBの取得が0.15秒→1.33秒)。何千回と読むので効く。
pub struct HttpRange {
    url: String,
    /// リダイレクトを辿った先。最初の取得で判明する。
    resolved: std::cell::OnceCell<String>,
    agent: ureq::Agent,
}

impl HttpRange {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            resolved: std::cell::OnceCell::new(),
            agent: ureq::Agent::new_with_defaults(),
        }
    }

    /// 実際に取りに行くURL。分かっていれば実体、まだなら元のURL。
    fn target(&self) -> &str {
        self.resolved.get().map(String::as_str).unwrap_or(&self.url)
    }
}

impl FetchRange for HttpRange {
    fn total_len(&self) -> Result<u64> {
        // HEADは使わない。PLATEAUの配信URLはHEADに404を返す一方、
        // GETならリダイレクトを辿って206が返る。
        // 1バイトだけ要求して Content-Range の総数から長さを取る。
        let response = self
            .agent
            .get(&self.url)
            .header("Range", "bytes=0-0")
            .call()
            .with_context(|| format!("取得できません: {}", self.url))?;
        // 辿った先を覚えておく。以降のリクエストで302を払わないため。
        let final_url = response.get_uri().to_string();
        if final_url != self.url {
            let _ = self.resolved.set(final_url);
        }
        let range = response
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .with_context(|| {
                format!(
                    "Content-Range がありません (Rangeに対応していない): {}",
                    self.url
                )
            })?;
        // 形式は "bytes 0-0/483129586"
        range
            .rsplit('/')
            .next()
            .and_then(|total| total.trim().parse::<u64>().ok())
            .with_context(|| format!("Content-Range を読めません: {range}"))
    }

    fn fetch(&self, start: u64, end: u64) -> Result<Vec<u8>> {
        let target = self.target();
        let mut response = self
            .agent
            .get(target)
            .header("Range", &format!("bytes={start}-{end}"))
            .call()
            .with_context(|| format!("範囲 {start}-{end} を取得できません: {target}"))?;
        if response.status() != 206 {
            bail!(
                "206ではなく {} が返りました (Rangeに対応していない): {target}",
                response.status(),
            );
        }
        let mut bytes = Vec::with_capacity((end - start + 1) as usize);
        response
            .body_mut()
            .as_reader()
            .read_to_end(&mut bytes)
            .with_context(|| format!("範囲 {start}-{end} を読めません"))?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// 手元のバイト列を返すだけの `FetchRange`。通信しないのでSeekの計算を試せる。
    struct Fake {
        data: Vec<u8>,
        calls: RefCell<Vec<(u64, u64)>>,
    }

    impl Fake {
        fn new(data: Vec<u8>) -> Self {
            Self {
                data,
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl FetchRange for Fake {
        fn total_len(&self) -> Result<u64> {
            Ok(self.data.len() as u64)
        }
        fn fetch(&self, start: u64, end: u64) -> Result<Vec<u8>> {
            self.calls.borrow_mut().push((start, end));
            Ok(self.data[start as usize..=(end as usize).min(self.data.len() - 1)].to_vec())
        }
    }

    fn sample() -> Vec<u8> {
        (0..=255u8).cycle().take(1000).collect()
    }

    #[test]
    fn reads_from_the_start() {
        let mut reader = RangeReader::new(Fake::new(sample())).unwrap();
        let mut buf = [0u8; 4];
        reader.read_exact(&mut buf).unwrap();
        assert_eq!(buf, [0, 1, 2, 3]);
    }

    // zip は中央ディレクトリを探すために末尾から相対でSeekする。
    // ここを取り違えると、エントリ一覧の時点で何も読めない。
    #[test]
    fn seeks_relative_to_the_end() {
        let data = sample();
        let mut reader = RangeReader::new(Fake::new(data.clone())).unwrap();
        reader.seek(SeekFrom::End(-3)).unwrap();
        let mut buf = [0u8; 3];
        reader.read_exact(&mut buf).unwrap();
        assert_eq!(buf.to_vec(), data[997..1000].to_vec());
    }

    #[test]
    fn seeks_relative_to_the_current_position() {
        let mut reader = RangeReader::new(Fake::new(sample())).unwrap();
        reader.seek(SeekFrom::Start(10)).unwrap();
        reader.seek(SeekFrom::Current(5)).unwrap();
        let mut buf = [0u8; 1];
        reader.read_exact(&mut buf).unwrap();
        assert_eq!(buf[0], 15);
    }

    #[test]
    fn rejects_seeking_before_the_start() {
        let mut reader = RangeReader::new(Fake::new(sample())).unwrap();
        assert!(reader.seek(SeekFrom::End(-2000)).is_err());
    }

    // 末尾より後ろへのSeekは File と同じく許し、readは0を返す。
    #[test]
    fn reads_nothing_past_the_end() {
        let mut reader = RangeReader::new(Fake::new(sample())).unwrap();
        reader.seek(SeekFrom::Start(5000)).unwrap();
        assert_eq!(reader.read(&mut [0u8; 4]).unwrap(), 0);
    }

    /// 要求より短く返す相手。Rangeを丸めるサーバーがある。
    struct ShortFetch {
        data: Vec<u8>,
        /// 要求された範囲の大きさ。まとめ読みが育っているかを見る。
        requested: RefCell<Vec<u64>>,
    }

    impl FetchRange for ShortFetch {
        fn total_len(&self) -> Result<u64> {
            Ok(self.data.len() as u64)
        }
        fn fetch(&self, start: u64, end: u64) -> Result<Vec<u8>> {
            let asked = end - start + 1;
            self.requested.borrow_mut().push(asked);
            // 要求の半分しか返さない。
            let give = (asked / 2).max(1) as usize;
            let stop = (start as usize + give).min(self.data.len());
            Ok(self.data[start as usize..stop].to_vec())
        }
    }

    // 短く返されたときに、続きを「続き」と見なせること。
    // 要求した範囲の方で覚えていると「飛んだ」と誤判定してまとめ読みが育たない。
    #[test]
    fn keeps_growing_even_when_the_server_returns_less_than_asked() {
        // 最小(256KB)より十分大きくしないと、育ちようがなくて判別できない。
        let data: Vec<u8> = (0..=255u8).cycle().take(4 * 1024 * 1024).collect();
        let source = ShortFetch {
            data: data.clone(),
            requested: RefCell::new(Vec::new()),
        };
        let mut reader = RangeReader::new(source).unwrap();
        let mut got = Vec::new();
        reader.read_to_end(&mut got).unwrap();
        assert_eq!(got, data, "全部読めること");

        let requested = reader.source.requested.borrow();
        let biggest = requested.iter().copied().max().unwrap();
        assert!(
            biggest > MIN_CHUNK,
            "まとめ読みが育っていない (最大 {biggest}、最小 {MIN_CHUNK})"
        );
    }

    // まとめ読みが効かないと、zipのヘッダ読みだけで往復が爆発する。
    #[test]
    fn buffers_so_nearby_reads_share_one_fetch() {
        let mut reader = RangeReader::new(Fake::new(sample()))
            .unwrap()
            .with_chunk_size(512);
        for _ in 0..100 {
            reader.read_exact(&mut [0u8; 1]).unwrap();
        }
        assert_eq!(reader.stats().0, 1, "100回読んでも取得は1回のはず");
    }

    // 末尾を越えた範囲を要求すると416を返すサーバーがある。
    #[test]
    fn never_requests_past_the_end() {
        let data = sample();
        let fake = Fake::new(data.clone());
        let mut reader = RangeReader::new(fake).unwrap().with_chunk_size(4096);
        reader.seek(SeekFrom::Start(900)).unwrap();
        reader.read_exact(&mut [0u8; 10]).unwrap();
        let (_, end) = *reader.source.calls.borrow().last().unwrap();
        assert!(end < data.len() as u64, "末尾 {end} を要求している");
    }
}
