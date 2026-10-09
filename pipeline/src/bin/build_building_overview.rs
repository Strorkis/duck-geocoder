use anyhow::{Context, Result, bail};
use duck_geocoder::catalog::tiers_for_file;
use duck_geocoder::geoparquet;
use duck_geocoder::repack;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 建物の**概観**を作る。引いた表示 (段で間引くズーム) で読むファイル。
///
/// 引いた表示は、建物のファイルを20近く開くことになり、開くたびの往復 (R2 では1回約0.45秒) が
/// 待ち時間の大半だった。並べ方では減らない (docs/pipeline.md の「建物の並べ方」)。
/// そこで、**最後の段 (住宅・その他) を除いた行**を、広い範囲 (PLATEAU は都道府県、Overture は
/// 4桁の QuadKey) ごとに1ファイルへ集める。引いた表示は数ファイルを開くだけで済む。
///
/// - 行は**元のファイルの複製**。元のファイルはそのまま (寄った表示・周辺検索はそちらを読む)
/// - 段ごとに分け、段の中を場所で並べる (`repack::Layout::Overview`)。行グループは約1MB
/// - KV の `duck:lod_max` に、入っている段の上限を書く。カタログが Item に載せ、画面はそれで
///   元のファイルと見分ける (概観を元のファイルと一緒に読むと、同じ建物が二重に出る)
///
/// 元のファイルに段 (`add_building_lod`) が付いていることが前提。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let dir = match args.as_slice() {
        [_, dir] => PathBuf::from(dir),
        _ => bail!(
            "usage: build_building_overview <配信ディレクトリ>\n\n\
             建物の概観 (最後の段を除いた行を、都道府県・QuadKey ごとに集めたもの) を作る。\n\n\
             例:\n  build_building_overview ../data/output"
        ),
    };
    for family in FAMILIES {
        build_family(&dir, family)?;
    }
    Ok(())
}

/// 概観を作る建物の出所。
struct Family {
    /// 配信ディレクトリの中のサブディレクトリ。
    dir: &'static str,
    /// 元のファイル名の頭。後ろに数字だけが続くもの (都市コード・QuadKey) が元のファイル。
    prefix: &'static str,
    /// 数字の頭から何桁でまとめるか。
    key_len: usize,
}

const FAMILIES: &[Family] = &[
    // 都市コードの頭2桁 = 都道府県。いちばん大きい東京都で約70MB。
    Family {
        dir: "plateau",
        prefix: "plateau_bldg_",
        key_len: 2,
    },
    // 7桁の QuadKey を4桁でまとめる (日本は3つ。いちばん大きいもので約60MB)。
    Family {
        dir: "overture",
        prefix: "overture_buildings_",
        key_len: 4,
    },
];

/// 概観のファイル名に挟む語。元のファイルの名前 (数字だけ) とは重ならない。
const OVERVIEW_WORD: &str = "overview";

/// 入っている段の上限。カタログ (`catalog::describe_parquet`) が読む。
const LOD_MAX_KEY: &str = "duck:lod_max";

fn build_family(dir: &Path, family: &Family) -> Result<()> {
    let source_dir = dir.join(family.dir);
    let mut groups: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for entry in std::fs::read_dir(&source_dir)
        .with_context(|| format!("読めません: {}", source_dir.display()))?
    {
        let path = entry?.path();
        if path.extension().is_none_or(|ext| ext != "parquet") {
            continue;
        }
        let Some(code) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| stem.strip_prefix(family.prefix))
        else {
            continue;
        };
        // 数字だけのものが元のファイル (整備範囲や概観そのものを拾わない)。
        if code.len() < family.key_len || !code.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        groups
            .entry(code[..family.key_len].to_string())
            .or_default()
            .push(path);
    }
    if groups.is_empty() {
        println!("{}: 元のファイルがありません", source_dir.display());
        return Ok(());
    }
    for (key, inputs) in &groups {
        let output = source_dir.join(format!("{}{OVERVIEW_WORD}_{key}.parquet", family.prefix));
        build_overview(inputs, &output)?;
    }
    Ok(())
}

