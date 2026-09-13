use anyhow::{Context, Result, bail};
use duck_geocoder::plateau_catalog::{self, City};
use duck_geocoder::remote_zip::{HttpRange, RangeReader};
use std::time::Instant;

/// PLATEAUの各都市に建物がどれだけ入っているかを、**変換せずに**測る。
///
/// 全306都市を変換すると配信元から84GBを引いて5時間かかる。規模を知るだけなら
/// そこまで要らない。zipの中央ディレクトリとローカルヘッダだけ読めば、
/// 建物GMLの本数と大きさが分かる (データ本体は読まない)。
///
/// 結果はCSVで標準出力へ。表計算や duckdb にそのまま流せる。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let selector = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [_, "--cities", list] => Selector::Codes(list.split(',').map(str::to_string).collect()),
        [_, "--sample", n] => Selector::Sample(n.parse().context("--sample には件数を渡す")?),
        [_, "--all"] => Selector::All,
        _ => bail!(
            "usage:\n  \
             plateau_survey --cities 13103,27100,17201\n  \
             plateau_survey --sample 30   # zipの大きさ順に等間隔で選ぶ\n  \
             plateau_survey --all         # 306都市すべて (時間がかかる)"
        ),
    };

    eprintln!("カタログを取得しています...");
    let all = plateau_catalog::fetch_catalog()?;
    let targets = selector.pick(&all)?;
    eprintln!("{} 都市を調べます", targets.len());

    println!("city_code,city,pref,zip_bytes,bldg_files,bldg_bytes,fetched_bytes,seconds");
    for city in targets {
        match survey(city) {
            Ok(row) => println!(
                "{},{},{},{},{},{},{},{:.1}",
                city.city_code,
                city.city,
                city.pref,
                city.file_size,
                row.bldg_files,
                row.bldg_bytes,
                row.fetched_bytes,
                row.seconds,
            ),
            // 1都市で止めない。落ちた都市を報告して次へ進む。
            Err(e) => eprintln!("{} {} を調べられません: {e:#}", city.city_code, city.city),
        }
    }
    Ok(())
}

enum Selector {
    Codes(Vec<String>),
    Sample(usize),
    All,
}

impl Selector {
    fn pick<'a>(&self, all: &'a [City]) -> Result<Vec<&'a City>> {
        let with_buildings: Vec<&City> = all.iter().filter(|c| c.has_buildings()).collect();
        match self {
            Selector::Codes(codes) => codes
                .iter()
                .map(|code| plateau_catalog::find_city(all, code))
                .collect(),
            Selector::All => Ok(with_buildings),
            // zipの大きさ順に等間隔で拾う。密集市街地から広域までを跨ぐようにするため、
            // 先頭から順に取ると小さい都市ばかりになる。
            Selector::Sample(n) => {
                let mut sorted = with_buildings;
                sorted.sort_by_key(|c| c.file_size);
                if sorted.is_empty() || *n == 0 {
                    bail!("選べる都市がありません");
                }
                let step = (sorted.len() as f64 / *n as f64).max(1.0);
                Ok((0..*n)
                    .map(|i| sorted[((i as f64 * step) as usize).min(sorted.len() - 1)])
                    .collect())
            }
        }
    }
}

struct Row {
    bldg_files: usize,
    bldg_bytes: u64,
    fetched_bytes: u64,
    seconds: f64,
}

fn survey(city: &City) -> Result<Row> {
    let started = Instant::now();
    let mut reader = RangeReader::new(HttpRange::new(&city.url))?;
    let mut archive = zip::ZipArchive::new(&mut reader)
        .with_context(|| format!("zipとして読めません: {}", city.url))?;

    // **`file_names()` を使うこと。** `by_index_raw` は1件ごとにローカルヘッダを
    // 読みに行くので、5万を超えるエントリでファイル全体を引きずる。
    let names: Vec<String> = archive
        .file_names()
        .filter(|name| name.starts_with("udx/bldg/") && name.ends_with(".gml"))
        .map(str::to_string)
        .collect();

    // 大きさはローカルヘッダに入っている。データ本体は読まずに捨てる。
    let mut bldg_bytes = 0;
    for name in &names {
        bldg_bytes += archive
            .by_name(name)
            .with_context(|| format!("エントリを開けません: {name}"))?
            .compressed_size();
    }
    drop(archive);

    let (_, fetched_bytes) = reader.stats();
    Ok(Row {
        bldg_files: names.len(),
        bldg_bytes,
        fetched_bytes,
        seconds: started.elapsed().as_secs_f64(),
    })
}
