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

// ---- 外部のラスタタイル (背景地図・標高) -----------------------------------------
//
// **背景地図も、どこから来ているかをデータと同じように見せる。** 以前は UI のコードに
// URL が書いてあるだけで、出所も使う条件もカタログに無かった。地図タイルは1ファイルでは
// ないので、アセットではなく STAC の web-map-links 拡張のリンク (`rel: "xyz"` /
// `"tilejson"`) で指す。

/// タイルの在りか。
pub enum TileLink {
    /// `{z}/{x}/{y}` のテンプレート。
    Xyz {
        template: &'static str,
        media_type: &'static str,
    },
    /// TileJSON。中身 (タイルのURL・エンコード) は読む側が TileJSON から取る。
    TileJson { url: &'static str },
}

/// ラスタタイルの役割。UI がどう重ねるかを決める。
#[derive(Clone, Copy)]
pub enum RasterRole {
    /// 背景地図。いちばん下に敷き、不透明度を変えて重ねられる。
    Basemap,
    /// 標高 (地形)。地図を立体にする。
    Terrain,
}

/// 外部のラスタタイル1つ。STAC の Collection 1つになる (Item もアセットも無い)。
pub struct ExternalRaster {
    pub id: &'static str,
    /// 置き場所 (サブカタログ)。`stac::SUB_CATALOGS` にあること。
    pub dir: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub attribution: Attribution,
    /// 配布元 (説明のページ)。
    pub via: &'static str,
    pub role: RasterRole,
    pub link: TileLink,
    /// **タイルが実際にあるズーム。** 無いズームを要求すると 404 を撃ち続ける
    /// (白地図は5〜14、標高は TileJSON が宣言していないが16まで。いずれも実測)。
    pub minzoom: u8,
    pub maxzoom: u8,
    pub tile_size: u16,
    /// 収録範囲 [西, 南, 東, 北]。
    pub bounds: [f64; 4],
}

/// 地理院タイル。利用規約により出典表示が必須。
const GSI_TILES: Attribution = Attribution {
    text: "国土地理院",
    url: "https://maps.gsi.go.jp/development/ichiran.html",
    license: "other",
    provider: "国土地理院",
    terms: GSI_TERMS,
};
const GSI_TILES_VIA: &str = "https://maps.gsi.go.jp/development/ichiran.html";
/// 地理院タイルの範囲。日本とその周り (世界の低ズームもあるが、使うのは日本)。
const JAPAN_BOUNDS: [f64; 4] = [122.0, 20.0, 154.0, 46.0];

/// Mapterhorn の標高タイル。**日本は基盤地図情報 (数値標高モデル)**。
///
/// 測量法の使用承認は Mapterhorn 側が取得している (attribution.json の日本のソースの
/// ライセンス欄、2026-10-04 に確かめた番号)。こちらは配信されているタイルを実行時に
/// 読むだけ。番号は向こうが取り直すと変わる (以前は R 7JHs 542 だった) ので、
/// 取り直すときに <https://download.mapterhorn.com/attribution.json> を見ること。
/// 商用の扱いはソースごとに違い、まとめた規約は無いので「制限の記載なし」にする。
const MAPTERHORN: Attribution = Attribution {
    text: "© Mapterhorn / 基盤地図情報（数値標高モデル）国土地理院 \
           (測量法に基づく国土地理院長承認（使用）R 8JHs 131)",
    url: "https://mapterhorn.com/attribution",
    license: "other",
    provider: "Mapterhorn",
    terms: Terms {
        name: "Mapterhorn の出典 (ソースごとのライセンス。日本は国土地理院コンテンツ利用規約)",
        url: "https://mapterhorn.com/attribution",
        commercial: Commercial::NotRestricted,
        attribution_required: true,
        note_modification: false,
        share_alike: false,
    },
};

/// 背景地図と標高。**並びは一覧の並び**で、背景地図は先頭が既定で出る。
pub const EXTERNAL_RASTERS: &[ExternalRaster] = &[
    ExternalRaster {
        id: "gsi-pale",
        dir: "gsi",
        title: "淡色地図",
        description: "地理院タイルの淡色地図。色を抑えてあり、重ねたデータが読みやすい。",
        attribution: GSI_TILES,
        via: GSI_TILES_VIA,
        role: RasterRole::Basemap,
        link: TileLink::Xyz {
            template: "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png",
            media_type: "image/png",
        },
        minzoom: 0,
        maxzoom: 18,
        tile_size: 256,
        bounds: JAPAN_BOUNDS,
    },
    ExternalRaster {
        id: "gsi-std",
        dir: "gsi",
        title: "標準地図",
        description: "地理院タイルの標準地図。",
        attribution: GSI_TILES,
        via: GSI_TILES_VIA,
        role: RasterRole::Basemap,
        link: TileLink::Xyz {
            template: "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png",
            media_type: "image/png",
        },
        minzoom: 0,
        maxzoom: 18,
        tile_size: 256,
        bounds: JAPAN_BOUNDS,
    },
    ExternalRaster {
        id: "gsi-photo",
        dir: "gsi",
        title: "航空写真",
        description: "地理院タイルの全国最新写真 (シームレス)。地形を入れたときに起伏が分かる。",
        attribution: GSI_TILES,
        via: GSI_TILES_VIA,
        role: RasterRole::Basemap,
        link: TileLink::Xyz {
            template: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
            media_type: "image/jpeg",
        },
        minzoom: 0,
        maxzoom: 18,
        tile_size: 256,
        bounds: JAPAN_BOUNDS,
    },
    ExternalRaster {
        id: "gsi-blank",
        dir: "gsi",
        title: "白地図",
        description: "地理院タイルの白地図。文字が無いので、重ねたデータや注記が読みやすい。ズーム5〜14。",
        attribution: GSI_TILES,
        via: GSI_TILES_VIA,
        role: RasterRole::Basemap,
        link: TileLink::Xyz {
            template: "https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png",
            media_type: "image/png",
        },
        minzoom: 5,
        maxzoom: 14,
        tile_size: 256,
        bounds: JAPAN_BOUNDS,
    },
    ExternalRaster {
        id: "mapterhorn-terrain",
        dir: "mapterhorn",
        title: "標高 (地形)",
        description: "世界の標高タイル。日本は基盤地図情報 (数値標高モデル、1m・5m・10m)。\
                      地図を立体にする。表示専用で SQL では引けない。",
        attribution: MAPTERHORN,
        via: "https://mapterhorn.com/",
        role: RasterRole::Terrain,
        link: TileLink::TileJson {
            url: "https://tiles.mapterhorn.com/tilejson.json",
        },
        minzoom: 0,
        maxzoom: 16,
        tile_size: 512,
        bounds: [-180.0, -85.051_128_7, 180.0, 85.051_128_7],
    },
];

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