fn build_overview(inputs: &[PathBuf], output: &Path) -> Result<()> {
    let stem = output
        .file_stem()
        .and_then(|s| s.to_str())
        .context("ファイル名が読めません")?;
    let tiers =
        tiers_for_file(stem).with_context(|| format!("重要度の段の規則がありません: {stem}"))?;
    if tiers.tiers.len() < 2 {
        bail!("段が1つしかないので概観は作れません: {stem}");
    }
    // **最後の段 (住宅・その他) を除く。** 量の大半はそこ (PLATEAU で 3.8GB のうち 3.4GB)。
    let lod_max = tiers.tiers.len() - 2;

    for input in inputs {
        if geoparquet::read_key_value(input, "duck:lod_by_tier")?.is_none() {
            bail!(
                "段が付いていません (先に add_building_lod を流す): {}",
                input.display()
            );
        }
    }

    let kv = overview_key_values(inputs, lod_max)?;
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
    let list = inputs
        .iter()
        .map(|path| {
            path.to_str()
                .map(|s| format!("'{}'", s.replace('\'', "''")))
                .context("入力パスがUTF-8ではありません")
        })
        .collect::<Result<Vec<_>>>()?
        .join(", ");
    let staged = output.with_extension("parquet.overview");
    let staged_str = staged.to_str().context("出力パスがUTF-8ではありません")?;
    run_duckdb(&format!(
        "INSTALL spatial; LOAD spatial;
SET preserve_insertion_order = false;
COPY (
  SELECT * REPLACE (ST_AsWKB(geometry)::BLOB AS geometry)
  FROM read_parquet([{list}], union_by_name = true)
  WHERE lod <= {lod_max}
) TO '{staged_str}' (FORMAT PARQUET, KV_METADATA {{
  {kv_sql}
}});"
    ))?;

    let packed = repack::repack_with(&staged, output, None, repack::Layout::Overview, &[])?;
    std::fs::remove_file(&staged).ok();
    // 上の段が1棟も無い範囲 (Overture の海の多い QuadKey) は、概観を置かない。
    // 空のファイルを置くと、引いた表示で開く往復だけが増える。
    if packed.rows == 0 {
        std::fs::remove_file(output).ok();
        println!("{}: 上の段の建物が無いので作りません", output.display());
        return Ok(());
    }
    println!(
        "{}: {} ファイルから {} 行 / row group {} 個 / {:.1} MB",
        output.display(),
        inputs.len(),
        packed.rows,
        packed.row_groups,
        packed.output_bytes as f64 / 1024.0 / 1024.0,
    );
    Ok(())
}

/// 概観の KV。`geo` の範囲と種別は元のファイル全部の和にする。
///
/// **ファイルごとの素性は持ち込まない** (`duck:via` は都市ごとの zip、`duck:source_lod` は都市ごとの
/// LOD)。版 (`duck:vintage`) は全部が同じときだけ引き継ぐ (カタログの Collection と同じ考え方)。
fn overview_key_values(inputs: &[PathBuf], lod_max: usize) -> Result<Vec<(String, String)>> {
    let mut geo: Option<serde_json::Value> = None;
    let mut bbox = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut types: Vec<String> = Vec::new();
    let mut vintages = std::collections::BTreeSet::new();
    let mut all_have_vintage = true;
    for input in inputs {
        let geo_json = geoparquet::read_key_value(input, "geo")?
            .with_context(|| format!("`geo` メタデータがありません: {}", input.display()))?;
        let value: serde_json::Value =
            serde_json::from_str(&geo_json).context("`geo` メタデータがJSONとして読めません")?;
        let primary = value["primary_column"]
            .as_str()
            .context("`geo` に primary_column がありません")?;
        let column = &value["columns"][primary];
        if let Some(b) = column["bbox"].as_array() {
            let b: Vec<f64> = b.iter().filter_map(serde_json::Value::as_f64).collect();
            if let [xmin, ymin, xmax, ymax] = b.as_slice() {
                bbox = [
                    bbox[0].min(*xmin),
                    bbox[1].min(*ymin),
                    bbox[2].max(*xmax),
                    bbox[3].max(*ymax),
                ];
            }
        }
        for t in column["geometry_types"].as_array().into_iter().flatten() {
            if let Some(t) = t.as_str()
                && !types.iter().any(|known| known == t)
            {
                types.push(t.to_string());
            }
        }
        match geoparquet::read_key_value(input, geoparquet::VINTAGE_KEY)? {
            Some(v) => {
                vintages.insert(v);
            }
            None => all_have_vintage = false,
        }
        geo.get_or_insert(value);
    }
    let mut geo = geo.context("元のファイルがありません")?;
    let primary = geo["primary_column"]
        .as_str()
        .unwrap_or("geometry")
        .to_string();
    geo["columns"][&primary]["bbox"] = serde_json::json!(bbox);
    types.sort();
    geo["columns"][&primary]["geometry_types"] = serde_json::json!(types);

    let mut kv = vec![
        ("geo".to_string(), serde_json::to_string(&geo)?),
        ("duck:lod_by_tier".to_string(), "1".to_string()),
        (LOD_MAX_KEY.to_string(), lod_max.to_string()),
    ];
    if all_have_vintage && vintages.len() == 1 {
        let vintage = vintages.into_iter().next().expect("1つある");
        kv.push((geoparquet::VINTAGE_KEY.to_string(), vintage));
    }
    Ok(kv)
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
