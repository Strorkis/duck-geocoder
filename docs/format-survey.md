# GeoParquet 以外の形式・手法の調査 (2026-10-10)

[geoparquet-layout.md](geoparquet-layout.md) で、GeoParquet + DuckDB-WASM が苦手な問い合わせが2つ見えた。

1. **引いた表示を描く** — 概観ファイルで直したが、「1つの出所 = 1つのファイル」が崩れた
2. **行グループより細かい範囲** (細長い沿線など) — 都心の行グループは約2km四方で、それより細かく絞れない

これらに別の形式・手法が効くかを調べた。**ここに書いたのは公開資料とソースを読んだ結果で、
自分のデータではまだ測っていない** (「測ったこと」の節だけが実測)。

---

## 結論 (いまの見立て)

| 苦手なこと | 効きそうな手 | 理由 |
| --- | --- | --- |
| 引いた表示を描く | **MLT / PMTiles (ベクタタイル)** | 描くための簡略化・間引きはタイルの本業。概観の役目をタイルに任せれば、GeoParquet は「調べる」用途で1ファイルのまま保てる |
| 細かい範囲の取り出し | **FlatGeobuf** (地物ごとの索引) か、**ページインデックスを使える読み手** | DuckDB はページインデックスを使わない (下)。FlatGeobuf は索引で地物単位の範囲を出せる |
| 格子のデータ (標高・人口・気象) | **GeoZarr** (将来) | 格子・時間軸が本業。ベクタは対象外 |
| 重い空間の問い合わせ (結合など) | SedonaDB は**ブラウザ向きではない** | 公式はブラウザに対応していない。コミュニティの WASM 版はファイルを先に丸ごと取る |

**GeoParquet は「調べる・配る」の本線のまま**、描く用途 (タイル) と細かい取り出し (FlatGeobuf) を
2本目の経路として足すのが筋に見える。Portolan も「ベクタは GeoParquet + PMTiles」と、配る形と描く形を分けている。

---

## 1. ページインデックス (GeoParquet のままで細かく絞る道)

**GeoParquet 1.1 の bbox 列 (いま使っている形) には、ページごとの最小・最大 (ページインデックス) を
付けられる。** 使える読み手なら、行グループの中のページを読み飛ばせる。

- GeoParquet の配り方の指針 (`distributing-geoparquet.md`) は、ページ単位の絞り込みを bbox 列を残す
  理由の1つに挙げている。Overture の建物約1,000万行で、選択的な交差の問い合わせが約93ms → 約48ms
- GeoParquet 2.0 (Parquet の GEOMETRY 型) の統計は**行グループ単位だけ**で、ページ単位が無い。
  そのため 2.0 でも bbox 列を任意で残すことになった
- **DuckDB はページインデックスを使わない。** DuckDB の Parquet 拡張のソース (main、2026-10-10) に
  ページインデックスを読む箇所 (`column_index_offset`・`OffsetIndex`・`PageLocation`) が無い。
  他のプロジェクトのテストでも、DuckDB はページの最小・最大で絞らなかったという報告がある
- DataFusion (SedonaDB の土台) や arrow-rs はページインデックスで絞れる

→ **いまの読み手 (DuckDB-WASM) のままでは、この道は使えない。** 読み手を変えるなら意味がある
(下の SedonaDB の節)。

### 指針との比較

指針は行グループを **5万〜15万行 (大きさなら 128〜256MB)** と勧め、「画面に描く用途は小さいほうが
有利」と添えている。ファイルを分けるのは**全体が約2GBを超えてから**。

ここの行グループは**約1MB** で、指針よりずっと小さい。r2.dev の往復の重さ (1回 ≒ 0.9MB) に
合わせた結果で、指針が想定する分析 (大きく読む) とは用途が違う。PLATEAU の都市ごとの分割は、
1都市が数MB〜数十MB なので「2GB を超えたら分ける」より細かい。カタログの bbox でファイルごと
飛ばすためで、ここも用途の違い。**この差は COGP や指針に返せる情報になる。**

---

## 2. MLT (MapLibre Tiles)

- 2026-01-23 に 1.0。MVT の後継で、**列指向**。大きなタイルで最大6倍の圧縮、デコードが速い
- MapLibre GL JS 5.12.0 から、スタイルの `encoding: "mlt"` で読める
- 1.0 は安定。3D 座標・入れ子の型 (リスト・マップ) は v2 の予定。入れ子は Overture (GeoParquet)
  のようなデータのために計画されている
- 作る道具: freestiler (Rust、R と Python)、参照実装 (Java / C++)。Martin (タイルサーバー) は
  GeoParquet を DuckDB で読めるが、MLT への変換はまだできない

