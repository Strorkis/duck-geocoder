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
    /// 3D Tiles の `tileset.json`。この地図 (MapLibre) では描けないが、カタログからは指す。
    ThreeDTiles { url: &'static str },
    /// タイルを持たない (**元データの参照**だけ。派生物の `derived_from` の行き先になる)。
    None,
    /// 公開元の STAC Collection (中身は COG)。**この地図ではまだ描かない**が、カタログから辿れる。
    Stac { url: &'static str },
}

/// ラスタタイルの役割。UI がどう重ねるかを決める。
#[derive(Clone, Copy)]
pub enum RasterRole {
    /// 背景地図。いちばん下に敷き、不透明度を変えて重ねられる。
    Basemap,
    /// 標高 (地形)。地図を立体にする。
    Terrain,
    /// 3D Tiles。この地図では描けない (公式のビューアで見る)。
    ThreeDTiles,
    /// 元データ。配っていない (派生物がどこから来たかを示すためだけに載せる)。
    Reference,
}

/// 標高タイルの形式 (`duck:dem`)。**同じ「標高タイル」でも中身の約束が違う**ので書く。
#[derive(Debug, serde::Serialize)]
pub struct DemSpec {
    /// `terrarium` / `mapbox` (Terrain-RGB) / `gsi` (地理院の独自形式)。
    pub encoding: &'static str,
    /// 高さの基準。`orthometric` (海面から) / `ellipsoid` (WGS84 楕円体から)。
    pub vertical: &'static str,
    /// 人向けの説明 (計算式・値なしの扱い・解像度)。
    pub description: &'static str,
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
    /// 標高の形式。地形だけが持つ。
    pub dem: Option<DemSpec>,
    /// **何から作られたか** (Collection の ID)。STAC の `rel: "derived_from"` になる。
    /// 「Mapterhorn の日本は基盤地図情報」のような関係をカタログで辿れるようにする。
    pub derived_from: &'static [&'static str],
    /// 公式のビューア (この地図で描けないものを見る先)。
    pub viewer: Option<&'static str>,
    /// **同じ役割の中で既定に使うもの** (`duck:default`)。地形は1つしか選べないので、
    /// 何を最初に使うかをカタログが示す (並び順に頼ると、サブカタログの順で変わってしまう)。
    pub default: bool,
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
        dem: None,
        derived_from: &[],
        viewer: None,
        // 背景地図の既定。色を抑えてあり、重ねたデータが読みやすい。
        default: true,
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
        dem: None,
        derived_from: &[],
        viewer: None,
        default: false,
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
        dem: None,
        derived_from: &[],
        viewer: None,
        default: false,
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
        dem: None,
        derived_from: &[],
        viewer: None,
        default: false,
    },
    // 起伏を見る2つ。**重ねて使う** (不透明度を下げて淡色地図や写真の上に)。
    // ズームは実測 (2026-10-05、東京付近のタイルを各ズームで取った)。
    ExternalRaster {
        id: "gsi-relief",
        dir: "gsi",
        title: "色別標高図",
        description: "地理院タイルの色別標高図。標高を色の段で塗り分けたもの。低い土地や台地の広がりが一目で分かる。ズーム5〜15。",
        attribution: GSI_TILES,
        via: GSI_TILES_VIA,
        role: RasterRole::Basemap,
        link: TileLink::Xyz {
            template: "https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png",
            media_type: "image/png",
        },
        minzoom: 5,
        maxzoom: 15,
        tile_size: 256,
        bounds: JAPAN_BOUNDS,
        dem: None,
        derived_from: &["gsi-dem-source"],
        viewer: None,
        default: false,
    },
    ExternalRaster {
        id: "gsi-hillshade",
        dir: "gsi",
        title: "陰影起伏図",
        description: "地理院タイルの陰影起伏図。光を当てたときの影で起伏を表したもの。ズーム2〜16。",
        attribution: GSI_TILES,
        via: GSI_TILES_VIA,
        role: RasterRole::Basemap,
        link: TileLink::Xyz {
            template: "https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png",
            media_type: "image/png",
        },
        minzoom: 2,
        maxzoom: 16,
        tile_size: 256,
        bounds: JAPAN_BOUNDS,
        dem: None,
        derived_from: &["gsi-dem-source"],
        viewer: None,
        default: false,
    },
    // ---- 標高 (地形) — **1つだけ選んで使う** ----
    ExternalRaster {
        id: "mapterhorn-terrain",
        dir: "mapterhorn",
        title: "Mapterhorn 標高",
        description: "世界の標高タイル。日本は基盤地図情報 (数値標高モデル、1m・5m・10m) から作られている。\
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
        bounds: WORLD_BOUNDS,
        dem: Some(DemSpec {
            encoding: "terrarium",
            vertical: "orthometric",
            description: "Terrarium (高さ = R×256 + G + B/256 − 32768 m)。海面からの高さ。\
                          ズーム16まで (TileJSON は最大ズームを書いていない)。",
        }),
        // 日本の部分の元データ。
        derived_from: &["gsi-dem-source"],
        viewer: None,
        // 地形の既定。ズーム16まであり、世界を覆い、そのまま (変換なしで) 読める。
        default: true,
    },
    ExternalRaster {
        id: "reearth-terrain",
        dir: "reearth",
        title: "Re:Earth Terrain 標高",
        description: "Mapterhorn の標高を配り直したもの。海面からの高さ (elevation) と、\
                      EGM2008 のジオイドを足した WGS84 楕円体からの高さ (ellipsoid) を選べる。\
                      ここでは MapLibre に合う海面からの高さを使う。3D の地球儀 (Cesium) と\
                      合わせるときは楕円体高の版を使う。",
        attribution: REEARTH_TERRAIN,
        via: "https://terrain.reearth.land/",
        role: RasterRole::Terrain,
        link: TileLink::TileJson {
            url: "https://terrain.reearth.land/terrarium/elevation/tilejson.json",
        },
        minzoom: 0,
        maxzoom: 14,
        tile_size: 512,
        bounds: WORLD_BOUNDS,
        dem: Some(DemSpec {
            encoding: "terrarium",
            vertical: "orthometric",
            description: "Terrarium (高さ = R×256 + G + B/256 − 32768 m)。海面からの高さ。\
                          同じ形で楕円体高 (/terrarium/ellipsoid/) と Terrain-RGB (/mapbox/) の版もある。ズーム14まで。",
        }),
        derived_from: &["mapterhorn-terrain"],
        viewer: Some("https://terrain.reearth.land/viewer"),
        default: false,
    },
    ExternalRaster {
        id: "gsi-dem",
        dir: "gsi",
        title: "標高タイル",
        description: "地理院タイルの標高タイル (基盤地図情報 数値標高モデルから作ったもの)。\
                      **独自の形式**なので、地形に使うときはブラウザで Terrarium に詰め直す。\
                      ズーム14まで (10mメッシュ)。より細かい 5m (ズーム15) と 1m (ズーム17) は別のタイル。",
        attribution: GSI_DEM_TILES,
        via: "https://maps.gsi.go.jp/development/demtile.html",
        role: RasterRole::Terrain,
        link: TileLink::Xyz {
            template: "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png",
            media_type: "image/png",
        },
        minzoom: 1,
        maxzoom: 14,
        tile_size: 256,
        bounds: JAPAN_BOUNDS,
        dem: Some(DemSpec {
            encoding: "gsi",
            vertical: "orthometric",
            description: "x = R×2¹⁶ + G×2⁸ + B。x < 2²³ なら 高さ = x × 0.01 m、x = 2²³ (128,0,0) は値なし (海など)、\
                          x > 2²³ なら 高さ = (x − 2²⁴) × 0.01 m (負の値)。線形の部分は Terrain-RGB と同じ形だが、\
                          値なしと負の値はそのままでは読めない。z15 は dem5a_png (5m)、z17 は dem1a_png (1m)。",
        }),
        derived_from: &["gsi-dem-source"],
        viewer: None,
        default: false,
    },
    // ---- 元データ (配っていない。派生物の出どころとして載せる) ----
    ExternalRaster {
        id: "gsi-dem-source",
        dir: "gsi",
        title: "基盤地図情報 数値標高モデル (元データ)",
        description: "地理院の標高タイルと、Mapterhorn の日本の部分の元データ。1m・5m・10m のメッシュ。\
                      **基本測量成果なので、複製・使用には測量法の承認が要る** (Mapterhorn は取得している)。\
                      このカタログからは配っていない。",
        attribution: GSI_DEM_SOURCE,
        via: "https://service.gsi.go.jp/kiban/",
        role: RasterRole::Reference,
        link: TileLink::None,
        minzoom: 0,
        maxzoom: 0,
        tile_size: 0,
        bounds: JAPAN_BOUNDS,
        dem: None,
        derived_from: &[],
        viewer: None,
        default: false,
    },
    // ---- 3D Tiles (この地図では描けない) ----
    ExternalRaster {
        id: "reearth-buildings",
        dir: "reearth",
        title: "Re:Earth Buildings (3D Tiles)",
        description: "Overture の建物から作った 3D Tiles 1.1 (glTF)。Cesium 向けで、この地図 (MapLibre) では\
                      描けないので、公式のビューアで見る。**高さは WGS84 楕円体から** (地盤の高さは\
                      Re:Earth Terrain の楕円体高で焼き込み済み)。海面からの高さの地形と重ねると、\
                      日本では40m前後浮く。",
        attribution: REEARTH_BUILDINGS,
        via: "https://buildings.reearth.land/",
        role: RasterRole::ThreeDTiles,
        link: TileLink::ThreeDTiles {
            url: "https://buildings.reearth.land/tileset.json",
        },
        minzoom: 12,
        maxzoom: 14,
        tile_size: 0,
        bounds: WORLD_BOUNDS,
        dem: None,
        derived_from: &["overture-buildings", "reearth-terrain"],
        viewer: Some("https://buildings.reearth.land/"),
        default: false,
    },
    ExternalRaster {
        id: "plateau-3dtiles",
        dir: "plateau",
        title: "建物 (3D Tiles・公式配信)",
        description: "PLATEAU 配信サービスが配っている建物の 3D Tiles。全国の都市を1つの tileset.json に束ねたもの \
                      (都市ごとに LOD2 まで細かいものを採り、テクスチャがあればテクスチャ付き)。この地図 (MapLibre) では \
                      描けないので、公式のビューア (PLATEAU VIEW) で見る。配信サービスは試験運用で、提供期間や品質の保証は無い。",
        attribution: PLATEAU_TILES,
        via: "https://docs.plateauview.mlit.go.jp/datasets/3d-tiles/",
        role: RasterRole::ThreeDTiles,
        link: TileLink::ThreeDTiles {
            url: "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-maxlod2-latest/tileset.json",
        },
        minzoom: 0,
        maxzoom: 0,
        tile_size: 0,
        bounds: JAPAN_BOUNDS,
        dem: None,
        derived_from: &[],
        viewer: Some("https://plateauview.mlit.go.jp/"),
        default: false,
    },
    // ---- 配っていない元データ (承認が要るもの) ----
    ExternalRaster {
        id: "ksj-admin-source",
        dir: "ksj",
        title: "行政区域 N03 (元データ)",
        description: "国土数値情報の行政区域。市区町村の境界の国のデータで、本来はこちらを使いたい。\
                      **基本測量成果をもとにしているので、複製には測量法の承認が要る** (配布ページに記載)。\
                      承認を取るまでは配らず、行政区域は Overture のものを使っている。",
        attribution: MLIT_KSJ_N03,
        via: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html",
        role: RasterRole::Reference,
        link: TileLink::None,
        minzoom: 0,
        maxzoom: 0,
        tile_size: 0,
        bounds: JAPAN_BOUNDS,
        dem: None,
        derived_from: &[],
        viewer: None,
        default: false,
    },
    // ---- 衛星の標高 (参照だけ。この地図ではまだ描かない) ----
    ExternalRaster {
        id: "jaxa-aw3d30",
        dir: "jaxa",
        title: "AW3D30 (全球の数値表層モデル)",
        description: "ALOS の光学ステレオ (PRISM) から作った全球の **DSM (数値表層モデル)**。約30m (1秒)、版は 4.1 (2024年4月)。\
                      地面ではなく**建物や木の上の高さ**を測っているので、建物も森も無いところでは地面の高さの参考になる \
                      (地理院の標高 (DTM) との差で、地面より上にあるものの高さも概算できる)。日本の外も覆う。\
                      公開元の JAXA Earth API が 1°×1° の COG と STAC で配っていて、登録なしでブラウザから直接読める \
                      (Range・CORS に対応)。このカタログからは配っていない。",
        attribution: JAXA_AW3D30,
        via: "https://www.eorc.jaxa.jp/ALOS/jp/dataset/aw3d30/aw3d30_j.htm",
        role: RasterRole::Reference,
        link: TileLink::Stac {
            url: "https://s3.ap-northeast-1.wasabisys.com/je-pds/cog/v1/JAXA.EORC_ALOS.PRISM_AW3D30.v4.1_global/collection.json",
        },
        minzoom: 0,
        maxzoom: 0,
        tile_size: 0,
        bounds: [-180.0, -90.0, 180.0, 90.0],
        dem: None,
        derived_from: &[],
        viewer: None,
        default: false,
    },
    // NASA の2つ。AW3D30 と同じく約30mの DSM。条件はゆるい (パブリックドメイン・制限なし) が、
    // 実体を取るには NASA Earthdata のログインか、Planetary Computer のトークンが要る。
    ExternalRaster {
        id: "nasa-nasadem",
        dir: "nasa",
        title: "NASADEM (全球の数値表層モデル)",
        description: "2000年のスペースシャトルのレーダー観測 (SRTM) を作り直した DSM。約30m (1秒)、北緯60°〜南緯56°。\
                      パブリックドメイン。実体 (COG) は Microsoft Planetary Computer の STAC から取れるが、\
                      読むには匿名で取れる期限付きのトークンが要る。このカタログからは配っていない。",
        attribution: NASADEM,
        via: "https://www.earthdata.nasa.gov/data/catalog/lpcloud-nasadem-hgt-001",
        role: RasterRole::Reference,
        link: TileLink::Stac {
            url: "https://planetarycomputer.microsoft.com/api/stac/v1/collections/nasadem",
        },
        minzoom: 0,
        maxzoom: 0,
        tile_size: 0,
        bounds: [-180.0, -56.0, 180.0, 60.0],
        dem: None,
        derived_from: &[],
        viewer: None,
        default: false,
    },
    ExternalRaster {
        id: "nasa-aster-gdem",
        dir: "nasa",
        title: "ASTER GDEM v3 (全球の数値表層モデル)",
        description: "経済産業省と NASA の衛星センサ ASTER の光学ステレオから作った DSM (2019年)。約30m (1秒)、\
                      北緯83°〜南緯83°。再利用・再配布に制限は無い。実体 (COG) は NASA Earthdata にあり、\
                      取るにはログインが要る。このカタログからは配っていない。",
        attribution: ASTER_GDEM,
        via: "https://www.earthdata.nasa.gov/data/catalog/lpcloud-astgtm-003",
        role: RasterRole::Reference,
        link: TileLink::Stac {
            url: "https://cmr.earthdata.nasa.gov/stac/LPCLOUD/collections/ASTGTM_003",
        },
        minzoom: 0,
        maxzoom: 0,
        tile_size: 0,
        bounds: [-180.0, -83.0, 180.0, 83.0],
        dem: None,
        derived_from: &[],
        viewer: None,
        default: false,
    },
];

