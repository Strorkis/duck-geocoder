use anyhow::{Result, bail};
use duck_geocoder::remote_zip::{HttpRange, RangeReader};
use duck_geocoder::{plateau, plateau_catalog};
use std::path::{Path, PathBuf};

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
        [_, "--cities", list, out_dir] => from_cities(list, PathBuf::from(out_dir)),
        [_, input, output] => from_local(PathBuf::from(input), PathBuf::from(output)),
        _ => bail!(
            "usage:\n  \
             plateau_bldg_to_geoparquet <input.zip> <output.parquet>\n  \
             plateau_bldg_to_geoparquet --city <5桁コード> <output.parquet>\n  \
             plateau_bldg_to_geoparquet --cities <コード,...|all> <出力ディレクトリ>\n\n\
             例:\n  \
             plateau_bldg_to_geoparquet --city 13103 ../data/output/plateau_bldg_13103.parquet\n  \
             plateau_bldg_to_geoparquet --cities all ../data/plateau_bldg/"
        ),
    }
}

/// 複数の都市をまとめて変換する。
///
/// **途中で止まっても続きから再開できる。** 既にあるファイルは飛ばすので、
/// 306都市の変換を何度かに分けて回せる (配信元にも優しい)。
/// 1都市で落ちても止めず、最後にまとめて報告する。
fn from_cities(list: &str, out_dir: PathBuf) -> Result<()> {
    std::fs::create_dir_all(&out_dir)?;
    eprintln!("カタログを取得しています...");
    let all = plateau_catalog::fetch_catalog()?;
    let targets: Vec<&plateau_catalog::City> = if list == "all" {
        all.iter().filter(|c| c.has_buildings()).collect()
    } else {
        list.split(',')
            .map(|code| plateau_catalog::find_city(&all, code))
            .collect::<Result<Vec<_>>>()?
    };

    let mut done = 0;
    let mut skipped = 0;
    let mut failed = Vec::new();
    for (index, city) in targets.iter().enumerate() {
        let output = out_dir.join(format!("plateau_bldg_{}.parquet", city.city_code));
        if output.exists() {
            skipped += 1;
            continue;
        }
        eprintln!(
            "[{}/{}] {} {}",
            index + 1,
            targets.len(),
            city.pref,
            city.city
        );
        match convert_city(city, &output) {
            Ok(()) => done += 1,
            Err(e) => {
                eprintln!("  失敗: {e:#}");
                failed.push(format!("{} {}", city.city_code, city.city));
            }
        }
    }

    println!(
        "変換 {done} / 既存を飛ばした {skipped} / 失敗 {}",
        failed.len()
    );
    if !failed.is_empty() {
        println!("失敗した都市: {}", failed.join(", "));
    }
    Ok(())
}

fn from_local(input: PathBuf, output: PathBuf) -> Result<()> {
    let rows = plateau::parse_zip(&input)?;
    // 手元のzipからだと配布元のURLが分からない。
    // **推測で埋めない** (同じファイル名でも出所が違いうる)。
    finish(rows, output, None)
}

fn from_city(city_code: &str, output: PathBuf) -> Result<()> {
    eprintln!("カタログを取得しています...");
    let cities = plateau_catalog::fetch_catalog()?;
    let city = plateau_catalog::find_city(&cities, city_code)?;
    eprintln!(
        "{} {} / zip全体 {:.1} GB — このうち建物とコードリストだけを読みます",
        city.pref,
        city.city,
        city.file_size as f64 / 1024.0 / 1024.0 / 1024.0,
    );
    convert_city(city, &output)
}

fn convert_city(city: &plateau_catalog::City, output: &Path) -> Result<()> {
    if !city.has_buildings() {
        bail!(
            "{} {} は建物を収録していません (収録: {})",
            city.pref,
            city.city,
            city.feature_types.join(", ")
        );
    }
    let mut reader = RangeReader::new(HttpRange::new(&city.url))?;
    let rows = plateau::parse_archive(&mut reader, &format!("{} ({})", city.city, city.url))?;

    // 落とさずに済んでいることを数字で見せる。桁が違えば設計を間違えている。
    let (requests, bytes) = reader.stats();
    eprintln!(
        "  取得 {:.1} MB / {} リクエスト (zip全体の {:.1}%)",
        bytes as f64 / 1024.0 / 1024.0,
        requests,
        100.0 * bytes as f64 / city.file_size as f64,
    );
    // 配布元のzipのURLをファイルに残す。実物が欲しい人が辿れるようにするため。
    finish(rows, output.to_path_buf(), Some(&city.url))
}

fn finish(mut rows: Vec<plateau::Row>, output: PathBuf, via: Option<&str>) -> Result<()> {
    println!("{} 棟を読み込みました", rows.len());
    plateau::to_wgs84(&mut rows)?;
    plateau::write_geoparquet(rows, &output, via)?;
    println!("{} に書き出しました", output.display());
    Ok(())
}
