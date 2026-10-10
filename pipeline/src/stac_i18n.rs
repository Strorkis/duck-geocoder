//! カタログの**英語版**と、アプリが起動時に読む**まとめ**を作る。
//!
//! ## 英語版
//!
//! STAC の [Language extension](https://github.com/stac-extensions/language) の形にする。
//! 日本語の文書 (`plateau/plateau-buildings.json`) の隣に英語の文書 (`…/plateau-buildings.en.json`)
//! を置き、互いを `rel: "alternate"` + `hreflang` で結ぶ。英語の文書の中のリンク (root・親・子・自分) は
//! 英語の文書を指すので、英語の文書だけで辿れる。STAC Browser は画面の言語を変えるとこのリンクを
//! 辿って文書を切り替える。
//!
//! **訳すのは題名・説明・名前 (`title` / `description` / `name`) と `duck:vintage` だけ。**
//! 出典の文言 (`duck:attribution`) は規約が書き方を指定しているので訳さない。データの語彙
//! (`summaries`) も訳さない (データの中身なので)。
//!
//! **訳は日本語の文字列で引く** ([`EN`])。日本語の文言を直したのに訳を直し忘れると、
//! 訳の無い日本語が残るので**エラーにする** (英語の文書に日本語が混ざらない)。
//!
//! ## まとめ (アプリ用)
//!
//! アプリは起動時に Collection を全部読む。文書ごとに辿るとカタログ → サブカタログ (10) →
//! Collection (32) の3段・43回になるので、**言語ごとに1つの JSON にまとめたもの** を置く
//! (`collections.json` / `collections.en.json`)。形は STAC API の `/collections` の応答に
//! 合わせ、サブカタログは `duck:catalogs` に入れる。文書ごとの JSON は STAC として残す
//! (STAC Browser やほかの道具はこちらを読む)。
use crate::stac::Document;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const LANGUAGE_EXTENSION: &str = "https://stac-extensions.github.io/language/v1.1.0/schema.json";
/// まとめの置き場所 (配信の起点からのパス)。
pub const BUNDLE_FILE: &str = "collections.json";
/// まとめの英語版。
pub const BUNDLE_FILE_EN: &str = "collections.en.json";

/// 英語の文書へ向けて書き換えるリンク (このカタログの文書どうしを結ぶもの)。
const DOCUMENT_RELS: &[&str] = &[
    "root",
    "parent",
    "child",
    "self",
    "collection",
    "derived_from",
    "duck:collections",
];

