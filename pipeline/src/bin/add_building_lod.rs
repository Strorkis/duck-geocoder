use anyhow::{Context, Result, bail};
use duck_geocoder::catalog::tiers_for_file;
use duck_geocoder::geoparquet;
use duck_geocoder::repack;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 建物の GeoParquet に**重要度の段で間引くための段** (`lod` 列) を付ける。
///
/// 線の粗い段 (`add_coarse_lod`) と違い、**行を複製しない。** 建物は1棟ずつ独立して
/// いるので、行を段に振り分けるだけで済む (COGP の考え方そのもの)。
/// `lod` = 段の順位 (0 公共施設 / 1 商業・業務 / 2 住宅・その他)。段の規則は
/// カタログの `TIERS` で、UI が `duck:tiers` から組み立てる式と同じ規則。
///
/// `repack` が `lod` 列を見て段ごとにパックし、段の境で行グループを切る。
/// 引いた表示では `WHERE lod <= 0` で公共施設の行グループだけを読む。
///
/// **入力を上書きする。** 既に段があるファイルは飛ばす (二度掛けない)。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let targets: Vec<PathBuf> = match args.as_slice() {
        [_, paths @ ..] if !paths.is_empty() => paths.iter().map(PathBuf::from).collect(),
        _ => bail!(
            "usage: add_building_lod <建物のparquet>...\n\n\
             建物に重要度の段 (lod 列) を付けて、段ごとに並べ直す。**入力を上書きする。**\n\n\
             例:\n  \
             add_building_lod ../data/output/plateau/plateau_bldg_[0-9]*.parquet \\\n    \
             ../data/output/overture/overture_buildings_*.parquet"
        ),
    };
    let mut done = 0;
    for target in &targets {
        if add_building_lod(target)? {
            done += 1;
        }
    }
    println!("{done} / {} ファイルに段を付けました", targets.len());
    Ok(())
}

/// 書いた KV のキー。カタログがこれを見て `duck:tiers` に `lod_column` を足す。
const LOD_BY_TIER_KEY: &str = "duck:lod_by_tier";

fn add_building_lod(input: &Path) -> Result<bool> {
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .context("ファイル名が読めません")?;
    let tiers = tiers_for_file(stem).with_context(|| {
        format!("重要度の段の規則がありません (建物のファイルではない?): {stem}")
    })?;

    if geoparquet::read_key_value(input, LOD_BY_TIER_KEY)?.is_some() {
        println!("{}: 既に段があるので飛ばします", input.display());
        return Ok(false);
    }

    // KV は**全部引き継ぐ** (geo・版・配布元・原典のLOD)。ただし ARROW:schema は
    // 列が増えるので古くなる。書き直す側 (repack) が作り直す。
    let mut kv: Vec<(String, String)> = geoparquet::read_all_key_values(input)?
        .into_iter()
        .filter(|(key, _)| key != "ARROW:schema")
        .collect();
    kv.push((LOD_BY_TIER_KEY.to_string(), "1".to_string()));
    let kv_sql = kv
        .iter()
        .map(|(key, value)| {
            format!(
                "'{}': '{}'",
                key.replace('\'', "''"),
                value.replace('\'', "''")
            )
        })
        .collect::<Vec<_>>()
        .join(",\n  ");

    let input_str = input.to_str().context("入力パスがUTF-8ではありません")?;
    let staged = input.with_extension("parquet.lod");
    let staged_str = staged.to_str().context("出力パスがUTF-8ではありません")?;
    let rank = tiers.rank_sql();
    run_duckdb(&format!(
        "INSTALL spatial; LOAD spatial;
SET preserve_insertion_order = false;
COPY (
  SELECT ({rank})::UTINYINT AS lod, * REPLACE (ST_AsWKB(geometry)::BLOB AS geometry)
  FROM read_parquet('{input_str}')
) TO '{staged_str}' (FORMAT PARQUET, KV_METADATA {{
  {kv_sql}
}});"
    ))?;

    // **段ごとに並べ直す。** 公共施設の行が先頭の行グループに集まる。
    let packed = repack::repack(&staged, input, None)?;
    std::fs::remove_file(&staged).ok();
    println!(
        "{}: {} 行 / row group {} 個 / {:.1} MB",
        input.display(),
        packed.rows,
        packed.row_groups,
        packed.output_bytes as f64 / 1024.0 / 1024.0,
    );
    Ok(true)
}

fn run_duckdb(sql: &str) -> Result<()> {
    let status = Command::new("duckdb")
        .arg("-c")
        .arg(sql)
        .status()
        .context("duckdb コマンドを実行できません (mise install は済んでいますか?)")?;
    if !status.success() {
        bail!("duckdb が失敗しました: {status}");
    }
    Ok(())
}