/// NASADEM。NASA のデータはパブリックドメイン (Planetary Computer の Collection の license も
/// public domain)。出典は求められていないが、どこのものかは示す。
const NASADEM: Attribution = Attribution {
    text: "NASADEM (NASA / JPL / USGS)",
    url: "https://www.earthdata.nasa.gov/data/catalog/lpcloud-nasadem-hgt-001",
    license: "other",
    provider: "NASA",
    terms: Terms {
        name: "パブリックドメイン (NASA のデータ利用方針)",
        url: "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance",
        commercial: Commercial::Allowed,
        attribution_required: false,
        note_modification: false,
        share_alike: false,
    },
};

/// ASTER GDEM v3。LP DAAC は「再利用・販売・再配布に制限は無い」とし、引用をお願いしている
/// (v2 の頃の再配布の制限と出典の文言の義務は v3 で無くなった)。
const ASTER_GDEM: Attribution = Attribution {
    text: "ASTER GDEM v3 (NASA/METI/AIST/Japan Spacesystems and U.S./Japan ASTER Science Team)",
    url: "https://www.earthdata.nasa.gov/data/catalog/lpcloud-astgtm-003",
    // NASA の STAC (CMR-STAC) の Collection が CC0-1.0 と書いている。
    license: "CC0-1.0",
    provider: "NASA",
    terms: Terms {
        name: "LP DAAC のデータ利用方針 (制限なし。引用のお願い)",
        url: "https://lpdaac.usgs.gov/data/data-citation-and-policies/",
        commercial: Commercial::Allowed,
        attribution_required: false,
        note_modification: false,
        share_alike: false,
    },
};

