use anyhow::{Result, bail};
use duck_geocoder::remote_zip::{HttpRange, RangeReader};
use duck_geocoder::{plateau, plateau_catalog};
use std::path::PathBuf;

/// PLATEAU (3D都市モデル) の CityGML zip から建物を読み、GeoParquet に変換する。
///
/// zipは展開しない。中に57,000を超えるファイル (展開後8.85GB) が入っているが、
/// 必要なのは `udx/bldg/*.gml` とコードリストだけなので、そこだけを取り出して読む。
///
/// `--city` を使うと、**zipを落とさずに**公式カタログ経由でHTTP Rangeで読む。
/// PLATEAUのCityGMLは全国で1,385GB (最大の浜松市だけで250GB) あり、
/// 落としてから読む道が無いため。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [_, "--city", city_code, output] => from_city(city_code, PathBuf::from(output)),
        [_, input, output] => from_local(PathBuf::from(input), PathBuf::from(output)),
        _ => bail!(
            "usage:\n  \
             plateau_bldg_to_geoparquet <input.zip> <output.parquet>\n  \
             plateau_bldg_to_geoparquet --city <5桁の全国地方公共団体コード> <output.parquet>\n\n\
             例:\n  \
             plateau_bldg_to_geoparquet --city 13103 ../data/output/plateau_bldg_13103.parquet"
        ),
    }
}

fn from_local(input: PathBuf, output: PathBuf) -> Result<()> {
    let rows = plateau::parse_zip(&input)?;
    finish(rows, output)
}

fn from_city(city_code: &str, output: PathBuf) -> Result<()> {
    eprintln!("カタログを取得しています...");
    let cities = plateau_catalog::fetch_catalog()?;
    let city = plateau_catalog::find_city(&cities, city_code)?;
    if !city.has_buildings() {
        bail!(
            "{} {} は建物を収録していません (収録: {})",
            city.pref,
            city.city,
            city.feature_types.join(", ")
        );
    }
    eprintln!(
        "{} {} / zip全体 {:.1} GB — このうち建物とコードリストだけを読みます",
        city.pref,
        city.city,
        city.file_size as f64 / 1024.0 / 1024.0 / 1024.0,
    );

    let mut reader = RangeReader::new(HttpRange::new(&city.url))?;
    let rows = plateau::parse_archive(&mut reader, &format!("{} ({})", city.city, city.url))?;

    // 落とさずに済んでいることを数字で見せる。桁が違えば設計を間違えている。
    let (requests, bytes) = reader.stats();
    eprintln!(
        "取得: {:.1} MB / {} リクエスト (zip全体の {:.1}%)",
        bytes as f64 / 1024.0 / 1024.0,
        requests,
        100.0 * bytes as f64 / city.file_size as f64,
    );
    finish(rows, output)
}

fn finish(mut rows: Vec<plateau::Row>, output: PathBuf) -> Result<()> {
    println!("{} 棟を読み込みました", rows.len());
    plateau::to_wgs84(&mut rows)?;
    plateau::write_geoparquet(rows, &output)?;
    println!("{} に書き出しました", output.display());
    Ok(())
}
