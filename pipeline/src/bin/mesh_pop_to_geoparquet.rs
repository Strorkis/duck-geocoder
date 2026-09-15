use anyhow::{Context, Result, bail};
use duck_geocoder::{decode_sjis, mesh_pop, read_zip_entry_bytes};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 全国を俯瞰するために別に作る、粗いメッシュの桁数。8桁 = 1km。
///
/// **配信しているのが125mだけだと、引くほど読む量が増える。** 全国を1kmで
/// 持てば1ファイル約5MBで済み、そこからさらに束ねて10km・80kmも作れる。
const COARSE_DIGITS: usize = 8;
const COARSE_LABEL: &str = "1km";

/// 国勢調査の地域メッシュ統計 (e-Stat 統計GIS) のzipを読み、GeoParquetに変換する。
///
/// ジオメトリはメッシュコードから計算するので、**境界データは要らない**。
/// 落とすのは統計データ (`tblT......zip`) だけでよい。
///
/// 配布は都道府県ごとなので、`--all` でディレクトリをまとめて変換できる。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [_, "--all", input_dir, out_dir] => convert_all(Path::new(input_dir), Path::new(out_dir)),
        [_, input, output] => {
            // 1県だけの変換では粗いメッシュを作らない。**全国で1つ**に意味があるので、
            // 県ごとに作ると県境をまたぐメッシュが分かれてしまう。
            let mut ignored = BTreeMap::new();
            let (meshes, population) = convert(Path::new(input), Path::new(output), &mut ignored)?;
            println!("{meshes} メッシュ / 人口 {population} 人");
            Ok(())
        }
        _ => bail!(
            "usage:\n  \
             mesh_pop_to_geoparquet <input.zip> <output.parquet>\n  \
             mesh_pop_to_geoparquet --all <入力ディレクトリ> <出力ディレクトリ>\n\n\
             例:\n  \
             mesh_pop_to_geoparquet --all ../data/estat/mesh/ ../data/output/"
        ),
    }
}

/// ディレクトリ内の `tbl*.zip` をまとめて変換する。
///
/// **合計を最後に出す。** 全国の人口は公表されているので、突き合わせれば
/// 取りこぼしや二重計上に気づける (都道府県を1つ落としても、ファイルが
/// 増えただけでは分からない)。
fn convert_all(input_dir: &Path, out_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(out_dir)?;
    let mut inputs: Vec<PathBuf> = std::fs::read_dir(input_dir)
        .with_context(|| format!("読めません: {}", input_dir.display()))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "zip"))
        .collect();
    inputs.sort();

    if inputs.is_empty() {
        bail!("{} にzipがありません", input_dir.display());
    }

    let mut total_meshes = 0usize;
    let mut total_population = 0i64;
    // 全国を1kmで束ねたものを作る。**県境をまたぐメッシュがある**ので、
    // 県ごとに書き出さず、全県を積んでから確定する。
    let mut coarse = BTreeMap::new();
    for input in &inputs {
        let code = prefecture_code(input)?;
        let output = out_dir.join(format!("mesh_pop_{code}.parquet"));
        let (meshes, population) = convert(input, &output, &mut coarse)?;
        println!("{code}: {meshes} メッシュ / 人口 {population} 人");
        total_meshes += meshes;
        total_population += population;
    }

    println!(
        "\n{} 都道府県 / 合計 {total_meshes} メッシュ / 人口 {total_population} 人",
        inputs.len()
    );

    let rows = mesh_pop::aggregate(coarse)?;
    let coarse_population: i64 = rows
        .iter()
        .filter_map(|r| r.population)
        .map(i64::from)
        .sum();
    // **束ねた合計が元と一致すること。** ずれていたら束ね方を間違えている。
    if coarse_population != total_population {
        bail!("1kmに束ねたら人口が変わりました: {total_population} → {coarse_population}");
    }
    let output = out_dir.join(format!("mesh_pop_{COARSE_LABEL}.parquet"));
    println!(
        "{} メッシュ ({COARSE_LABEL}) を {} に書き出しました",
        rows.len(),
        output.display(),
    );
    mesh_pop::write_geoparquet(rows, &output)
}

/// 配布ファイル名から都道府県コードを取り出す。
///
/// e-Statの名前は `tblT001231E13.zip` の形で、`E` の後ろが都道府県コード。
/// **名前を変えずに置いてもらう**ことで、統計表と都道府県の対応が残る。
fn prefecture_code(path: &Path) -> Result<String> {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .context("ファイル名が取得できません")?;
    let code = stem
        .rsplit_once('E')
        .map(|(_, code)| code)
        .filter(|code| code.len() == 2 && code.chars().all(|c| c.is_ascii_digit()))
        .with_context(|| {
            format!("ファイル名から都道府県コードを読めません: {stem} (例: tblT001231E13.zip)")
        })?;
    Ok(code.to_string())
}

/// zip 1つを変換し、(メッシュ数, 人口) を返す。
/// `coarse` には粗いメッシュの集計を積む (`None` なら積まない)。
fn convert(
    input: &Path,
    output: &Path,
    coarse: &mut BTreeMap<String, mesh_pop::Cell>,
) -> Result<(usize, i64)> {
    // 配布物はzipの中にテキストが1つ入っているだけ。拡張子は .txt だが中身はCSV。
    let bytes = read_zip_entry_bytes(input, ".txt")?;
    let rows = mesh_pop::parse_csv(&decode_sjis(&bytes))
        .with_context(|| format!("読めません: {}", input.display()))?;

    let meshes = rows.len();
    let population: i64 = rows
        .iter()
        .filter_map(|r| r.population)
        .map(i64::from)
        .sum();

    mesh_pop::accumulate(coarse, &rows, COARSE_DIGITS);
    mesh_pop::write_geoparquet(rows, output)?;
    Ok((meshes, population))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_prefecture_code_from_the_distributed_name() {
        let code = prefecture_code(Path::new("../data/estat/mesh/tblT001231E13.zip")).unwrap();
        assert_eq!(code, "13");
        assert_eq!(
            prefecture_code(Path::new("tblT001231E01.zip")).unwrap(),
            "01"
        );
    }

    // 名前を変えて置かれると対応が分からなくなる。推測せずに落とす。
    #[test]
    fn rejects_names_it_cannot_read() {
        assert!(prefecture_code(Path::new("tokyo.zip")).is_err());
        assert!(prefecture_code(Path::new("tblT001231E1.zip")).is_err());
    }
}
