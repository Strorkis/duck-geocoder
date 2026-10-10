//! [PMTiles v3](https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md) の
//! ヘッダとメタデータを読む。**タイルそのものは読まない。**
//!
//! 外部で公開されている PMTiles をカタログに載せるときに使う。ヘッダ (127バイト) と
//! メタデータ (数KB) だけを HTTP Range で取れば、収録範囲・ズーム・層の一覧
//! (`vector_layers`) が分かる。GeoParquet のフッターから列を読むのと同じ考え方。
//!
//! 地理院の最適化ベクトルタイルは 16.9GB あるが、読むのは 7KB 弱で済む。
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;

/// ヘッダの長さ。v3 は固定長。
pub const HEADER_LEN: u64 = 127;

/// ヘッダのうち、カタログに要るもの。
#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    pub metadata_offset: u64,
    pub metadata_length: u64,
    pub addressed_tiles: u64,
    /// メタデータなど内部の圧縮。0 不明 / 1 なし / 2 gzip / 3 brotli / 4 zstd。
    pub internal_compression: u8,
    /// タイルの種類。1 MVT / 2 PNG / 3 JPEG / 4 WebP / 5 AVIF。
    pub tile_type: u8,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// [西, 南, 東, 北] (WGS84)。
    pub bounds: [f64; 4],
}

/// ヘッダを読む。**v3 以外は断る** (配置が違う)。
pub fn parse_header(bytes: &[u8]) -> Result<Header> {
    if bytes.len() < HEADER_LEN as usize {
        bail!("ヘッダが短すぎます: {} バイト", bytes.len());
    }
    if &bytes[0..7] != b"PMTiles" {
        bail!("PMTiles ではありません (先頭が {:?})", &bytes[0..7]);
    }
    if bytes[7] != 3 {
        bail!("PMTiles v{} には対応していません (v3 だけ)", bytes[7]);
    }
    let u64_at = |offset: usize| u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
    // 経緯度は 1e7 倍した i32。
    let degrees_at = |offset: usize| {
        f64::from(i32::from_le_bytes(
            bytes[offset..offset + 4].try_into().unwrap(),
        )) / 1e7
    };
    Ok(Header {
        metadata_offset: u64_at(24),
        metadata_length: u64_at(32),
        addressed_tiles: u64_at(72),
        internal_compression: bytes[97],
        tile_type: bytes[99],
        min_zoom: bytes[100],
        max_zoom: bytes[101],
        bounds: [
            degrees_at(102),
            degrees_at(106),
            degrees_at(110),
            degrees_at(114),
        ],
    })
}

/// メタデータの層1つ (TileJSON の `vector_layers`)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VectorLayer {
    pub id: String,
    pub minzoom: u8,
    pub maxzoom: u8,
    /// 属性名 → 型 ("Number" / "String" など)。
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    /// **形の種類** ("Point" / "LineString" / "Polygon")。`tilestats` から写す。
    ///
    /// `vector_layers` には無い。これがあれば、配布元の描き方 (スタイル) に頼らず
    /// 面・線・点で描き分けられる。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry: Option<String>,
    /// 地物の数 (全ズームの延べ)。`tilestats` から写す。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    /// **数の属性の範囲** (属性名 → [最小, 最大])。`tilestats` から写す。
    ///
    /// 建物のタイルが**どの段まで入っているか** (`lod` の最大) を、ファイル自身から読むのに使う。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub ranges: BTreeMap<String, [f64; 2]>,
}

/// メタデータのうち、カタログに要るもの。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Metadata {
    #[serde(default)]
    pub vector_layers: Vec<VectorLayer>,
    /// **どう作ったか** (tippecanoe の引数など)。簡略化の度合いがここで分かる。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator_options: Option<String>,
}

/// tippecanoe が書く `tilestats` (層ごとの形と件数)。読むだけで、書き出さない。
#[derive(Debug, Deserialize)]
struct RawMetadata {
    #[serde(default)]
    vector_layers: Vec<VectorLayer>,
    #[serde(default)]
    generator_options: Option<String>,
    #[serde(default)]
    tilestats: Option<TileStats>,
}