/// PLATEAU の公式配信の 3D Tiles。**加工せずに指すだけ**なので「もとに作成」と書かない。
/// 条件は PLATEAU のサイトポリシー (PDL1.0 / CC BY 4.0)。配信 API は手続き不要・無償 (試験運用)。
const PLATEAU_TILES: Attribution = Attribution {
    text: "「3D都市モデル（Project PLATEAU）」（国土交通省）",
    url: "https://www.mlit.go.jp/plateau/",
    license: "CC-BY-4.0",
    provider: "国土交通省",
    terms: Terms {
        name: "PLATEAU サイトポリシー (PDL1.0 / CC BY 4.0)",
        url: "https://www.mlit.go.jp/plateau/site-policy/",
        commercial: Commercial::Allowed,
        attribution_required: true,
        note_modification: true,
        share_alike: false,
    },
};

/// 国土数値情報 N03 (行政区域)。ライセンスは CC BY 4.0 だが、配布ページに
/// 「本製品を複製する場合には、国土地理院の長の承認を得なければなりません」とある (docs/data-sources.md)。
const MLIT_KSJ_N03: Attribution = Attribution {
    text: "「国土数値情報（行政区域データ）」（国土交通省）",
    url: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html",
    license: "CC-BY-4.0",
    provider: "国土交通省",
    terms: Terms {
        name: "CC BY 4.0 (複製には測量法に基づく承認が要る)",
        url: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html",
        commercial: Commercial::Allowed,
        attribution_required: true,
        note_modification: true,
        share_alike: false,
    },
};

