use anyhow::{Context, Result, bail};
use duck_geocoder::coverage::{self, Row};
use duck_geocoder::repack;
use std::path::PathBuf;
use std::process::Command;

/// 建物のGeoParquetから、**どこまで整備されているか**を地域メッシュで書き出す。
///
/// 収録範囲をbboxの和で示すと、PLATEAUを306都市に広げた時点で日本をほぼ覆う
/// 1つの箱になり、収録の無い山間部でも「ある」と出る。市区町村の境界で描くのも
/// 違う — **PLATEAUの整備範囲は市域と一致しない**。
///
/// メッシュは経緯度から機械的に決まる方眼なので、境界データを持ち込まずに済む
/// (詳細は [`duck_geocoder::coverage`])。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (glob, output, covers) = match args.as_slice() {
        [_, glob, output, covers] => (glob.clone(), PathBuf::from(output), covers.clone()),
        _ => bail!(
            "usage: build_coverage <入力のglob> <出力.parquet> <対象のCollection ID>\n\n\
             例:\n  \
             build_coverage '../data/output/plateau/plateau_bldg_[0-9]*.parquet' \\\n    \
             ../data/output/plateau/plateau_bldg_coverage.parquet plateau-buildings\n\n\
             **globは都市ごとのファイルだけに当てること。** 整備範囲そのものを\n\
             読み込むと自分を数えてしまう。"
        ),
    };

    let counted = query(&coverage::build_coverage_sql(&glob))?;
    if counted.is_empty() {
        bail!("メッシュが1つも数えられませんでした (globが合っていますか?)");
    }

    // コードから四角形を作る。**ここで初めてジオメトリが出てくる** —
    // 2,900万行を数えるのはDuckDBに任せ、Rustが触るのは集計後だけ。
    let rows = counted
        .into_iter()
        .map(|cell| {
            Ok(Row {
                geometry: coverage::polygon(&cell.mesh_code)?,
                mesh_code: cell.mesh_code,
                buildings: cell.buildings,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let cells = rows.len();
    let buildings: i64 = rows.iter().map(|row| i64::from(row.buildings)).sum();

    let staged = output.with_extension("parquet.staged");
    coverage::write_geoparquet(rows, &staged, &covers)?;
    let packed = repack::repack(&staged, &output, Some(coverage::ROW_GROUP_SIZE))?;
    std::fs::remove_file(&staged).ok();

    println!(
        "{}\n  {cells} セル (1km) / 建物 {buildings} 棟 / row group {} 行 x {} 個 / {:.2} MB",
        output.display(),
        packed.row_group_size,
        packed.row_groups,
        packed.output_bytes as f64 / 1024.0 / 1024.0,
    );
    Ok(())
}

#[derive(serde::Deserialize)]
struct Cell {
    mesh_code: String,
    buildings: i32,
}

fn query(sql: &str) -> Result<Vec<Cell>> {
    let output = Command::new("duckdb")
        .args(["-json", "-c", sql])
        .output()
        .context("duckdb コマンドを実行できません (mise install は済んでいますか?)")?;
    if !output.status.success() {
        bail!(
            "duckdb が失敗しました: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    serde_json::from_slice(&output.stdout).context("duckdb の出力を読めません")
}