/// 日本語 → 英語。**題名・説明・名前のすべて**。足りなければ [`localize`] がエラーにする。
const EN: &[(&str, &str)] = &[
    // ---- サブカタログ・ルート ----
    ("duck-geocoder のデータ", "duck-geocoder data"),
    (
        "日本のオープンな地理空間データを GeoParquet にしたものです。ブラウザから DuckDB-WASM で直接読めます。各 Collection の使う条件の要約 (duck:terms) は、このカタログが独自に規約を読んでまとめた参考情報で、正確さは保証しません。使う前に、必ず各配布元の規約の本文を確かめてください。",
        "Open geospatial data of Japan converted to GeoParquet, readable directly in the browser with DuckDB-WASM. The summary of the terms of use for each Collection (duck:terms) is reference information that this catalog compiled by reading the terms itself, and its accuracy is not guaranteed. Always check the full text of each publisher's terms before use.",
    ),
    (
        "全 Collection を1つにまとめたもの (アプリが起動時に読みます)",
        "All Collections in one document (read by the app at startup)",
    ),
    (
        "Item の一覧 (stac-geoparquet。全 Collection 分をまとめたもの)",
        "Item list (stac-geoparquet, covering all Collections)",
    ),
    (
        "引いた表示のための建物のベクタタイル (重要な段だけ)",
        "Vector tiles of buildings for zoomed-out views (important tiers only)",
    ),
    (
        "国土交通省が整備している3D都市モデルです。",
        "3D city models maintained by the Ministry of Land, Infrastructure, Transport and Tourism (MLIT).",
    ),
    (
        "Overture Maps Foundation が公開している地図データです。OpenStreetMap など、複数の出所をまとめたものです。",
        "Map data published by the Overture Maps Foundation, combining several sources such as OpenStreetMap.",
    ),
    (
        "国土交通省が整備している国土数値情報です。",
        "National Land Numerical Information maintained by MLIT.",
    ),
    (
        "総務省統計局の国勢調査を、地域メッシュごとに集計したものです。",
        "The national census by the Statistics Bureau of Japan, aggregated by grid square.",
    ),
    (
        "国土交通省の位置参照情報です。住所の代表点を持っています。",
        "Location reference information by MLIT, holding representative points of addresses.",
    ),
    (
        "国土地理院が公開している地図タイル・ベクトルタイル・標高タイルです。このカタログでは複製せず、公開元の配信をそのまま使っています。",
        "Map tiles, vector tiles and elevation tiles published by the Geospatial Information Authority of Japan (GSI). This catalog does not copy them and uses the publisher's service directly.",
    ),
    (
        "世界の標高タイルです。このカタログでは複製せず、公開元の配信をそのまま使っています。",
        "Elevation tiles of the world. This catalog does not copy them and uses the publisher's service directly.",
    ),
    (
        "Re:Earth が公開している標高タイルと 3D の建物 (3D Tiles) です。このカタログでは複製せず、公開元の配信をそのまま使っています。",
        "Elevation tiles and 3D buildings (3D Tiles) published by Re:Earth. This catalog does not copy them and uses the publisher's service directly.",
    ),
    (
        "宇宙航空研究開発機構 (JAXA) の衛星データです。このカタログでは複製せず、公開元 (JAXA Earth API) への案内だけを載せています。",
        "Satellite data from the Japan Aerospace Exploration Agency (JAXA). This catalog does not copy it and only points to the publisher (JAXA Earth API).",
    ),
    (
        "米国航空宇宙局 (NASA) の衛星データです。このカタログでは複製せず、公開元への案内だけを載せています。",
        "Satellite data from NASA. This catalog does not copy it and only points to the publisher.",
    ),
    ("PLATEAU", "PLATEAU"),
    ("国土数値情報", "National Land Numerical Information"),
    ("国勢調査", "Census"),
    ("位置参照情報", "Location Reference Information"),
    (
        "国土地理院",
        "GSI (Geospatial Information Authority of Japan)",
    ),
    // ---- GeoParquet の Collection ----
    ("行政区域の名称", "Municipality names"),
    (
        "市区町村の名前の一覧です。地名の検索に使っています。",
        "A list of municipality names, used for place search.",
    ),
    ("行政区域", "Municipalities"),
    (
        "市区町村の境界です。地図で指した場所の市区町村を調べるのに使っています。",
        "Municipal boundaries, used to find the municipality at a point on the map.",
    ),
    ("鉄道駅", "Railway stations"),
    (
        "鉄道の駅です。ホームの範囲を線で表しています。",
        "Railway stations, drawn as lines along the platforms.",
    ),
    ("鉄道路線", "Railway lines"),
    (
        "鉄道の路線です。路線名・事業者・鉄道の種類を持っています。",
        "Railway lines with line names, operators and railway types.",
    ),
    ("建物", "Buildings"),
    (
        "建物の形です。高さや種別が入っていないものが多くあります。",
        "Building footprints. Many lack height and type.",
    ),
    (
        "建物の形です。高さ・用途・階数が、ほぼすべての建物に入っています。",
        "Building footprints. Almost all have height, usage and number of floors.",
    ),
    ("道路の路線", "Road routes"),
    (
        "道路の路線名 (「国道13号」など) の一覧です。路線名での検索に使っています。",
        "A list of road route names (such as 国道13号, National Route 13), used for route search.",
    ),
    ("道路", "Roads"),
    (
        "高速道路・国道・都道府県道です。路線名を持っています。",
        "Expressways, national roads and prefectural roads, with route names.",
    ),
    ("送電線", "Power lines"),
    (
        "送電線と、地中・海底の電力線です。線の名前を持つものもあります。",
        "Power lines and underground or submarine cables. Some have names.",
    ),
    ("川", "Rivers"),
    (
        "川と運河の流れの線です。元は OpenStreetMap で、国のデータではありません。",
        "Flow lines of rivers and canals. They come from OpenStreetMap, not from national data.",
    ),
    ("建物の整備範囲", "Building coverage"),
    (
        "PLATEAU の建物がある場所を、1km四方のメッシュで示したものです。",
        "Where PLATEAU buildings exist, shown as 1 km grid squares.",
    ),
    ("人口メッシュ (1km)", "Population mesh (1 km)"),
    (
        "令和2年国勢調査の人口と世帯数を、1km四方のメッシュで集計したものです。人口密度は、中にある125mメッシュの最大値です。",
        "Population and households from the 2020 census, aggregated into 1 km grid squares. The density is the maximum of the 125 m squares inside.",
    ),
    ("人口メッシュ", "Population mesh"),
    (
        "令和2年国勢調査の人口と世帯数を、125m四方のメッシュで集計したものです。",
        "Population and households from the 2020 census, aggregated into 125 m grid squares.",
    ),
    ("大字・町丁目", "Towns and chōme"),
    (
        "町名・丁目の代表点です。住所の検索に使っています。",
        "Representative points of towns and chōme, used for address search.",
    ),
    ("街区", "Blocks"),
    (
        "街区 (「〜番」) の代表点です。いまは検索には使っていません。",
        "Representative points of blocks (ban). Not used for search at the moment.",
    ),
    // 建物の重要度の段
    ("公共施設", "Public facilities"),
    ("商業・業務", "Commercial and business"),
    ("住宅・その他", "Residential and other"),
    // ---- 外部の配信物 ----
    ("最適化ベクトルタイル", "Optimized vector tiles"),
    (
        "国土地理院の地図をベクトルタイルにしたものです (試験公開)。重ねて見るためのもので、検索や周辺検索には使いません。形は表示のために簡略化されています。",
        "GSI's map as vector tiles (experimental release). For viewing as an overlay; not used for search or nearby search. Shapes are simplified for display.",
    ),
    ("2026-07-01 時点", "as of 2026-07-01"),
    ("注記", "Labels"),
    ("鉄道", "Railways"),
    ("境界", "Boundaries"),
    ("構造物", "Structures"),
    ("地形", "Terrain"),
    ("水部", "Water"),
    ("建築物", "Buildings"),
    ("道路中心線", "Road centerlines"),
    ("道路縁", "Road edges"),
    ("道路構成線", "Road structure lines"),
    ("鉄道中心線", "Railway centerlines"),
    ("軌道の中心線", "Track centerlines"),
    ("水域", "Water areas"),
    ("水涯線", "Shorelines"),
    ("河川中心線", "River centerlines"),
    ("海岸線", "Coastlines"),
    ("水部表記線", "Water symbol lines"),
    ("水部構造物面", "Water structure areas"),
    ("水部構造物線", "Water structure lines"),
    ("等高線", "Contour lines"),
    ("等深線", "Depth contours"),
    ("地形表記面", "Terrain symbol areas"),
    ("地形表記線", "Terrain symbol lines"),
    ("行政区画", "Administrative areas"),
    ("行政区画界線", "Administrative boundary lines"),
    ("特定地区界", "Special district boundaries"),
    ("構造物面", "Structure areas"),
    ("構造物線", "Structure lines"),
    ("淡色地図", "Pale map"),
    (
        "地理院タイルの淡色地図です。色が抑えてあり、重ねたデータが読みやすくなります。",
        "GSI's pale map tiles. The muted colors make overlaid data easy to read.",
    ),
    ("標準地図", "Standard map"),
    ("地理院タイルの標準地図です。", "GSI's standard map tiles."),
    ("航空写真", "Aerial photos"),
    (
        "地理院タイルの全国最新写真 (シームレス) です。地形と合わせると起伏がよく分かります。",
        "GSI's latest nationwide seamless aerial photos. Combined with terrain, the relief is easy to see.",
    ),
    ("白地図", "Blank map"),
    (
        "地理院タイルの白地図です。文字が無いので、重ねたデータや注記が読みやすくなります。ズーム5〜14です。",
        "GSI's blank map tiles. With no text, overlaid data and labels are easy to read. Zoom 5–14.",
    ),
    ("色別標高図", "Color-coded elevation map"),
    (
        "地理院タイルの色別標高図です。標高を色の段で塗り分けていて、低い土地や台地の広がりが一目で分かります。ズーム5〜15です。",
        "GSI's color-coded elevation map tiles. Elevation is shaded in color bands, so lowlands and plateaus stand out at a glance. Zoom 5–15.",
    ),
    ("陰影起伏図", "Hillshade map"),
    (
        "地理院タイルの陰影起伏図です。光を当てたときの影で起伏を表しています。ズーム2〜16です。",
        "GSI's hillshade map tiles, showing relief with shading. Zoom 2–16.",
    ),
    ("Mapterhorn 標高", "Mapterhorn elevation"),
    (
        "世界の標高タイルです。日本の部分は基盤地図情報 (数値標高モデル、1m・5m・10m) から作られています。地図を立体にするためのもので、検索や周辺検索には使いません。",
        "Elevation tiles of the world. The Japanese part is made from GSI's Fundamental Geospatial Data (digital elevation models, 1 m, 5 m and 10 m). For making the map 3D; not used for search or nearby search.",
    ),
    (
        "Terrarium (高さ = R×256 + G + B/256 − 32768 m) で、海面からの高さです。ズーム16まであります (TileJSON には最大ズームが書かれていません)。",
        "Terrarium (height = R×256 + G + B/256 − 32768 m), height above sea level. Up to zoom 16 (the TileJSON does not state the maximum zoom).",
    ),
    ("Re:Earth Terrain 標高", "Re:Earth Terrain elevation"),
    (
        "Mapterhorn の標高を配り直したものです。海面からの高さ (elevation) と、EGM2008 のジオイドを足した WGS84 楕円体からの高さ (ellipsoid) を選べます。ここでは MapLibre に合う海面からの高さを使っています。3D の地球儀 (Cesium) と合わせるときは、楕円体高の版を使ってください。",
        "A redistribution of Mapterhorn's elevation. You can choose height above sea level (elevation) or height above the WGS84 ellipsoid with the EGM2008 geoid added (ellipsoid). This app uses height above sea level, which suits MapLibre. Use the ellipsoidal version with a 3D globe (Cesium).",
    ),
    (
        "Terrarium (高さ = R×256 + G + B/256 − 32768 m) で、海面からの高さです。同じ形で、楕円体高 (/terrarium/ellipsoid/) と Terrain-RGB (/mapbox/) の版もあります。ズーム14までです。",
        "Terrarium (height = R×256 + G + B/256 − 32768 m), height above sea level. The same tiles also exist as ellipsoidal height (/terrarium/ellipsoid/) and Terrain-RGB (/mapbox/). Up to zoom 14.",
    ),
    ("標高タイル", "Elevation tiles"),
    (
        "地理院タイルの標高タイルです (基盤地図情報 数値標高モデルから作られたもの)。独自の形式なので、地形に使うときはブラウザで Terrarium に詰め直しています。ズーム14 (10mメッシュ) までです。より細かい 5m (ズーム15) と 1m (ズーム17) は別のタイルです。",
        "GSI's elevation tiles (made from the Fundamental Geospatial Data digital elevation model). They use GSI's own format, so the browser repacks them into Terrarium when used as terrain. Up to zoom 14 (10 m mesh). The finer 5 m (zoom 15) and 1 m (zoom 17) data are separate tiles.",
    ),
    (
        "x = R×2¹⁶ + G×2⁸ + B として、x < 2²³ なら 高さ = x × 0.01 m、x = 2²³ (128,0,0) は値なし (海など)、x > 2²³ なら 高さ = (x − 2²⁴) × 0.01 m (負の値) です。線形の部分は Terrain-RGB と同じ形ですが、値なしと負の値はそのままでは読めません。z15 は dem5a_png (5m)、z17 は dem1a_png (1m) です。",
        "With x = R×2¹⁶ + G×2⁸ + B: if x < 2²³, height = x × 0.01 m; x = 2²³ (128,0,0) means no data (e.g. sea); if x > 2²³, height = (x − 2²⁴) × 0.01 m (negative). The linear part matches Terrain-RGB, but no-data and negative values cannot be read as is. z15 is dem5a_png (5 m) and z17 is dem1a_png (1 m).",
    ),
    (
        "基盤地図情報 数値標高モデル (元データ)",
        "Fundamental Geospatial Data digital elevation model (source data)",
    ),
    (
        "地理院の標高タイルと、Mapterhorn の日本の部分の元データです (1m・5m・10m のメッシュ)。基本測量成果なので、複製・使用には測量法に基づく承認が必要です (Mapterhorn は取得しています)。このカタログからは配っていません。",
        "The source data of GSI's elevation tiles and of the Japanese part of Mapterhorn (1 m, 5 m and 10 m meshes). As a result of basic surveys, copying or using it requires approval under the Survey Act (Mapterhorn has obtained it). Not distributed by this catalog.",
    ),
    (
        "Re:Earth Buildings (3D Tiles)",
        "Re:Earth Buildings (3D Tiles)",
    ),
    (
        "Overture の建物から作られた 3D Tiles 1.1 (glTF) です。Cesium 向けで、この地図 (MapLibre) では描けないので、公式のビューアで見られます。高さは WGS84 楕円体からです (地盤の高さはRe:Earth Terrain の楕円体高で焼き込まれています)。海面からの高さの地形と重ねると、日本では40m前後浮きます。",
        "3D Tiles 1.1 (glTF) made from Overture buildings. Made for Cesium; this map (MapLibre) cannot draw them, so view them in the official viewer. Heights are from the WGS84 ellipsoid (ground heights are baked in from Re:Earth Terrain's ellipsoidal heights). Over terrain based on sea level, they float about 40 m in Japan.",
    ),
    (
        "建物 (3D Tiles・公式配信)",
        "Buildings (3D Tiles, official distribution)",
    ),
    (
        "PLATEAU 配信サービスが配っている建物の 3D Tiles です。全国の都市を1つの tileset.json に束ねたもので、都市ごとに LOD2 までの細かいものを採り、テクスチャがあればテクスチャ付きになります。この地図 (MapLibre) では描けないので、公式のビューア (PLATEAU VIEW) で見られます。配信サービスは試験運用で、提供期間や品質は保証されていません。",
        "Building 3D Tiles from the PLATEAU distribution service, with all cities bundled into one tileset.json. Each city uses its most detailed data up to LOD2, textured where available. This map (MapLibre) cannot draw them, so view them in the official viewer (PLATEAU VIEW). The service is a trial and its availability and quality are not guaranteed.",
    ),
    (
        "行政区域 N03 (元データ)",
        "Administrative areas N03 (source data)",
    ),
    (
        "国土数値情報の行政区域です。市区町村の境界の国のデータです。基本測量成果をもとにしているので、複製には測量法に基づく承認が必要です (配布ページに記載があります)。承認を得るまでは配らず、行政区域には Overture のものを使っています。",
        "Administrative areas from the National Land Numerical Information: national data on municipal boundaries. Being based on basic survey results, copying it requires approval under the Survey Act (stated on the distribution page). Until approval is obtained it is not distributed, and Overture's administrative areas are used instead.",
    ),
    (
        "AW3D30 (全球の数値表層モデル)",
        "AW3D30 (global digital surface model)",
    ),
    (
        "ALOS の光学ステレオ (PRISM) から作られた、全球の DSM (数値表層モデル) です。約30m (1秒)、版は 4.1 (2024年4月) です。地面ではなく建物や木の上の高さを測っているので、建物も森も無いところでは地面の高さの参考になります(地理院の標高 (DTM) との差で、地面より上にあるものの高さも概算できます)。日本の外も覆っています。公開元の JAXA Earth API が 1°×1° の COG と STAC で配っていて、登録なしでブラウザから直接読めます(Range・CORS に対応)。このカタログからは配っていません。",
        "A global DSM (digital surface model) made from ALOS optical stereo (PRISM). About 30 m (1 arcsecond), version 4.1 (April 2024). It measures the top of buildings and trees rather than the ground, so where there are no buildings or forests it serves as a reference for ground height (the difference from GSI's elevation (DTM) also gives a rough height of what stands above the ground). It covers areas outside Japan too. The publisher, JAXA Earth API, distributes it as 1°×1° COGs with STAC, readable directly in the browser without registration (Range and CORS supported). Not distributed by this catalog.",
    ),
    (
        "NASADEM (全球の数値表層モデル)",
        "NASADEM (global digital surface model)",
    ),
    (
        "2000年のスペースシャトルのレーダー観測 (SRTM) を作り直した DSM です。約30m (1秒)、北緯60°〜南緯56°で、パブリックドメインです。実体 (COG) は Microsoft Planetary Computer の STAC から取れますが、読むには匿名で取れる期限付きのトークンが必要です。このカタログからは配っていません。",
        "A DSM reprocessed from the Space Shuttle radar survey (SRTM) of 2000. About 30 m (1 arcsecond), 60°N to 56°S, in the public domain. The data (COGs) are available from Microsoft Planetary Computer's STAC, but reading them needs a time-limited token obtainable anonymously. Not distributed by this catalog.",
    ),
    (
        "ASTER GDEM v3 (全球の数値表層モデル)",
        "ASTER GDEM v3 (global digital surface model)",
    ),
    (
        "経済産業省と NASA の衛星センサ ASTER の光学ステレオから作られた DSM (2019年) です。約30m (1秒)、北緯83°〜南緯83°で、再利用・再配布に制限はありません。実体 (COG) は NASA Earthdata にあり、取るにはログインが必要です。このカタログからは配っていません。",
        "A DSM (2019) made from optical stereo of ASTER, a satellite sensor of Japan's METI and NASA. About 30 m (1 arcsecond), 83°N to 83°S, with no restrictions on reuse or redistribution. The data (COGs) are on NASA Earthdata and require a login. Not distributed by this catalog.",
    ),
    // ---- リンクの題名 ----
    ("配布元", "Original source"),
    ("公式のビューア", "Official viewer"),
    ("公開元の STAC (COG)", "Publisher's STAC (COG)"),
    // ---- 使う条件の名前・提供者 ----
    ("国土地理院コンテンツ利用規約", "GSI Content Terms of Use"),
    (
        "公共データ利用規約 (第1.0版)",
        "Public Data License (version 1.0)",
    ),
    (
        "政府標準利用規約 (第2.0版)",
        "Government of Japan Standard Terms of Use (version 2.0)",
    ),
    (
        "PLATEAU サイトポリシー (PDL1.0 / CC BY 4.0)",
        "PLATEAU site policy (PDL 1.0 / CC BY 4.0)",
    ),
    (
        "位置参照情報ダウンロードサービス利用規約 (精度の要る測量・証明には使えません)",
        "Location Reference Information download service terms (not for surveys or certifications requiring precision)",
    ),
    (
        "CC BY 4.0 (複製には測量法に基づく承認が必要です)",
        "CC BY 4.0 (copying requires approval under the Survey Act)",
    ),
    (
        "測量法に基づく承認 (複製・使用) が必要です",
        "Approval under the Survey Act (copying and use) is required",
    ),
    (
        "Mapterhorn の出典 (ソースごとのライセンス。日本は国土地理院コンテンツ利用規約)",
        "Mapterhorn attribution (licenses vary by source; Japan is under the GSI Content Terms of Use)",
    ),
    (
        "Re:Earth Terrain の出典 (Mapterhorn は CC BY 4.0、EGM2008 はパブリックドメイン)",
        "Re:Earth Terrain attribution (Mapterhorn is CC BY 4.0, EGM2008 is public domain)",
    ),
    (
        "ODbL 1.0 (Produced Work。表示には出典が必要です)",
        "ODbL 1.0 (Produced Work; display requires attribution)",
    ),
    (
        "JAXA 第一宇宙技術部門 研究データ等の利用条件",
        "JAXA Space Technology Directorate I terms of use for research data",
    ),
    (
        "パブリックドメイン (NASA のデータ利用方針)",
        "Public domain (NASA data use policy)",
    ),
    (
        "LP DAAC のデータ利用方針 (制限なし。引用をお願いされています)",
        "LP DAAC data policy (no restrictions; citation requested)",
    ),
    (
        "国土交通省",
        "Ministry of Land, Infrastructure, Transport and Tourism (MLIT)",
    ),
    ("総務省統計局", "Statistics Bureau of Japan"),
    (
        "宇宙航空研究開発機構 (JAXA)",
        "Japan Aerospace Exploration Agency (JAXA)",
    ),
];

