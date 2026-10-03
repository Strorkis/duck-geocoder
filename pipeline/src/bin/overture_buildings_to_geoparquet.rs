use anyhow::{Context, Result, bail};
use duck_geocoder::geoparquet::{CoveringBbox, geo_metadata_json, geoparquet_geometry_type};
use duck_geocoder::overture::{
    DEFAULT_RELEASE, build_building_tile_sql, build_buildings_keyed_sql,
    build_buildings_partition_sql, build_japan_tiles_sql,
};
use duck_geocoder::quadkey;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Command;

/// 細かいキーのズーム。ここより細かくは割らない (日本付近で1辺約10km)。
const FINE_ZOOM: u8 = 12;
/// 割り始めるズーム (日本付近で1辺約300km)。これより粗いファイルは作らない。
const MIN_ZOOM: usize = 7;
/// 1ファイルの建物の上限。**`repack` がファイルを丸ごとメモリに読む** (1棟約1.1KB) ので、
/// 40万棟で約450MBに収まる。
const MAX_ROWS: u64 = 400_000;

/// `extract_overture buildings` で日本の範囲を落としたファイルから、
/// **QuadKey ごとに分けた**建物のデータセットを作る (`overture_buildings_<quadkey>.parquet`)。
///
/// 1. 細かい QuadKey (ズーム12、約10km) を付ける
/// 2. **日本の市区町村に重なるタイル**だけを残す。建物ごとに判定すると
///    7,405万棟 × 1,741区画でメモリ (2GB) に収まらなかったので、タイルごとに判定する
/// 3. 件数を見て**多いタイルだけ割る** ([`quadkey::choose_tiles`])。キーの長さが
///    タイルごとに違う (都市部は細かく、過疎地は粗い)。同じズームで切ると、
///    ズーム10でも最大195万棟のタイルができてメモリに載らなかった
/// 4. タイルごとに振り分け (PARTITION_BY)、実データの範囲を入れた `geo` を付けて書く
///
/// このあと `optimize_geoparquet` で並べ直し、`add_building_lod` で段を付ける。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (input, divisions, out_dir) = match args.as_slice() {
        [_, input, divisions, out_dir] => {
            (input.clone(), divisions.clone(), PathBuf::from(out_dir))
        }
        _ => bail!(
            "usage: overture_buildings_to_geoparquet <取り出したparquet> <divisions_jp.parquet> \
             <出力ディレクトリ>\n\
             例:\n  \
             overture_buildings_to_geoparquet ../data/overture/buildings_jp_bbox.parquet \\\n    \
             ../data/overture/divisions_jp.parquet ../data/output/overture"
        ),
    };
    std::fs::create_dir_all(&out_dir)?;
    let vintage = std::env::var("OVERTURE_RELEASE").unwrap_or_else(|_| DEFAULT_RELEASE.to_string());

    // 作業用のファイルは出力の外に置く (カタログに拾わせない)。
    let scratch = out_dir
        .parent()
        .context("出力ディレクトリの親がありません")?
        .join("_overture_buildings_work");
    if scratch.exists() {
        std::fs::remove_dir_all(&scratch)?;
    }
    std::fs::create_dir_all(&scratch)?;
    let keyed = scratch.join("keyed.parquet");
    let japan_str = keyed.to_str().context("パスがUTF-8ではありません")?;

    // 1. 細かいキーを付けて書く (まだ絞らない)。
    eprintln!("QuadKey (ズーム{FINE_ZOOM}) を付けています...");
    run_duckdb(&build_buildings_keyed_sql(&input, japan_str, FINE_ZOOM))?;

    // 2. 日本の市区町村に重なるタイルだけを残す (建物ごとではなくタイルごとに判定する)。
    let all_counts = query_counts(japan_str)?;
    let tiles_csv = scratch.join("fine_tiles.csv");
    let mut csv = String::from("fine_key,west,south,east,north\n");
    for key in all_counts.keys() {
        let [w, s, e, n] = quadkey::bounds(key)?;
        csv.push_str(&format!("{key},{w},{s},{e},{n}\n"));
    }
    std::fs::write(&tiles_csv, csv)?;
    let japan_keys = query_keys(&build_japan_tiles_sql(
        tiles_csv.to_str().context("パスがUTF-8ではありません")?,
        &divisions,
    ))?;
    let counts: BTreeMap<String, u64> = all_counts
        .into_iter()
        .filter(|(key, _)| japan_keys.contains(key))
        .collect();
    eprintln!(
        "日本に重なるタイル {} / 細かいタイル {}",
        counts.len(),
        japan_keys.len().max(counts.len())
    );

    // 3. 件数を見てファイルの単位を選ぶ。
    let total: u64 = counts.values().sum();
    let tiles = quadkey::choose_tiles(&counts, MIN_ZOOM, usize::from(FINE_ZOOM), MAX_ROWS);
    eprintln!("日本の建物 {total} 棟 → {} タイル", tiles.len());
    let mapping = scratch.join("mapping.csv");
    let mut csv = String::from("fine_key,tile\n");
    for key in counts.keys() {
        let tile = tiles
            .iter()
            .find(|tile| key.starts_with(tile.as_str()))
            .with_context(|| format!("どのタイルにも入らないキーがあります: {key}"))?;
        csv.push_str(&format!("{key},{tile}\n"));
    }
    std::fs::write(&mapping, csv)?;

    // 3. 振り分け。
    let work = scratch.join("partition");
    let work_str = work.to_str().context("パスがUTF-8ではありません")?;
    run_duckdb(&build_buildings_partition_sql(
        japan_str,
        mapping.to_str().context("パスがUTF-8ではありません")?,
        work_str,
    ))?;

    // タイルごとに geo メタデータを付けて書く。振り分けたディレクトリが
    // 選んだタイルと一致することを確かめる (食い違えば建物が黙って欠ける)。
    let mut dirs = Vec::new();
    for entry in std::fs::read_dir(&work)? {
        let path = entry?.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if let Some(key) = name.strip_prefix("quadkey=") {
            quadkey::bounds(key)
                .with_context(|| format!("振り分けた QuadKey が読めません: {key}"))?;
            dirs.push((key.to_string(), path));
        }
    }
    dirs.sort();
    let written: Vec<&str> = dirs.iter().map(|(key, _)| key.as_str()).collect();
    if written != tiles.iter().map(String::as_str).collect::<Vec<_>>() {
        bail!("振り分けたタイルが選んだタイルと一致しません");
    }
    let tiles = dirs;

    let covering = CoveringBbox {
        column: "bbox".to_string(),
        xmin: "xmin".to_string(),
        ymin: "ymin".to_string(),
        xmax: "xmax".to_string(),
        ymax: "ymax".to_string(),
    };
    for (key, dir) in &tiles {
        let input = dir.join("*.parquet");
        let input = input.to_str().context("パスがUTF-8ではありません")?;
        let stats = query_stats(input)?;
        let geometry_types = stats
            .geometry_types
            .iter()
            .map(|name| geoparquet_geometry_type(name).map(str::to_string))
            .collect::<Result<Vec<_>>>()?;
        let geo = geo_metadata_json(
            "geometry",
            &covering,
            &geometry_types,
            [stats.xmin, stats.ymin, stats.xmax, stats.ymax],
        )?;
        let output = out_dir.join(format!("overture_buildings_{key}.parquet"));
        let output_str = output.to_str().context("パスがUTF-8ではありません")?;
        run_duckdb(&build_building_tile_sql(input, output_str, &geo, &vintage))?;
        println!("{key}: {} 棟 → {}", stats.rows, output.display());
    }
    std::fs::remove_dir_all(&scratch)?;
    println!("続けて optimize_geoparquet と add_building_lod を通すこと。");
    Ok(())
}

