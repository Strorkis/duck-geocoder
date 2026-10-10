use anyhow::{Context, Result, bail};
use arrow::compute::concat_batches;
use duck_geocoder::geoparquet;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::arrow_writer::ArrowWriter;
use parquet::basic::{Compression, ZstdLevel};
use parquet::file::metadata::KeyValue;
use parquet::file::properties::WriterProperties;
use std::collections::BTreeMap;
use std::fs::File;
use std::path::PathBuf;

/// GeoParquet を**並べ直さずに**1ファイルへつなぐ。行グループは入力の順のまま、中身も区切りも変えない。
///
/// **ファイルの分け方だけを比べるための道具** (docs/geoparquet-layout.md「どこまでファイルを分けるか」)。
/// 並べ直すと行グループの中身まで変わり、分け方の効き目と混ざる。行グループ1つずつ読んで書くので、
/// 全国の建物 (3.6GB) でもメモリに載る。
///
/// KV は入力で値が揃っているものだけを残す (都市ごとの `duck:via` などは落ちる)。`geo` の範囲は和にする。
fn main() -> Result<()> {
    let args: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    let [output, inputs @ ..] = args.as_slice() else {
        bail!("usage: concat_geoparquet <出力> <入力>...");
    };
    if inputs.is_empty() {
        bail!(
            "usage: concat_geoparquet <出力> <入力>...\n\n\
             GeoParquet を並べ直さずに1ファイルへつなぐ (行グループはそのまま)。\n\n\
             例:\n  concat_geoparquet /tmp/tokyo23.parquet ../data/output/plateau/plateau_bldg_131[0-2][0-9].parquet"
        );
    }
    if inputs.contains(output) {
        bail!("出力を入力に含めないでください: {}", output.display());
    }

    let kv = merged_key_values(inputs)?;
    let first = File::open(&inputs[0])?;
    let schema = ParquetRecordBatchReaderBuilder::try_new(first)?
        .schema()
        .clone();

    let temporary = output.with_extension("parquet.writing");
    let properties = WriterProperties::builder()
        // 行グループは入力の区切りで切る (ここで割らない)。
        .set_max_row_group_row_count(Some(usize::MAX))
        .set_compression(Compression::ZSTD(ZstdLevel::default()))
        .build();
    let mut writer =
        ArrowWriter::try_new(File::create(&temporary)?, schema.clone(), Some(properties))?;

    let mut row_groups = 0;
    let mut rows = 0;
    for input in inputs {
        let file = File::open(input).with_context(|| format!("開けません: {}", input.display()))?;
        let builder = ParquetRecordBatchReaderBuilder::try_new(file)?;
        if builder.schema().fields() != schema.fields() {
            bail!("列の構成が違います: {}", input.display());
        }
        let count = builder.metadata().num_row_groups();
        for index in 0..count {
            let file = File::open(input)?;
            let reader = ParquetRecordBatchReaderBuilder::try_new(file)?
                .with_row_groups(vec![index])
                .build()?;
            let batches = reader.collect::<std::result::Result<Vec<_>, _>>()?;
            let batch = concat_batches(&schema, &batches)?;
            rows += batch.num_rows();
            writer.write(&batch)?;
            // **入力の行グループの境で必ず切る。**
            writer.flush()?;
            row_groups += 1;
        }
    }
    for (key, value) in kv {
        writer.append_key_value_metadata(KeyValue::new(key, value));
    }
    writer.close()?;
    std::fs::rename(&temporary, output)?;
    println!(
        "{}: {} ファイルから {} 行 / row group {} 個 / {:.1} MB",
        output.display(),
        inputs.len(),
        rows,
        row_groups,
        std::fs::metadata(output)?.len() as f64 / 1e6,
    );
    Ok(())
}

/// 入力で値が揃っている KV だけを残す。`geo` は範囲を和にして残す。
fn merged_key_values(inputs: &[PathBuf]) -> Result<Vec<(String, String)>> {
    let mut seen: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut bbox = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut geo: Option<serde_json::Value> = None;
    for (i, input) in inputs.iter().enumerate() {
        let kv: BTreeMap<String, String> = geoparquet::read_all_key_values(input)?
            .into_iter()
            .filter(|(key, _)| key != "ARROW:schema" && key != "geo")
            .collect();
        if i == 0 {
            seen = kv
                .iter()
                .map(|(k, v)| (k.clone(), Some(v.clone())))
                .collect();
        } else {
            for (key, value) in seen.iter_mut() {
                if kv.get(key) != value.as_ref() {
                    *value = None;
                }
            }
        }
        let value: serde_json::Value = serde_json::from_str(
            &geoparquet::read_key_value(input, "geo")?
                .with_context(|| format!("`geo` がありません: {}", input.display()))?,
        )?;
        let primary = value["primary_column"]
            .as_str()
            .unwrap_or("geometry")
            .to_string();
        if let Some([xmin, ymin, xmax, ymax]) =
            value["columns"][&primary]["bbox"].as_array().and_then(|b| {
                <[f64; 4]>::try_from(b.iter().filter_map(|v| v.as_f64()).collect::<Vec<_>>()).ok()
            })
        {
            bbox = [
                bbox[0].min(xmin),
                bbox[1].min(ymin),
                bbox[2].max(xmax),
                bbox[3].max(ymax),
            ];
        }
        geo.get_or_insert(value);
    }
    let mut geo = geo.context("入力がありません")?;
    let primary = geo["primary_column"]
        .as_str()
        .unwrap_or("geometry")
        .to_string();
    geo["columns"][&primary]["bbox"] = serde_json::json!(bbox);
    let mut out = vec![("geo".to_string(), serde_json::to_string(&geo)?)];
    out.extend(seen.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))));
    Ok(out)
}