/// AW3D30。JAXA 第一宇宙技術部門の「研究データ等の利用条件」(2026-10-05 に読んだ)。
/// 改変・第三者への配布を含めて無償で使えるが、**出所表示 (JAXA とデータの名前) が要り**、
/// **商用は事前に JAXA へ連絡が要る**。出所表示は利用条件の例「提供：＊＊＊(JAXA)」に合わせる。
const JAXA_AW3D30: Attribution = Attribution {
    text: "提供：AW3D30 (JAXA)",
    url: "https://www.eorc.jaxa.jp/ALOS/jp/dataset/aw3d30/aw3d30_j.htm",
    license: "other",
    provider: "宇宙航空研究開発機構 (JAXA)",
    terms: Terms {
        name: "JAXA 第一宇宙技術部門 研究データ等の利用条件",
        url: "https://earth.jaxa.jp/ja/data/policy/",
        commercial: Commercial::AllowedWithNotice,
        attribution_required: true,
        note_modification: false,
        share_alike: false,
    },
};

/// 世界 (Web メルカトルで描ける範囲)。
const WORLD_BOUNDS: [f64; 4] = [-180.0, -85.051_128_7, 180.0, 85.051_128_7];

/// 地理院の標高タイル。地理院タイルと同じ規約。
const GSI_DEM_TILES: Attribution = Attribution {
    text: "国土地理院 (標高タイル)",
    url: "https://maps.gsi.go.jp/development/demtile.html",
    license: "other",
    provider: "国土地理院",
    terms: GSI_TERMS,
};