/// 1列 (`fine_key`) の結果を集合で返す。
fn query_keys(sql: &str) -> Result<BTreeSet<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        fine_key: String,
    }
    let output = Command::new("duckdb")
        .args(["-json", "-c", sql])
        .output()
        .context("duckdb コマンドを実行できません")?;
    if !output.status.success() {
        bail!(
            "duckdb が失敗しました: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    // 1件も無いと duckdb -json は何も出さない。
    if output.stdout.iter().all(u8::is_ascii_whitespace) {
        return Ok(BTreeSet::new());
    }
    let rows: Vec<Row> =
        serde_json::from_slice(&output.stdout).context("duckdb の出力を読めません")?;
    Ok(rows.into_iter().map(|row| row.fine_key).collect())
}

/// 細かいキーごとの件数。
fn query_counts(japan: &str) -> Result<BTreeMap<String, u64>> {
    #[derive(serde::Deserialize)]
    struct Row {
        fine_key: String,
        n: u64,
    }
    let sql =
        format!("SELECT fine_key, count(*) AS n FROM read_parquet('{japan}') GROUP BY fine_key;");
    let output = Command::new("duckdb")
        .args(["-json", "-c", &sql])
        .output()
        .context("duckdb コマンドを実行できません")?;
    if !output.status.success() {
        bail!(
            "duckdb が失敗しました: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let rows: Vec<Row> =
        serde_json::from_slice(&output.stdout).context("duckdb の出力を読めません")?;
    Ok(rows.into_iter().map(|row| (row.fine_key, row.n)).collect())
}

#[derive(serde::Deserialize)]
struct Stats {
    rows: u64,
    xmin: f64,
    ymin: f64,
    xmax: f64,
    ymax: f64,
    geometry_types: Vec<String>,
}

fn query_stats(input: &str) -> Result<Stats> {
    let sql = format!(
        "INSTALL spatial; LOAD spatial;
SELECT count(*) AS rows,
  min(bbox.xmin) AS xmin, min(bbox.ymin) AS ymin, max(bbox.xmax) AS xmax, max(bbox.ymax) AS ymax,
  list_sort(list_distinct(list(ST_GeometryType(ST_GeomFromWKB(geometry))::VARCHAR))) AS geometry_types
FROM read_parquet('{input}');"
    );
    let output = Command::new("duckdb")
        .args(["-json", "-c", &sql])
        .output()
        .context("duckdb コマンドを実行できません (mise install は済んでいますか?)")?;
    if !output.status.success() {
        bail!(
            "duckdb が失敗しました: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let rows: Vec<Stats> =
        serde_json::from_slice(&output.stdout).context("duckdb の出力を読めません")?;
    rows.into_iter().next().context("タイルに建物がありません")
}

fn run_duckdb(sql: &str) -> Result<()> {
    let status = Command::new("duckdb")
        .arg("-c")
        .arg(sql)
        .status()
        .context("duckdb コマンドを実行できません")?;
    if !status.success() {
        bail!("duckdb が失敗しました: {status}");
    }
    Ok(())
}
