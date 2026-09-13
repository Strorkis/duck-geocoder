use anyhow::{Result, bail};
use duck_geocoder::{decode_sjis, mesh_pop, read_zip_entry_bytes};
use std::path::PathBuf;

/// 国勢調査の地域メッシュ統計 (e-Stat 統計GIS) のzipを読み、GeoParquetに変換する。
///
/// ジオメトリはメッシュコードから計算するので、**境界データは要らない**。
/// 落とすのは統計データ (`tblT......zip`) だけでよい。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (input, output) = match args.as_slice() {
        [_, input, output] => (PathBuf::from(input), PathBuf::from(output)),
        _ => bail!(
            "usage: mesh_pop_to_geoparquet <input.zip> <output.parquet>\n\n\
             例:\n  \
             mesh_pop_to_geoparquet ../data/estat/mesh/tblT001231E13.zip \
             ../data/output/mesh_pop_13.parquet"
        ),
    };

    // 配布物はzipの中にテキストが1つ入っているだけ。拡張子は .txt だが中身はCSV。
    let bytes = read_zip_entry_bytes(&input, ".txt")?;
    let rows = mesh_pop::parse_csv(&decode_sjis(&bytes))?;

    let meshes = rows.len();
    let population: i64 = rows
        .iter()
        .filter_map(|r| r.population)
        .map(i64::from)
        .sum();
    // 合計を出すのは、公表値と突き合わせられるようにするため。
    // 桁が違えば読み方を間違えている。
    println!("{meshes} メッシュ / 人口 {population} 人");

    mesh_pop::write_geoparquet(rows, &output)?;
    println!("{} に書き出しました", output.display());
    Ok(())
}