/// 基盤地図情報 (数値標高モデル)。**基本測量成果** — 複製・使用には測量法の承認が要る。
const GSI_DEM_SOURCE: Attribution = Attribution {
    text: "基盤地図情報（数値標高モデル）国土地理院",
    url: "https://service.gsi.go.jp/kiban/",
    license: "other",
    provider: "国土地理院",
    terms: Terms {
        name: "測量法に基づく承認 (複製・使用) が必要",
        url: "https://www.gsi.go.jp/LAW/2930-index.html",
        commercial: Commercial::NotRestricted,
        attribution_required: true,
        note_modification: true,
        share_alike: false,
    },
};

/// Re:Earth Terrain。中身は Mapterhorn (CC BY 4.0) と EGM2008 (NGA、パブリックドメイン)。
/// 出典は TileJSON の `attribution` の書き方に合わせる。
const REEARTH_TERRAIN: Attribution = Attribution {
    text: "Re:Earth Terrain / Mapterhorn / EGM2008 (NGA)",
    url: "https://terrain.reearth.land/",
    license: "other",
    provider: "Re:Earth",
    terms: Terms {
        name: "Re:Earth Terrain の出典 (Mapterhorn は CC BY 4.0、EGM2008 はパブリックドメイン)",
        url: "https://github.com/reearth/reearth-terrain#data-sources",
        commercial: Commercial::NotRestricted,
        attribution_required: true,
        note_modification: false,
        share_alike: false,
    },
};

/// Re:Earth Buildings。Overture (ODbL) から作った **Produced Work** — 表示には出典が要るが、
/// 継承 (share-alike) は Produced Work には及ばない (README の説明)。
const REEARTH_BUILDINGS: Attribution = Attribution {
    text: "Re:Earth Buildings — Buildings © OpenStreetMap contributors, Overture Maps Foundation (ODbL) · \
           Terrain by Re:Earth Terrain (Mapterhorn / EGM2008)",
    url: "https://buildings.reearth.land/",
    license: "ODbL-1.0",
    provider: "Re:Earth",
    terms: Terms {
        name: "ODbL 1.0 (Produced Work。表示には出典が要る)",
        url: "https://github.com/reearth/reearth-buildings#license--required-attribution",
        commercial: Commercial::Allowed,
        attribution_required: true,
        note_modification: false,
        share_alike: false,
    },
};

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
