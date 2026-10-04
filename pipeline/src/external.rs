//! **外部で公開されている配信物をカタログに載せる。** うちのR2には置かない。
//!
//! いまは地理院の最適化ベクトルタイル (PMTiles) だけ。公開されている cloud-native な
//! ファイルは、複製しなくてもカタログから指せる。STAC のアセットは絶対URLでよい。
//!
//! **ネットワークはカタログを作るときに触らない。** 先に `describe_pmtiles` で
//! ヘッダとメタデータを取り、`pipeline/external/` にスナップショットとして置く
//! (追跡する)。カタログはそれを読むだけなので、何度作っても同じものになり、
//! 向こうが変わったときはスナップショットの差分で分かる。
//!
//! タイルは**表示のために加工されたもの** (簡略化・量子化) なので、SQL で引く
//! データとしては扱わない (docs/data-sources.md の「描画用データではなく元データを
//! 基準にする」)。重ねて見るためのレイヤーとして載せる。
use crate::catalog::{Attribution, Commercial, Terms};
use crate::pmtiles::{Header, Metadata};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// `describe_pmtiles` が書くスナップショット。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Snapshot {
    pub url: String,
    /// ファイル全体の大きさ (バイト)。
    pub bytes: u64,
    pub tile_type: u8,
    pub addressed_tiles: u64,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// [西, 南, 東, 北] (WGS84)。
    pub bounds: [f64; 4],
    pub metadata: Metadata,
}

impl Snapshot {
    pub fn new(url: &str, bytes: u64, header: &Header, metadata: Metadata) -> Self {
        Self {
            url: url.to_string(),
            bytes,
            tile_type: header.tile_type,
            addressed_tiles: header.addressed_tiles,
            min_zoom: header.min_zoom,
            max_zoom: header.max_zoom,
            bounds: header.bounds,
            metadata,
        }
    }
}

/// 層を束ねるテーマ。**一覧の1行になる。**
///
/// タイルの中の層 (地理院なら24) をそのまま並べると多すぎ、スタイルの描画の層
/// (123) を並べるともっと多い (地理院地図Vectorの一覧が使いにくい理由の1つ)。
/// 人が「道路」「水部」と考える単位で束ね、開けば層ごとに入り切りできるようにする。
#[derive(Debug, Serialize)]
pub struct Theme {
    pub id: &'static str,
    pub title: &'static str,
    /// (層のID, 人向けの名前)。
    #[serde(serialize_with = "serialize_layers")]
    pub layers: &'static [(&'static str, &'static str)],
}

fn serialize_layers<S: serde::Serializer>(
    layers: &&'static [(&'static str, &'static str)],
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    use serde::ser::SerializeSeq;
    let mut seq = serializer.serialize_seq(Some(layers.len()))?;
    for (id, title) in layers.iter() {
        seq.serialize_element(&serde_json::json!({ "id": id, "title": title }))?;
    }
    seq.end()
}

/// 外部のタイルセット1つ。STAC の Collection 1つになる。
pub struct ExternalTileset {
    pub id: &'static str,
    /// 置き場所 (サブカタログ)。`stac::SUB_CATALOGS` にあること。
    pub dir: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub attribution: Attribution,
    /// 配布元 (説明のページ)。
    pub via: &'static str,
    // **描き方 (配布元のスタイル) は載せない。** 規約が明示しているのはタイル (データ) で、
    // スタイル・記号・フォントの扱いは書かれていない。データだけを載せ、描き方は
    // カタログに書いた形の種類 (面・線・点) から UI が決める (docs/data-sources.md)。
    /// いつ時点か。PMTiles には書かれていないので、配布元の記載を写す。
    pub vintage: &'static str,
    /// `describe_pmtiles` が書いたスナップショット (JSON)。
    pub snapshot: &'static str,
    pub themes: &'static [Theme],
}

impl ExternalTileset {
    pub fn snapshot(&self) -> Result<Snapshot> {
        serde_json::from_str(self.snapshot)
            .with_context(|| format!("{} のスナップショットが読めません", self.id))
    }

    /// **テーマがタイルの層をちょうど覆っているか。** 抜けも重複も、無い層も許さない。
    ///
    /// 配布元が層を足したら、スナップショットを取り直した時点でここが落ちる。
    /// 黙って一覧から漏れるのを防ぐため。
    pub fn validate(&self) -> Result<()> {
        let snapshot = self.snapshot()?;
        if snapshot.url.is_empty() {
            bail!("{} のスナップショットにURLがありません", self.id);
        }
        let in_tiles: BTreeSet<&str> = snapshot
            .metadata
            .vector_layers
            .iter()
            .map(|layer| layer.id.as_str())
            .collect();
        let mut in_themes = BTreeSet::new();
        for theme in self.themes {
            for (layer, _) in theme.layers {
                if !in_themes.insert(*layer) {
                    bail!("{}: 層 {layer} が2つのテーマに入っています", self.id);
                }
                if !in_tiles.contains(layer) {
                    bail!("{}: 層 {layer} はタイルにありません", self.id);
                }
            }
        }
        let missing: Vec<&str> = in_tiles.difference(&in_themes).copied().collect();
        if !missing.is_empty() {
            bail!(
                "{}: どのテーマにも入っていない層があります: {missing:?} \
                 (external.rs のテーマに足すこと)",
                self.id
            );
        }
        // **形の種類が分からない層は描けない** (描き方を形から決めるため)。
        // tilestats の無い PMTiles を載せようとしたらここで止まる。
        let shapeless: Vec<&str> = snapshot
            .metadata
            .vector_layers
            .iter()
            .filter(|layer| layer.geometry.is_none())
            .map(|layer| layer.id.as_str())
            .collect();
        if !shapeless.is_empty() {
            bail!(
                "{}: 形の種類 (tilestats) が分からない層があります: {shapeless:?}",
                self.id
            );
        }
        Ok(())
    }
}

