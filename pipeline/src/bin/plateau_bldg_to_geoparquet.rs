use anyhow::{Context, Result, bail};
use duck_geocoder::remote_zip::{HttpRange, RangeReader};
use duck_geocoder::{peak_memory, plateau, plateau_catalog, repack};
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
        [_, "--cities", list, out_dir] => from_cities(list, PathBuf::from(out_dir), 1),
        [_, "--cities", list, out_dir, "--jobs", jobs] => {
            from_cities(list, PathBuf::from(out_dir), parse_jobs(jobs)?)
        }
        [_, input, output] => from_local(PathBuf::from(input), PathBuf::from(output)),
        _ => bail!(
            "usage:\n  \
             plateau_bldg_to_geoparquet <input.zip> <output.parquet>\n  \
             plateau_bldg_to_geoparquet --city <5桁コード> <output.parquet>\n  \
             plateau_bldg_to_geoparquet --cities <コード,...|all> <出力ディレクトリ> [--jobs N]\n\n\
             --jobs は同時に処理する都市の数 (既定1)。メモリと配信元への同時接続数の\n\
             両方がこれで決まる。実測で1都市365MB。\n\n\
             例:\n  \
             plateau_bldg_to_geoparquet --city 13103 ../data/output/plateau_bldg_13103.parquet\n  \
             plateau_bldg_to_geoparquet --cities all ../data/output/plateau --jobs 4"
        ),
    }
}

/// `--jobs` の値を読む。**0を拒む** (0だと1都市も処理せずに黙って終わる)。
fn parse_jobs(value: &str) -> Result<usize> {
    let jobs: usize = value
        .parse()
        .with_context(|| format!("--jobs には数を渡す: {value:?}"))?;
    if jobs == 0 {
        bail!("--jobs は1以上にする (0では1都市も処理されない)");
    }
    Ok(jobs)
}

/// 複数の都市をまとめて変換する。
///
/// **途中で止まっても続きから再開できる。** 既にあるファイルは飛ばすので、
/// 306都市の変換を何度かに分けて回せる (配信元にも優しい)。
/// 1都市で落ちても止めず、最後にまとめて報告する。
///
/// `jobs` は同時に処理する都市の数。**これがメモリと、配信元への同時接続数の
/// 両方を決める唯一のつまみ。** 実測で1都市365MB (港区・5.1万棟) なので、
/// 4並列なら1.5GB前後を見ておく。いちばん重い横浜市は建物CityGMLが港区の2.4倍ある。
fn from_cities(list: &str, out_dir: PathBuf, jobs: usize) -> Result<()> {
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

    // 既にあるものは先に落とす。残りの件数が進捗の分母になる。
    let pending: Vec<(usize, &plateau_catalog::City)> = targets
        .iter()
        .copied()
        .map(|city| {
            let output = out_dir.join(format!("plateau_bldg_{}.parquet", city.city_code));
            (output.exists() as usize, city)
        })
        .collect();
    let skipped = pending.iter().filter(|(exists, _)| *exists == 1).count();
    let todo: Vec<&plateau_catalog::City> = pending
        .into_iter()
        .filter(|(exists, _)| *exists == 0)
        .map(|(_, city)| city)
        .collect();

    eprintln!(
        "{} 都市を変換します (既存を飛ばした {skipped} / 同時 {jobs})",
        todo.len()
    );

    let total = todo.len();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let failed = std::sync::Mutex::new(Vec::new());
    let done = std::sync::atomic::AtomicUsize::new(0);

    // **自前のスレッドプール。** rayonを足さないのは、欲しいのが
    // 「同時に走る数を固定する」だけで、仕事の分割や盗みが要らないため。
    std::thread::scope(|scope| {
        for _ in 0..jobs {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(city) = todo.get(index) else { break };
                    let output = out_dir.join(format!("plateau_bldg_{}.parquet", city.city_code));
                    eprintln!("[{}/{}] {} {}", index + 1, total, city.pref, city.city);
                    match convert_city(city, &output) {
                        Ok(()) => {
                            done.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }
                        Err(e) => {
                            eprintln!("  失敗: {} {} — {e:#}", city.city_code, city.city);
                            failed
                                .lock()
                                .expect("失敗の記録用のロック")
                                .push(format!("{} {}", city.city_code, city.city));
                        }
                    }
                }
            });
        }
    });

    let failed = failed.into_inner().expect("スレッドは全て終わっている");
    println!(
        "変換 {} / 既存を飛ばした {skipped} / 失敗 {}",
        done.load(std::sync::atomic::Ordering::Relaxed),
        failed.len()
    );
    // **プロセス全体の山を出す。** 並列数を決める根拠になる数字なので、
    // 毎回目に入るところに置く。
    println!("最大メモリ {}", peak_memory::Peak::now());
    if !failed.is_empty() {
        println!("失敗した都市: {}", failed.join(", "));
    }
    Ok(())
}

fn from_local(input: PathBuf, output: PathBuf) -> Result<()> {
    let rows = plateau::parse_zip(&input)?;
    // 手元のzipからだと配布元のURLも、原典にどのLODがあるかも分からない。
    // **推測で埋めない** (同じファイル名でも出所が違いうる)。
    finish(rows, output, None, None)
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
    // 併せて、**原典にどのLODがあるか**も残す。ここが読むのはLOD0だけなので、
    // その差を画面で示せるようにする。
    let lods = plateau_catalog::format_lods(city.lods("bldg"));
    finish(rows, output.to_path_buf(), Some(&city.url), lods.as_deref())
}

fn finish(
    mut rows: Vec<plateau::Row>,
    output: PathBuf,
    via: Option<&str>,
    source_lod: Option<&str>,
) -> Result<()> {
    println!("{} 棟を読み込みました", rows.len());
    if let Some(lods) = source_lod {
        println!("原典のLOD: {lods} (このパイプラインが読むのはLOD0のみ)");
    }
    plateau::to_wgs84(&mut rows)?;
    plateau::write_geoparquet(rows, &output, via, source_lod)?;

    // **続けて空間パックまで済ませる。** 別のコマンドに分けると、
    // パックしていないファイルが全都市ぶんディスクに積み上がる。
    // 変換で確保したメモリはここで解放されているので、山は重ならない
    // (実測: 変換365MB / パック56MB)。
    let packed = repack::repack(&output, &output, None)?;
    println!(
        "{} に書き出しました ({} 行 / row group {} 個 / {:.1} MB)",
        output.display(),
        packed.rows,
        packed.row_groups,
        packed.output_bytes as f64 / 1024.0 / 1024.0,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // **0を渡すと1都市も処理せずに黙って終わる。** 気付けないので拒む。
    #[test]
    fn rejects_zero_jobs() {
        let err = parse_jobs("0").unwrap_err();
        assert!(err.to_string().contains("1以上"));
    }

    #[test]
    fn rejects_a_non_number() {
        assert!(parse_jobs("four").is_err());
    }

    #[test]
    fn reads_the_job_count() {
        assert_eq!(parse_jobs("4").unwrap(), 4);
    }
}