**ここでの位置付け:** 描く用途の2本目の経路。概観 (都道府県ごとの複製) の代わりに、引いた表示を
タイルで描けば、GeoParquet 側は1ファイルのまま保てる。ただし**タイルを作る工程が増え**、
タイルは「調べる」(件数・属性での絞り込み・保存) には使えない。

---

## 3. PMTiles

- タイル (MVT、将来は MLT も) を1ファイルにまとめ、Range で読む。既に地理院の最適化ベクトルタイル
  (16.9GB) を参照していて、**ヘッダとメタデータの6.6KBだけを読んでカタログに載せた** (pipeline.md)
- 1ファイルで、開くのは1回 (ヘッダ)。タイルの位置は索引から引く

**ここでの位置付け:** MLT と組み合わせる入れ物。「1つの出所 = 1つのファイル」を描く側でも保てる。

---

## 4. FlatGeobuf

- 1ファイル。ヘッダ → **packed Hilbert R-tree (地物ごとの索引)** → 地物 (Hilbert 曲線の順)
- HTTP で範囲を取るときは、ヘッダ → 索引 → 当たった地物の範囲、の順に Range で読む。
  ある例 (市区町村 449MB) では、索引 1.5MB を1回で読み、近い範囲をまとめて読んでいる
- **地物単位で範囲を出せる** ので、行グループ (約2km四方) より細かく取れる
- 弱み: 列指向ではない (属性だけ・形だけを読めない)、圧縮が無い (gzip を配信側で掛けると Range と相性が悪い)。
  圧縮付きの派生 (geomedea) もある。npm の `flatgeobuf` には、索引の最後の葉の扱いに不具合があるという報告がある

**ここでの位置付け:** 細かい範囲の取り出しの2本目の経路の候補。ただし**索引の大きさ** (地物数に比例。
都心の区で数十〜数百KB?) と、開く往復 (ヘッダ・索引・地物で最低3回) が R2 でどう効くかは測らないと分からない。

---

## 5. GeoZarr

- 多次元の格子 (ラスタ・データキューブ) のための Zarr の決まりごと。OGC 標準を目指している
  (2026 年に V1 の候補、OGC の審査へ)
- **ベクタは対象外。** ベクタのデータキューブに使えるかという問いが 2026-04 に issue として
  上がったところ。Zarr にジオメトリを入れる場合は CF の決まりごとで WKB を入れる方法がある
- 実装: GDAL・rioxarray・OpenLayers・TiTiler など

**ここでの位置付け:** 建物や線には使わない。**標高・人口メッシュ・時間で変わる格子** (動的データの
構想。`.reference/dynamic-data-handoff.md`) で候補になる。いまの人口メッシュは GeoParquet の
ポリゴンで配っているが、格子として配るなら GeoZarr のほうが素直かもしれない。

---

## 6. SedonaDB

- Apache Sedona の単体で動く空間 SQL エンジン (2025-09 に公開)。Rust・Arrow・DataFusion。
  0.4.0 (2026-06) で Parquet の GEOMETRY 型の書き込み・地理型・GPU の空間結合など
- 公式は Python・R。**ブラウザ (WASM) の公式版は無い**
- コミュニティの WASM 版 **CereusDB** がある (Apache-2.0、gzip で 6.5〜13.2MB)。ただし
  **リモートの Parquet は先に丸ごと取る** (「pre-fetch」)。Range で一部だけ読む形ではない。
  空間結合は1区画・メモリ内だけ。まだ初期段階 (リリース無し)

**ここでの位置付け:** いまの用途 (Range で一部だけ読む) には合わない。DataFusion はページ
インデックスを使えるので、**ブラウザで Range 読みができる DataFusion 系の読み手**が育てば、
GeoParquet のまま細かく絞る道が開ける。追いかける価値はある。

---

## 測ったこと: 引いた表示を PMTiles で描く (2026-10-10)

概観と同じ建物 (PLATEAU の段0〜1、247万棟) から PMTiles を作り、アプリの地図に層として足して測った
(アプリのコードは一時的に変えて戻した)。R2 相当の待ち (`DATA_LATENCY_MS=450 DATA_BANDWIDTH_MBPS=16`)。

```bash
# FlatGeobuf を経由して tippecanoe へ (lod は数として読ませる)
duckdb -c "LOAD spatial; COPY (SELECT lod::INTEGER AS lod, name, usage, height, geometry
  FROM read_parquet('plateau_bldg_overview_all.parquet')) TO 'plateau_overview.fgb'
  WITH (FORMAT GDAL, DRIVER 'FlatGeobuf', SRS 'EPSG:4326');"
tippecanoe -q -o plateau_overview.pmtiles -Z12 -z14 -l buildings -T lod:int \
  -j '{"*":["any",["==","lod",0],[">=","$zoom",13]]}' --no-feature-limit --no-tile-size-limit plateau_overview.fgb
```

