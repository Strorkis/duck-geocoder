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
