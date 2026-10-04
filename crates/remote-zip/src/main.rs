use anyhow::{Context, Result, bail};
use std::path::PathBuf;

/// 置いてある zip を、落とさずに中身の一部だけ取り出す (HTTP Range)。
///
/// ```text
/// remote-zip ls  <URL>                      エントリの一覧 (末尾の中央ディレクトリだけ読む)
/// remote-zip get <URL> <エントリ> [出力]     1つ取り出す (出力を省くと標準出力へ)
/// ```
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [_, "ls", url] => {
            let reader = remote_zip::RangeReader::new(remote_zip::HttpRange::new(*url))?;
            let entries = remote_zip::list(reader, url)?;
            for entry in &entries {
                println!("{:>12}  {}", entry.compressed_size, entry.name);
            }
            eprintln!("{} 件", entries.len());
            Ok(())
        }
        [_, "get", url, name, rest @ ..] => {
            let out = rest.first().map(PathBuf::from);
            let reader = remote_zip::RangeReader::new(remote_zip::HttpRange::new(*url))?;
            remote_zip::for_each_entry(
                reader,
                url,
                |entry| entry == *name,
                |_, body| match &out {
                    Some(path) => std::fs::write(path, body)
                        .with_context(|| format!("書けません: {}", path.display())),
                    None => {
                        use std::io::Write;
                        std::io::stdout().write_all(&body)?;
                        Ok(())
                    }
                },
            )
        }
        _ => bail!(
            "usage:\n  remote-zip ls  <URL>\n  remote-zip get <URL> <エントリ> [出力]\n\n\
             zip の末尾 (中央ディレクトリ) と要るエントリの範囲だけを HTTP Range で取る。\n\
             配信元が Range に応えれば、API が無くても使える。"
        ),
    }
}