| | GeoParquet の概観 (いま) | PMTiles |
| --- | --- | --- |
| 大きさ | 327MB (45ファイル) | **123MB (1ファイル)** |
| 東京駅 z13 | 39秒・9.0MB・39回 | **10.0秒**・1.3MB・8回 |
| 東京駅 z14.5 | 36秒・11.7MB・29回 | **3.4秒**・0.4MB・6回 |
| 東京タワー z13.5 | — | **7.1秒**・1.1MB・6回 |

- **3〜10倍速い。** MapLibre はタイルを並列に取り (DuckDB は1回ずつ順に)、タイルは描く用に簡略化されて量が少ない
- 手元の preview は HTTP/1.1 (同時接続6本まで)。R2 は HTTP/2 なので、タイルにはもう少し有利に出るはず
- 作るのは約1分 (tippecanoe、z12〜14)。経由した FlatGeobuf は **788MB** (GeoParquet の2.4倍。圧縮が無いため)
- **「1つの出所 = 1つのファイル」に戻せる。** 元の GeoParquet は都市ごとのまま (上の「どこまで分けるか」)、
  引いた表示は PMTiles 1つ。概観の GeoParquet (327MB) は要らなくなり、容量も減る

### 組み込むときの得失

| | いま (GeoParquet の概観) | PMTiles |
| --- | --- | --- |
| 件数の表示 (「公共施設のみ・3,000件以上」) | 出せる | **出せない** (タイルは数えられない)。「公共施設・商業・業務を表示」と言うだけになる |
| 絞り込み (高さ・用途・段) | 問い合わせの条件で | スタイルの filter で (タイルに属性が入っていれば) |
| ホバーの吹き出し | 出せる | 出せる (名前・用途・高さをタイルに入れる) |
| 表示量 (控えめ・標準・多め) | 段の上限を変える | スタイルの filter と minzoom で。タイルに入れる段は作るときに決まる |
| 作る工程 | `build_building_overview` | tippecanoe が増える (いまはパイプラインに無い道具) |
| カタログ | Item に `duck:lod_max` | Collection のアセット (`rel: pmtiles` は地理院で使っている形) |

---

## 乗り換えではなく、足す (フィードバック・fork の候補)

**利用者の方針 (2026-10-10):** 別の形式に乗り換えるより、既存の形式や読み手を改善する案を
**TOBE (目指す姿) として残しておく**。優先はこちら側でできること (データの作り方・読み方・機能の範囲)
をやり切ること。issue へのコメントなど外部への投稿は、そのあと余裕があれば最後に。
以下はその TOBE の候補の書き留めで、クローンを読んだ結果 (`.reference/github.com/` の
opengeospatial/geoparquet・apache/sedona-db・flatgeobuf/flatgeobuf・maplibre/maplibre-tile-spec・
Kanahiro/cloud-optimized-geoparquet)。

