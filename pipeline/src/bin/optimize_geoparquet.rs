use anyhow::{Context, Result, bail};
use duck_geocoder::repack;
use std::path::PathBuf;

/// GeoParquetを、HTTP越しに部分読みしやすい形に並べ替えて書き直す。
///
/// 中身は [`duck_geocoder::repack`] にある。**都市ごとのループからも同じものを呼ぶ**ので、
/// binにはコマンドラインの解釈と報告だけを置いてある。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (input, output, requested_size) = match args.as_slice() {
        [_, input, output] => (PathBuf::from(input), PathBuf::from(output), None),
        [_, input, output, size] => (
            PathBuf::from(input),
            PathBuf::from(output),
            Some(
                size.parse::<usize>()
                    .with_context(|| format!("row group size が数値として読めません: {size:?}"))?,
            ),
        ),
        _ => bail!(
            "usage: optimize_geoparquet <input.parquet> <output.parquet> [row_group_size]\n\
             row_group_size を省略すると、1行あたりのバイト数から自動で決める。\n\
             入力と同じパスを指定すれば上書きできる。\n\
             例:\n  \
             optimize_geoparquet ../data/output/n03_all.parquet ../data/output/n03_all.parquet"
        ),
    };

    let packed = repack::repack(&input, &output, requested_size)?;
    println!(
        "{} -> {}\n  {} 行 / row group {} 行 x {} 個\n  {:.1} MB -> {:.1} MB",
        input.display(),
        output.display(),
        packed.rows,
        packed.row_group_size,
        packed.row_groups,
        packed.input_bytes as f64 / 1024.0 / 1024.0,
        packed.output_bytes as f64 / 1024.0 / 1024.0,
    );
    Ok(())
}
