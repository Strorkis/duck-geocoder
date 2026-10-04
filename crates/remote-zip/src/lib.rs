//! **置いてある zip を、落とさずに中身の一部だけ取り出す。**
//!
//! zip は中央ディレクトリ (エントリの一覧) が**末尾**にあるので、HTTP Range で末尾だけ
//! 読めば一覧が得られ、要るエントリの範囲だけを取りに行ける。**配信元に API が無くても、
//! Range に応えるだけで使える** — PLATEAU の CityGML (1都市で数百MB〜250GB、全国で
//! 1,385GB) から建物の GML だけを抜くのに使っている。
//!
//! - [`RangeReader`] と [`HttpRange`] — Range で取れるものを `Read + Seek` に見せる
//! - [`for_each_entry`] — 一致するエントリを1つずつ取り出す (全体を展開しない)
//! - [`open`] と [`list`] — URL の zip を開く・一覧を取る
//!
//! 配信元の負荷について: 公式の取得サービス (エントリ単位の配信など) があるなら、
//! そちらの方が配信元に優しいことがある。これは「それが無いとき」の道具。
use anyhow::{Context, Result, bail};
use std::io::{Read, Seek};

pub mod range;

pub use range::{FetchRange, HttpRange, RangeReader};

/// zip の1エントリの素性 (一覧に出すもの)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    /// 展開後の大きさ。
    pub size: u64,
    /// zip の中での大きさ (圧縮後)。取りに行く量の目安。
    pub compressed_size: u64,
}

/// URL の zip を開く。**中央ディレクトリ (末尾) だけを読む。**
pub fn open(url: &str) -> Result<zip::ZipArchive<RangeReader<HttpRange>>> {
    let reader = RangeReader::new(HttpRange::new(url))?;
    zip::ZipArchive::new(reader).with_context(|| format!("zipとして読めません: {url}"))
}

/// zip のエントリの一覧。`Read + Seek` なら何でもよい (手元のファイルでも Range でも)。
pub fn list(source: impl Read + Seek, label: &str) -> Result<Vec<Entry>> {
    let mut archive =
        zip::ZipArchive::new(source).with_context(|| format!("zipとして読めません: {label}"))?;
    (0..archive.len())
        .map(|i| {
            let entry = archive.by_index_raw(i)?;
            Ok(Entry {
                name: entry.name().to_string(),
                size: entry.size(),
                compressed_size: entry.compressed_size(),
            })
        })
        .collect()
}

/// zip の中で `matches` に一致するエントリを、名前順に1つずつ読んで `handle` に渡す。
///
/// **アーカイブは一度しか開かない** (中央ディレクトリの読み直しを繰り返さない)。
/// 展開したバイト列は1エントリずつ渡して捨てるので、zip 全体を展開せずに済む。
/// `label` はエラーに出す名前 (パスや URL)。一致するものが無ければエラーにする。
pub fn for_each_entry(
    source: impl Read + Seek,
    label: &str,
    matches: impl Fn(&str) -> bool,
    mut handle: impl FnMut(&str, Vec<u8>) -> Result<()>,
) -> Result<()> {
    let mut archive =
        zip::ZipArchive::new(source).with_context(|| format!("zipとして読めません: {label}"))?;

    // 名前を先に集める。読み出し中は archive を可変で借りるため、
    // 反復しながら by_name を呼べない。
    let mut names: Vec<String> = (0..archive.len())
        .map(|i| Ok(archive.by_index(i)?.name().to_string()))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter(|name| matches(name))
        .collect();
    names.sort();

    if names.is_empty() {
        bail!("一致するエントリがありません: {label}");
    }

    for name in &names {
        let mut entry = archive
            .by_name(name)
            .with_context(|| format!("エントリを開けません: {name}"))?;
        let mut buf = Vec::with_capacity(entry.size() as usize);
        std::io::copy(&mut entry, &mut buf)
            .with_context(|| format!("エントリを読めません: {name}"))?;
        handle(name, buf)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    /// 手元で zip を作る (エントリ名 → 中身)。
    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn lists_entries() {
        let bytes = zip_of(&[("a/one.gml", b"1"), ("b/two.txt", b"22")]);
        let entries = list(Cursor::new(bytes), "test").unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["a/one.gml", "b/two.txt"]);
        assert_eq!(entries[1].size, 2);
    }

    #[test]
    fn reads_only_matching_entries_in_name_order() {
        let bytes = zip_of(&[
            ("udx/bldg/2.gml", b"two"),
            ("udx/tran/x.gml", b"road"),
            ("udx/bldg/1.gml", b"one"),
        ]);
        let mut seen = Vec::new();
        for_each_entry(
            Cursor::new(bytes),
            "test",
            |name| name.starts_with("udx/bldg/"),
            |name, body| {
                seen.push((name.to_string(), String::from_utf8(body).unwrap()));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            seen,
            [
                ("udx/bldg/1.gml".to_string(), "one".to_string()),
                ("udx/bldg/2.gml".to_string(), "two".to_string()),
            ]
        );
    }

    #[test]
    fn refuses_when_nothing_matches() {
        let bytes = zip_of(&[("a.txt", b"x")]);
        let error =
            for_each_entry(Cursor::new(bytes), "test", |_| false, |_, _| Ok(())).unwrap_err();
        assert!(error.to_string().contains("一致するエントリがありません"));
    }
}
