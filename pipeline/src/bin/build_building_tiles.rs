use anyhow::{Context, Result, bail};
use duck_geocoder::catalog::tiers_for_file;
use duck_geocoder::geoparquet;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 建物の**引いた表示のためのベクタタイル** (PMTiles) を作る。
///
/// 引いた表示 (段で間引くズーム) は、GeoParquet を DuckDB で読むと都市ごとのファイルを十数個開き、
/// R2 では1分近くかかった。描くための簡略化・間引きはタイルの本業で、MapLibre はタイルを並列に取る。
/// 同じ建物 (最後の段を除く) を PMTiles にすると、東京駅 z13 が 39秒 → 10秒になった
/// (docs/format-survey.md「測ったこと」)。
///
/// - **最後の段 (住宅・その他) を除く。** 段 k はズーム `MIN_ZOOM + k` から入れる
///   (UI は1ズーム引くごとに1段減らすので、それより引いたズームには要らない)
/// - 属性は描く・絞る・吹き出しに要るものだけ: `lod` (段の順位)・名前・用途 (`category`)・高さ
/// - **元の GeoParquet はそのまま** (寄った表示・周辺検索・保存はそちらを読む)。タイルは描くためだけ
/// - カタログ (`build_catalog`) が見つけて、建物の Collection のアセット `tiles` に載せる
///
/// 元のファイルに段 (`add_building_lod`) が付いていることが前提。tippecanoe が要る。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let dir = match args.as_slice() {
        [_, dir] => PathBuf::from(dir),
        _ => bail!(
            "usage: build_building_tiles <配信ディレクトリ>\n\n\
             建物の引いた表示のための PMTiles (最後の段を除いた行) を作る。tippecanoe が要る。\n\n\
             例:\n  build_building_tiles ../data/output"
        ),
    };
    for family in FAMILIES {
        build_family(&dir, family)?;
    }
    Ok(())
}

/// タイルを作る建物の出所。
struct Family {
    /// 配信ディレクトリの中のサブディレクトリ。
    dir: &'static str,
    /// 元のファイル名の頭。後ろに数字だけが続くもの (都市コード・QuadKey) が元のファイル。
    prefix: &'static str,
}

const FAMILIES: &[Family] = &[
    Family {
        dir: "plateau",
        prefix: "plateau_bldg_",
    },
    Family {
        dir: "overture",
        prefix: "overture_buildings_",
    },
];

/// タイルのファイル名に付ける語 (`plateau_bldg_tiles.pmtiles`)。カタログはこれで建物の Collection に結び付ける。
const TILES_WORD: &str = "tiles";
/// タイルの層の名前。UI はこれを読む (カタログにも載る)。
const LAYER: &str = "buildings";
/// いちばん引いたズーム。表示量「多め」で、公共施設だけが出始めるズーム (建物が全部出るのは 14)。
const MIN_ZOOM: u8 = 12;
/// いちばん寄ったズーム。これより寄った間引きは、このズームのタイルを拡大して描く。
const MAX_ZOOM: u8 = 14;

fn build_family(dir: &Path, family: &Family) -> Result<()> {
    let source_dir = dir.join(family.dir);
    let mut inputs: Vec<PathBuf> = std::fs::read_dir(&source_dir)
        .with_context(|| format!("読めません: {}", source_dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "parquet")
                && path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .and_then(|stem| stem.strip_prefix(family.prefix))
                    // 数字だけのものが元のファイル (整備範囲などを拾わない)。
                    .is_some_and(|code| {
                        !code.is_empty() && code.bytes().all(|b| b.is_ascii_digit())
                    })
        })
        .collect();
    inputs.sort();
    let Some(first) = inputs.first() else {
        println!("{}: 元のファイルがありません", source_dir.display());
        return Ok(());
    };

    let stem = first
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let tiers =
        tiers_for_file(stem).with_context(|| format!("重要度の段の規則がありません: {stem}"))?;
    if tiers.tiers.len() < 2 {
        bail!("段が1つしかないのでタイルは作れません: {stem}");
    }
    // **最後の段 (住宅・その他) を除く。** 量の大半はそこ (PLATEAU で 3.8GB のうち 3.4GB)。
    let lod_max = tiers.tiers.len() - 2;
    for input in &inputs {
        if geoparquet::read_key_value(input, "duck:lod_by_tier")?.is_none() {
            bail!(
                "段が付いていません (先に add_building_lod を流す): {}",
                input.display()
            );
        }
    }

    let output = source_dir.join(format!("{}{TILES_WORD}.pmtiles", family.prefix));
    // **拡張子は `.fgb` で終える。** tippecanoe は拡張子で形式を決める (違うと GeoJSON として読み、
    // 「有効な形が無い」で止まる)。
    let staged = output.with_extension("writing.fgb");
    let list = inputs
        .iter()
        .map(|path| {
            path.to_str()
                .map(|s| format!("'{}'", s.replace('\'', "''")))
                .context("入力パスがUTF-8ではありません")
        })
        .collect::<Result<Vec<_>>>()?
        .join(", ");
    let staged_str = staged.to_str().context("出力パスがUTF-8ではありません")?;
    // 用途の列は段の規則が見ている列 (PLATEAU は usage、Overture は class)。UI の絞り込みと同じ列。
    // **タイルでは `category` という名前にそろえる** (UI が出所ごとに列名を書き分けずに済む)。
    let category = tiers.column;
    run(Command::new("duckdb").arg("-c").arg(format!(
        "INSTALL spatial; LOAD spatial;
SET geometry_always_xy = true;
COPY (
  SELECT lod::INTEGER AS lod, name, {category} AS category, height, geometry
  FROM read_parquet([{list}])
  WHERE lod <= {lod_max}
) TO '{staged_str}' WITH (FORMAT GDAL, DRIVER 'FlatGeobuf', SRS 'EPSG:4326');"
    )))
    .context("duckdb が失敗しました (mise install は済んでいますか?)")?;

    // 段 k はズーム MIN_ZOOM + k から入れる。
    let filter = serde_json::json!({
        "*": std::iter::once(serde_json::json!("any"))
            .chain((0..=lod_max).map(|k| {
                serde_json::json!(["all", ["==", "lod", k], [">=", "$zoom", MIN_ZOOM as usize + k]])
            }))
            .collect::<Vec<_>>()
    });
    let result = run(Command::new("tippecanoe")
        .args(["-q", "--force", "-l", LAYER, "-T", "lod:int"])
        .arg(format!("-Z{MIN_ZOOM}"))
        .arg(format!("-z{MAX_ZOOM}"))
        .arg("-j")
        .arg(filter.to_string())
        // **間引かない。** 段で既に間引いてあり、タイルの中でさらに落とすと「無い」と読まれる。
        .args(["--no-feature-limit", "--no-tile-size-limit"])
        .arg("-o")
        .arg(&output)
        .arg(&staged))
    .context("tippecanoe が失敗しました (入っていますか?)");
    std::fs::remove_file(&staged).ok();
    result?;

    println!(
        "{}: {} ファイルから (段 {lod_max} まで、ズーム {MIN_ZOOM}〜{MAX_ZOOM}) / {:.1} MB",
        output.display(),
        inputs.len(),
        std::fs::metadata(&output)?.len() as f64 / 1e6,
    );
    Ok(())
}

fn run(command: &mut Command) -> Result<()> {
    let status = command.status()?;
    if !status.success() {
        bail!("{status}");
    }
    Ok(())
}
