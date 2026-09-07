use anyhow::{Result, bail};
use duck_geocoder::plateau;
use std::path::PathBuf;

/// PLATEAU (3D都市モデル) の CityGML zip から建物を読み、GeoParquet に変換する。
///
/// zipは展開しない。中に57,000を超えるファイル (展開後8.85GB) が入っているが、
/// 必要なのは `udx/bldg/*.gml` とコードリストだけなので、そこだけを取り出して読む。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (input, output) = match args.as_slice() {
        [_, input, output] => (PathBuf::from(input), PathBuf::from(output)),
        _ => bail!("usage: plateau_bldg_to_geoparquet <input.zip> <output.parquet>"),
    };

    let mut rows = plateau::parse_zip(&input)?;
    println!("{} 棟を読み込みました", rows.len());

    plateau::to_wgs84(&mut rows)?;
    plateau::write_geoparquet(rows, &output)?;
    println!("{} に書き出しました", output.display());
    Ok(())
}
