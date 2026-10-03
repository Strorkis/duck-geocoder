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
    serde_json::from_slice(&json).context("メタデータが JSON として読めません")
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
    }
}