#[derive(Debug, Deserialize)]
struct TileStats {
    #[serde(default)]
    layers: Vec<TileStatsLayer>,
}

#[derive(Debug, Deserialize)]
struct TileStatsLayer {
    layer: String,
    geometry: Option<String>,
    count: Option<u64>,
    #[serde(default)]
    attributes: Vec<TileStatsAttribute>,
}

/// `tilestats` の属性1つ。数の属性には `min` と `max` が付く。
#[derive(Debug, Deserialize)]
struct TileStatsAttribute {
    attribute: String,
    min: Option<f64>,
    max: Option<f64>,
}

/// メタデータを読む。圧縮はヘッダの `internal_compression` に従う。
pub fn parse_metadata(bytes: &[u8], compression: u8) -> Result<Metadata> {
    let json = match compression {
        // 1 は「圧縮なし」。0 (不明) も素のJSONとして試す。
        0 | 1 => bytes.to_vec(),
        2 => {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(bytes)
                .read_to_end(&mut out)
                .context("メタデータの gzip を解けません")?;
            out
        }
        other => bail!("メタデータの圧縮 {other} には対応していません (gzip だけ)"),
    };
    let raw: RawMetadata =
        serde_json::from_slice(&json).context("メタデータが JSON として読めません")?;
    // 形と件数は `tilestats` にしか無いので、層ごとに写す。
    let mut vector_layers = raw.vector_layers;
    if let Some(stats) = raw.tilestats {
        for layer in &mut vector_layers {
            if let Some(stat) = stats.layers.iter().find(|stat| stat.layer == layer.id) {
                layer.geometry.clone_from(&stat.geometry);
                layer.count = stat.count;
                layer.ranges = stat
                    .attributes
                    .iter()
                    .filter_map(|a| Some((a.attribute.clone(), [a.min?, a.max?])))
                    .collect();
            }
        }
    }
    Ok(Metadata {
        vector_layers,
        generator_options: raw.generator_options,
    })
}