/// 漢字・かな・カタカナを含むか (訳さずに残っていないかを見る)。
fn has_japanese(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(c, '\u{3040}'..='\u{30ff}' | '\u{4e00}'..='\u{9fff}' | '\u{3400}'..='\u{4dbf}')
    })
}

/// `x.json` → `x.en.json`。
pub fn en_path(path: &str) -> String {
    match path.strip_suffix(".json") {
        Some(stem) => format!("{stem}.en.json"),
        None => path.to_string(),
    }
}

/// 題名・説明・名前を英語にする。**訳の無い日本語が残ったらエラー**。
fn translate(value: &mut Value, table: &BTreeMap<&str, &str>, at: &str) -> Result<()> {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                // 出典の文言は規約が書き方を指定しているので訳さない。語彙はデータの中身。
                if key == "duck:attribution" || key == "summaries" {
                    continue;
                }
                let translatable = matches!(
                    key.as_str(),
                    "title" | "description" | "name" | "duck:vintage"
                );
                match child {
                    Value::String(text) if translatable && has_japanese(text) => {
                        let Some(english) = table.get(text.as_str()) else {
                            bail!(
                                "{at}: 英語の訳がありません (stac_i18n.rs の EN に足すこと): {text}"
                            );
                        };
                        *text = (*english).to_string();
                    }
                    _ => translate(child, table, at)?,
                }
            }
        }
        Value::Array(items) => {
            for child in items {
                translate(child, table, at)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// このカタログの文書どうしを結ぶリンクを、英語の文書へ向ける。
fn link_to_english(body: &mut Value) {
    let Some(links) = body["links"].as_array_mut() else {
        return;
    };
    for link in links {
        let rel = link["rel"].as_str().unwrap_or_default();
        let href = link["href"].as_str().unwrap_or_default();
        let relative = !href.contains("://");
        if DOCUMENT_RELS.contains(&rel) && relative && href.ends_with(".json") {
            link["href"] = json!(en_path(href));
        }
    }
}

/// 言語の項目 (Language extension) と、もう一方の言語の文書へのリンクを足す。
fn mark_language(body: &mut Value, own_path: &str, english: bool) {
    // Language extension の `name` はその言語で書いた名前、`alternate` は英語での名前。
    let japanese = json!({ "code": "ja", "name": "日本語", "alternate": "Japanese" });
    let english_language = json!({ "code": "en", "name": "English" });
    // もう一方の言語の文書は同じディレクトリにあるので、ファイル名だけで指す。
    let other_path = if english {
        own_path.replace(".en.json", ".json")
    } else {
        en_path(own_path)
    };
    let other_href = other_path
        .rsplit('/')
        .next()
        .unwrap_or(&other_path)
        .to_string();
    let (own, other, other_code, other_title) = if english {
        (english_language, japanese, "ja", "日本語")
    } else {
        (japanese, english_language, "en", "English")
    };
    body["language"] = own;
    body["languages"] = json!([other]);
    let mut extensions = body["stac_extensions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if !extensions.iter().any(|e| e == LANGUAGE_EXTENSION) {
        extensions.push(json!(LANGUAGE_EXTENSION));
    }
    body["stac_extensions"] = json!(extensions);
    if let Some(links) = body["links"].as_array_mut() {
        links.push(json!({
            "rel": "alternate",
            "href": other_href,
            "type": "application/json",
            "hreflang": other_code,
            "title": other_title,
        }));
    }
}

/// 日本語の文書一式から、英語版とまとめを足した一式を作る。
pub fn localize(japanese: Vec<Document>) -> Result<Vec<Document>> {
    let table: BTreeMap<&str, &str> = EN.iter().copied().collect();
    if table.len() != EN.len() {
        bail!("EN に同じ日本語が2回あります");
    }
    let mut english = Vec::with_capacity(japanese.len());
    for document in &japanese {
        let mut body = document.body.clone();
        translate(&mut body, &table, &document.path)?;
        link_to_english(&mut body);
        let path = en_path(&document.path);
        mark_language(&mut body, &path, true);
        english.push(Document { path, body });
    }
    let mut japanese = japanese;
    for document in &mut japanese {
        mark_language(&mut document.body, &document.path, false);
    }

    let ja_bundle = bundle(&japanese, "catalog.json", BUNDLE_FILE)?;
    let en_bundle = bundle(&english, &en_path("catalog.json"), BUNDLE_FILE_EN)?;
    let mut all = japanese;
    all.extend(english);
    all.push(ja_bundle);
    all.push(en_bundle);
    Ok(all)
}

/// `base` (文書のパス) からの相対の `href` を、起点からのパスにする。
fn resolve(href: &str, base: &str) -> String {
    let mut parts: Vec<&str> = base.split('/').collect();
    parts.pop();
    for segment in href.split('/') {
        match segment {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// アプリが起動時に読むまとめ。ルートから子を辿った順に、サブカタログと Collection を並べる。
/// **文書はそのまま入れ、置き場所を `duck:path` に添える** (中のリンクはその文書からの相対のまま)。
fn bundle(documents: &[Document], root: &str, path: &str) -> Result<Document> {
    let by_path: BTreeMap<&str, &Value> = documents
        .iter()
        .map(|d| (d.path.as_str(), &d.body))
        .collect();
    let mut catalogs = Vec::new();
    let mut collections = Vec::new();
    let mut stack = vec![root.to_string()];
    let mut seen = std::collections::BTreeSet::new();
    while let Some(current) = stack.pop() {
        if !seen.insert(current.clone()) {
            continue;
        }
        let body = by_path
            .get(current.as_str())
            .with_context(|| format!("{current} がありません"))?;
        let mut entry = (*body).clone();
        entry["duck:path"] = json!(current);
        match body["type"].as_str() {
            Some("Collection") => collections.push(entry),
            _ => {
                if current != root {
                    catalogs.push(entry);
                }
                let children: Vec<String> = body["links"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|link| link["rel"] == "child")
                    .filter_map(|link| link["href"].as_str())
                    .map(|href| resolve(href, &current))
                    .collect();
                // 後から積んだものが先に出るので、逆順に積んで子の並びを保つ。
                stack.extend(children.into_iter().rev());
            }
        }
    }
    Ok(Document {
        path: path.to_string(),
        body: json!({
            "stac_version": "1.1.0",
            "collections": collections,
            "duck:catalogs": catalogs,
            "links": [
                { "rel": "root", "href": root, "type": "application/json" },
                { "rel": "self", "href": path, "type": "application/json" },
            ],
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(path: &str, body: Value) -> Document {
        Document {
            path: path.to_string(),
            body,
        }
    }

    fn sample() -> Vec<Document> {
        vec![
            document(
                "catalog.json",
                json!({ "type": "Catalog", "stac_extensions": [], "id": "root", "title": "duck-geocoder のデータ", "links": [
                    { "rel": "self", "href": "catalog.json" },
                    { "rel": "child", "href": "gsi/catalog.json", "title": "国土地理院" },
                ]}),
            ),
            document(
                "gsi/catalog.json",
                json!({ "type": "Catalog", "id": "gsi", "title": "国土地理院", "links": [
                    { "rel": "root", "href": "../catalog.json" },
                    { "rel": "child", "href": "gsi-pale.json", "title": "淡色地図" },
                    { "rel": "child", "href": "gsi-std.json", "title": "標準地図" },
                ]}),
            ),
            document(
                "gsi/gsi-pale.json",
                json!({ "type": "Collection", "id": "gsi-pale", "title": "淡色地図",
                    "duck:attribution": "国土地理院", "links": [
                        { "rel": "root", "href": "../catalog.json" },
                        { "rel": "via", "href": "https://maps.gsi.go.jp/", "title": "配布元" },
                ]}),
            ),
            document(
                "gsi/gsi-std.json",
                json!({ "type": "Collection", "id": "gsi-std", "title": "標準地図", "links": [] }),
            ),
        ]
    }

    #[test]
    fn english_documents_link_to_english_and_back() {
        let all = localize(sample()).unwrap();
        let find = |path: &str| &all.iter().find(|d| d.path == path).unwrap().body;
        let pale = find("gsi/gsi-pale.en.json");
        assert_eq!(pale["title"], "Pale map");
        // 出典の文言は訳さない (規約が書き方を指定している)。
        assert_eq!(pale["duck:attribution"], "国土地理院");
        assert_eq!(pale["links"][0]["href"], "../catalog.en.json");
        // 外へのリンクはそのまま、題名だけ訳す。
        assert_eq!(pale["links"][1]["href"], "https://maps.gsi.go.jp/");
        assert_eq!(pale["links"][1]["title"], "Original source");
        assert_eq!(pale["language"]["code"], "en");
        let back = pale["links"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["rel"] == "alternate")
            .unwrap();
        assert_eq!(back["href"], "gsi-pale.json");
        assert_eq!(back["hreflang"], "ja");
        // 日本語の文書からも英語へ結ぶ。
        let ja = find("gsi/gsi-pale.json");
        assert_eq!(ja["language"]["code"], "ja");
        let forward = ja["links"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["rel"] == "alternate")
            .unwrap();
        assert_eq!(forward["href"], "gsi-pale.en.json");
    }

    #[test]
    fn missing_translation_is_an_error() {
        let mut documents = sample();
        documents[3].body["description"] = json!("訳の無い説明");
        let message = localize(documents).err().unwrap().to_string();
        assert!(message.contains("訳の無い説明"), "{message}");
    }

    #[test]
    fn bundles_keep_the_catalog_order_and_paths() {
        let all = localize(sample()).unwrap();
        let bundle = &all.iter().find(|d| d.path == BUNDLE_FILE).unwrap().body;
        let ids: Vec<&str> = bundle["collections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["gsi-pale", "gsi-std"]);
        assert_eq!(bundle["collections"][0]["duck:path"], "gsi/gsi-pale.json");
        assert_eq!(bundle["duck:catalogs"][0]["duck:path"], "gsi/catalog.json");
        let english = &all.iter().find(|d| d.path == BUNDLE_FILE_EN).unwrap().body;
        assert_eq!(
            english["collections"][0]["duck:path"],
            "gsi/gsi-pale.en.json"
        );
        assert_eq!(english["collections"][0]["title"], "Pale map");
    }

    #[test]
    fn resolves_relative_hrefs() {
        assert_eq!(
            resolve("gsi/catalog.json", "catalog.json"),
            "gsi/catalog.json"
        );
        assert_eq!(
            resolve("gsi-pale.json", "gsi/catalog.json"),
            "gsi/gsi-pale.json"
        );
        assert_eq!(
            resolve("../catalog.json", "gsi/gsi-pale.json"),
            "catalog.json"
        );
    }
}