| # | 相手 | 何を足すか | ここへの効き | 手間 | 状況 |
| --- | --- | --- | --- | --- | --- |
| 1 | **GeoParquet の指針** (issue #279・「Usage in Frontend Applications」) | **ブラウザ + 遅いオブジェクトストレージでの実測**。往復の重さ (1回 ≒ 0.9MB) から行グループの大きさを決める目安。細長い範囲が行グループの広さに負ける例 | 間接 (議論を前に進める) | **小** (測定は手元にある。書くだけ) | #279 は開いたまま、最後の動きは 2026-02。ベンチマークはどれも手元の NVMe で、**ブラウザ・HTTP の実例は出ていない**。指針は「使いたい人は #279 へ」と呼びかけている |
| 2 | **DuckDB の Parquet 読み取り** | ページインデックス (bbox 列の ColumnIndex) で行グループの中のページを読み飛ばす | **大** (細長い範囲・狭い範囲が速くなる。DuckDB-WASM にそのまま効く) | 大 (C++) | ソースに読む箇所が無い。DuckDB の空間の担当者は #279 で「遅いオブジェクトストレージでは行単位の取り出しが高くつく」と書いている |
| 3 | **DuckDB-WASM の読み方** | 読むと決まった範囲を並列に取る (いまは1回ずつ順に。読み取りの伸ばし方も離れた場所でリセット) | **大** (R2 では回数が支配的) | 中〜大 | 未調査 (duckdb/duckdb-wasm を読む必要) |
| 4 | **COGP** | 段ごとと場所ごとの衝突の実測、ファイルをまたぐ概観、線の段を「足す」形、往復の重さの目安 | 間接 | 小〜中 | 仕様自身が「進んで描く用途と空間検索の両方を測るべき」と書いている |
| 5 | **FlatGeobuf の JS の読み手** | 複数の矩形 (や形) を1回の木の探索で調べる。遅い配信元で索引を何段先読みするか | 中 (細かい取り出しを FlatGeobuf でするなら) | 小 | いまは矩形1つだけ。木は1段ずつ読む (上3段はヘッダと一緒に先読み)。当たった地物は並列に取る。圧縮は形式の外 (seekable zstd、#524) |
| 6 | **SedonaDB** | 空間の条件 (`ST_Intersects`) からページ単位の読み飛ばし | 小 (ブラウザで動かない) | 中 (Rust・DataFusion) | 行グループ単位の空間の読み飛ばしはある (`filter_access_plan_using_geoparquet_covering`)。ページ単位は無い |

**fork は最後の手段にする。** DuckDB や DuckDB-WASM を fork すると追従の手間が大きい。
手を付けるなら、こちら側をやり切ったあとに、数字 (1) や小さな PR (5) のような軽いものから。

### ここ側で先にできる準備: ページを細かく切る

repack は arrow-rs の既定 (ページインデックスあり、ページの上限 1MB) で書いている。行グループが約1MB
なので**1列が1ページに収まり、ページインデックスがあっても読み飛ばすページが無い**
(中央区の行グループ1: 形の列 360KB・bbox の列 30KB が、それぞれ1ページ)。
ページを細かく切る (例: 500行ごと) のは書き出しの設定1つで、DuckDB は列の塊ごと続けて読むので
いまの読み方には影響が小さいはず (未計測)。2 や DataFusion 系の読み手が来たときに、データ側が
すでに整っている状態にできる。

---

## 次に測るなら

| 実験 | 何が分かるか | 必要なもの |
| --- | --- | --- |
| FlatGeobuf で都心の建物を作り、沿線・点・画面の取り出しで回数と量を比べる | 細かい範囲で GeoParquet に勝つか。索引の重さ | DuckDB の spatial (GDAL) で書き出せる。読み手は npm の `flatgeobuf` |
| 引いた表示を PMTiles (MVT / MLT) で描く | 概観を無くせるか。タイルを作る手間と大きさ | tippecanoe か freestiler など |
| 同じ建物を「全国1つ / 都道府県 / 都市」で作って比べる | どこまで分けるか (フッターの重さと開く回数) | いまの道具で作れる |
| bbox 列にページインデックスを付けて書く | DataFusion 系の読み手で効くか (DuckDB では効かない) | arrow-rs の書き込み設定 |

---

## 出典

- [Native Geospatial Types in Apache Parquet](https://parquet.apache.org/blog/2026/02/13/native-geospatial-types-in-apache-parquet/)
- [distributing-geoparquet.md (GeoParquet の配り方の指針)](https://github.com/opengeospatial/geoparquet/blob/main/format-specs/distributing-geoparquet.md)
- [GeoParquet & Parquet Geospatial Types: A Time of Transition](https://cloudnativegeo.org/blog/2025/10/geoparquet-parquet-geospatial-types-a-time-of-transition/)
- [Announcing MapLibre Tile](https://maplibre.org/news/2026-01-23-mlt-release/) / [MapLibre Tile Specification](https://maplibre.org/maplibre-tile-spec/)
- [Martin: GeoParquet Support](http://maplibre.org/roadmap/martin-tile-server/data-geoparquet/)
- [flatgeobuf (npm)](https://www.npmjs.com/package/flatgeobuf) / [gtfs-flatgeobuf (Range で読む例)](https://github.com/sysdevrun/gtfs-flatgeobuf) / [geomedea](https://github.com/michaelkirk/geomedea)
- [geozarr-spec の issue](https://github.com/zarr-developers/geozarr-spec/issues) / [GeoZarr FAQ](https://geozarr.org/faq)
- [Introducing SedonaDB](https://sedona.apache.org/latest/blog/2025/09/24/introducing-sedonadb-a-single-node-analytical-database-engine-with-geospatial-as-a-first-class-citizen/) / [SedonaDB 0.4.0](https://sedona.apache.org/latest/blog/2026/06/19/sedonadb-040-release/) / [CereusDB](https://github.com/tobilg/cereusdb)
- DuckDB の Parquet 拡張のソース (`extension/parquet/`、main ブランチ、2026-10-10 に読んだ)