/// 国土地理院コンテンツ利用規約。PDL1.0 と互換で、出典を示せば商用も可。
///
/// <https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html>
/// (このサイトは古いTLSの再ネゴシエーションを使っていて curl では開けないが、
/// ブラウザでは開ける。リポジトリの README が案内している正式なURL)
const GSI_TERMS: Terms = Terms {
    name: "国土地理院コンテンツ利用規約",
    url: "https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html",
    commercial: Commercial::Allowed,
    attribution_required: true,
    note_modification: true,
    share_alike: false,
};

/// 地理院の最適化ベクトルタイル。
///
/// **基本測量成果ではない**と明記されていて、測量法の承認は要らない (出典の明示だけ)。
/// 出典の書き方は README の指定どおり。試験公開なので URL や中身が変わりうる。
pub const GSI_OPTIMAL_BVMAP: ExternalTileset = ExternalTileset {
    id: "gsi-optimal-bvmap",
    dir: "gsi",
    title: "最適化ベクトルタイル",
    description: "国土地理院の地図をベクトルタイルにしたもの (試験公開)。重ねて見るためのもので、\
                  SQLでは引けない。形は表示のために簡略化されている。",
    attribution: Attribution {
        text: "国土地理院最適化ベクトルタイル",
        url: "https://github.com/gsi-cyberjapan/optimal_bvmap",
        license: "other",
        provider: "国土地理院",
        terms: GSI_TERMS,
    },
    via: "https://github.com/gsi-cyberjapan/optimal_bvmap",
    // README の「データ更新情報」。
    vintage: "2026-07-01 時点",
    snapshot: include_str!("../external/gsi-optimal-bvmap.json"),
    // 並びは一覧の並び。**名前 (注記) を先頭に**置く — 地図を読むときにいちばん効く。
    // 層の名前は地理院のスタイル (std.json) の描画の層の名前から取った。
    themes: &[
        Theme {
            id: "anno",
            title: "注記",
            layers: &[("Anno", "注記")],
        },
        Theme {
            id: "road",
            title: "道路",
            layers: &[
                ("RdCL", "道路中心線"),
                ("RdEdg", "道路縁"),
                ("RdCompt", "道路構成線"),
            ],
        },
        Theme {
            id: "rail",
            title: "鉄道",
            layers: &[("RailCL", "鉄道中心線"), ("RailTrCL", "軌道の中心線")],
        },
        Theme {
            id: "building",
            title: "建物",
            layers: &[("BldA", "建築物")],
        },
        Theme {
            id: "water",
            title: "水部",
            layers: &[
                ("WA", "水域"),
                ("WL", "水涯線"),
                ("RvrCL", "河川中心線"),
                ("Cstline", "海岸線"),
                ("WRltLine", "水部表記線"),
                ("WStrA", "水部構造物面"),
                ("WStrL", "水部構造物線"),
            ],
        },
        Theme {
            id: "terrain",
            title: "地形",
            layers: &[
                ("Cntr", "等高線"),
                ("Isbt", "等深線"),
                ("TpgphArea", "地形表記面"),
                ("TpgphLine", "地形表記線"),
            ],
        },
        Theme {
            id: "boundary",
            title: "境界",
            layers: &[
                ("AdmArea", "行政区画"),
                ("AdmBdry", "行政区画界線"),
                ("SpcfArea", "特定地区界"),
            ],
        },
        Theme {
            id: "structure",
            title: "構造物",
            layers: &[("StrctArea", "構造物面"), ("StrctLine", "構造物線")],
        },
        Theme {
            id: "power",
            title: "送電線",
            layers: &[("PwrTrnsmL", "送電線")],
        },
    ],
};

/// カタログに載せる外部のタイルセット。
pub const EXTERNAL_TILESETS: &[ExternalTileset] = &[GSI_OPTIMAL_BVMAP];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_themes_cover_the_tiles_exactly() {
        for tileset in EXTERNAL_TILESETS {
            tileset.validate().unwrap();
        }
    }

    #[test]
    fn rejects_a_layer_left_out_of_the_themes() {
        let tileset = ExternalTileset {
            themes: &[Theme {
                id: "road",
                title: "道路",
                layers: &[("RdCL", "道路中心線")],
            }],
            ..GSI_OPTIMAL_BVMAP
        };
        let message = tileset.validate().unwrap_err().to_string();
        assert!(message.contains("どのテーマにも入っていない"), "{message}");
        assert!(message.contains("BldA"), "{message}");
    }

    #[test]
    fn rejects_a_layer_the_tiles_do_not_have() {
        let tileset = ExternalTileset {
            themes: &[Theme {
                id: "x",
                title: "x",
                layers: &[("NoSuchLayer", "無い層")],
            }],
            ..GSI_OPTIMAL_BVMAP
        };
        let message = tileset.validate().unwrap_err().to_string();
        assert!(message.contains("タイルにありません"), "{message}");
    }

    #[test]
    fn rejects_a_layer_in_two_themes() {
        let tileset = ExternalTileset {
            themes: &[
                Theme {
                    id: "a",
                    title: "a",
                    layers: &[("BldA", "建築物")],
                },
                Theme {
                    id: "b",
                    title: "b",
                    layers: &[("BldA", "建築物")],
                },
            ],
            ..GSI_OPTIMAL_BVMAP
        };
        let message = tileset.validate().unwrap_err().to_string();
        assert!(message.contains("2つのテーマ"), "{message}");
    }
}