/// 手元の PMTiles のヘッダとメタデータを読む (配信ディレクトリに置いたものをカタログに載せるとき)。
pub fn read_local(path: &std::path::Path) -> Result<(Header, Metadata)> {
    use std::io::{Seek, SeekFrom};
    let mut file =
        std::fs::File::open(path).with_context(|| format!("開けません: {}", path.display()))?;
    let mut head = vec![0u8; HEADER_LEN as usize];
    file.read_exact(&mut head)
        .with_context(|| format!("ヘッダを読めません: {}", path.display()))?;
    let header = parse_header(&head)?;
    let mut bytes = vec![0u8; header.metadata_length as usize];
    file.seek(SeekFrom::Start(header.metadata_offset))?;
    file.read_exact(&mut bytes)
        .with_context(|| format!("メタデータを読めません: {}", path.display()))?;
    let metadata = parse_metadata(&bytes, header.internal_compression)?;
    Ok((header, metadata))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 地理院の最適化ベクトルタイルと同じ値を持つヘッダ。
    fn header_bytes() -> Vec<u8> {
        let mut bytes = vec![0u8; HEADER_LEN as usize];
        bytes[0..7].copy_from_slice(b"PMTiles");
        bytes[7] = 3;
        bytes[24..32].copy_from_slice(&2503u64.to_le_bytes());
        bytes[32..40].copy_from_slice(&4168u64.to_le_bytes());
        bytes[72..80].copy_from_slice(&2_949_893u64.to_le_bytes());
        bytes[97] = 2;
        bytes[99] = 1;
        bytes[100] = 4;
        bytes[101] = 16;
        bytes[102..106].copy_from_slice(&1_220_000_000i32.to_le_bytes());
        bytes[106..110].copy_from_slice(&170_349_800i32.to_le_bytes());
        bytes[110..114].copy_from_slice(&1_547_666_670i32.to_le_bytes());
        bytes[114..118].copy_from_slice(&460_000_000i32.to_le_bytes());
        bytes
    }

    #[test]
    fn reads_the_header() {
        let header = parse_header(&header_bytes()).unwrap();
        assert_eq!(header.metadata_offset, 2503);
        assert_eq!(header.metadata_length, 4168);
        assert_eq!(header.addressed_tiles, 2_949_893);
        assert_eq!(header.internal_compression, 2);
        assert_eq!(header.tile_type, 1);
        assert_eq!((header.min_zoom, header.max_zoom), (4, 16));
        assert_eq!(header.bounds, [122.0, 17.034_98, 154.766_667, 46.0]);
    }

    #[test]
    fn refuses_other_formats_and_versions() {
        let mut bytes = header_bytes();
        bytes[7] = 2;
        assert!(parse_header(&bytes).unwrap_err().to_string().contains("v2"));
        bytes[0] = b'X';
        assert!(parse_header(&bytes).is_err());
        assert!(parse_header(&[0u8; 10]).is_err());
    }

    #[test]
    fn reads_gzipped_metadata() {
        let json = r#"{"vector_layers":[{"id":"BldA","minzoom":14,"maxzoom":16,
            "fields":{"vt_code":"Number"}}],"generator_options":"tippecanoe -S 2","name":"x"}"#;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(json.as_bytes()).unwrap();
        let metadata = parse_metadata(&encoder.finish().unwrap(), 2).unwrap();
        assert_eq!(metadata.vector_layers.len(), 1);
        assert_eq!(metadata.vector_layers[0].id, "BldA");
        assert_eq!(metadata.vector_layers[0].minzoom, 14);
        assert_eq!(metadata.vector_layers[0].fields["vt_code"], "Number");
        assert_eq!(
            metadata.generator_options.as_deref(),
            Some("tippecanoe -S 2")
        );
        // 素のJSONも読める。
        assert_eq!(parse_metadata(json.as_bytes(), 1).unwrap(), metadata);
        assert!(parse_metadata(b"", 3).is_err());
        // tilestats が無ければ、形も件数も分からないまま。
        assert_eq!(metadata.vector_layers[0].geometry, None);
    }

    /// **形と件数は tilestats から写す。** 配布元の描き方に頼らず描き分けるのに要る。
    #[test]
    fn copies_geometry_and_count_from_tilestats() {
        let json = r#"{"vector_layers":[
              {"id":"BldA","minzoom":14,"maxzoom":16},
              {"id":"Anno","minzoom":4,"maxzoom":16}],
            "tilestats":{"layerCount":2,"layers":[
              {"layer":"Anno","geometry":"Point","count":62236079},
              {"layer":"BldA","geometry":"Polygon","count":80556822}]}}"#;
        let metadata = parse_metadata(json.as_bytes(), 1).unwrap();
        let bld = &metadata.vector_layers[0];
        assert_eq!(bld.geometry.as_deref(), Some("Polygon"));
        assert_eq!(bld.count, Some(80_556_822));
        assert_eq!(metadata.vector_layers[1].geometry.as_deref(), Some("Point"));
    }

    /// **数の属性の範囲も写す。** 建物のタイルがどの段まで入っているかをここから読む。
    /// 文字列の属性 (min/max が無い) は写さない。
    #[test]
    fn copies_numeric_ranges_from_tilestats() {
        let json = r#"{"vector_layers":[{"id":"buildings","minzoom":12,"maxzoom":14}],
            "tilestats":{"layers":[{"layer":"buildings","geometry":"Polygon","count":10,
              "attributes":[{"attribute":"lod","type":"number","min":0,"max":1},
                            {"attribute":"name","type":"string","values":["a"]}]}]}}"#;
        let metadata = parse_metadata(json.as_bytes(), 1).unwrap();
        let ranges = &metadata.vector_layers[0].ranges;
        assert_eq!(ranges.get("lod"), Some(&[0.0, 1.0]));
        assert!(!ranges.contains_key("name"));
    }
}
