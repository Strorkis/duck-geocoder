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
/// `repack` (`Layout::CellFirst`) が場所ごとに区切り、場所の中を段で並べて、段の境で
/// 行グループを切る。引いた表示では `WHERE lod <= 0` で公共施設の行グループだけを読む。
///
/// **入力を上書きする。** 既に段があるファイルは段を作り直さない (二度掛けない)。
/// 並べ方が古い (印 `duck:lod_layout` が無い) ものは並べ直すだけにする。
/// `--relayout` を付けると、印があっても並べ直す (並べ方の数字を変えたとき)。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let force_relayout = args.iter().any(|arg| arg == "--relayout");
    let targets: Vec<PathBuf> = args
        .iter()
        .filter(|arg| *arg != "--relayout")
        .map(PathBuf::from)
        .collect();
    if targets.is_empty() {
        bail!(
            "usage: add_building_lod [--relayout] <建物のparquet>...\n\n\
             建物に重要度の段 (lod 列) を付けて、場所ごと・段ごとに並べ直す。**入力を上書きする。**\n\
             --relayout: 段も並べ方の印もあるファイルも並べ直す\n\n\
             例:\n  \
             add_building_lod ../data/output/plateau/plateau_bldg_[0-9]*.parquet \\\n    \
             ../data/output/overture/overture_buildings_*.parquet"
        );
    }
    let mut done = 0;
    for target in &targets {
        if add_building_lod(target, force_relayout)? {
            done += 1;
        }
    }
    println!("{done} / {} ファイルを書き直しました", targets.len());
    Ok(())
}

/// 書いた KV のキー。カタログがこれを見て `duck:tiers` に `lod_column` を足す。
const LOD_BY_TIER_KEY: &str = "duck:lod_by_tier";

fn add_building_lod(input: &Path, force_relayout: bool) -> Result<bool> {
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .context("ファイル名が読めません")?;
    let tiers = tiers_for_file(stem).with_context(|| {
        format!("重要度の段の規則がありません (建物のファイルではない?): {stem}")
    })?;

    if geoparquet::read_key_value(input, LOD_BY_TIER_KEY)?.is_some() {
        // 段は付いている。**並べ方が古ければ並べ直すだけ** (段の列は作り直さない)。
        if !force_relayout
            && geoparquet::read_key_value(input, LAYOUT_KEY)?.as_deref() == Some(LAYOUT_CELL_FIRST)
        {
            println!(
                "{}: 既に段があり、並べ方も新しいので飛ばします",
                input.display()
            );
            return Ok(false);
        }
        let packed = relayout(input)?;
        report(input, &packed, "並べ直しました");
        return Ok(true);
    }

    // KV は**全部引き継ぐ** (geo・版・配布元・原典のLOD)。ただし ARROW:schema は
    // 列が増えるので古くなる。書き直す側 (repack) が作り直す。
    let mut kv: Vec<(String, String)> = geoparquet::read_all_key_values(input)?
        .into_iter()
        .filter(|(key, _)| key != "ARROW:schema")
        .collect();
    kv.push((LOD_BY_TIER_KEY.to_string(), "1".to_string()));
    kv.push((LAYOUT_KEY.to_string(), LAYOUT_CELL_FIRST.to_string()));
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

    // **場所ごとに、段で並べ直す。** 場所の中では公共施設の行が先頭の行グループに入る。
    let packed = repack::repack_with(&staged, input, None, repack::Layout::CellFirst, &[])?;
    std::fs::remove_file(&staged).ok();
    report(input, &packed, "段を付けました");
    Ok(true)
}

/// 並べ方の KV。段を付けたあとで並べ方を変えたので、どちらで並んでいるかを残す。
const LAYOUT_KEY: &str = "duck:lod_layout";
const LAYOUT_CELL_FIRST: &str = "cell_first";

/// 段の付いたファイルを、場所ごとの並べ方に並べ直す (上書き。並べ方の印を KV に足す)。
fn relayout(input: &Path) -> Result<repack::Packed> {
    repack::repack_with(
        input,
        input,
        None,
        repack::Layout::CellFirst,
        &[(LAYOUT_KEY, LAYOUT_CELL_FIRST)],
    )
}

fn report(input: &Path, packed: &repack::Packed, what: &str) {
    println!(
        "{}: {what} ({} 行 / row group {} 個 / {:.1} MB)",
        input.display(),
        packed.rows,
        packed.row_groups,
        packed.output_bytes as f64 / 1024.0 / 1024.0,
    );
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
