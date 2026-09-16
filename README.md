# duck-geocoder

**日本のオープンデータが STAC + GeoParquet で配られたらどうなるか、を試す実験。**

**デモ: https://strorkis.github.io/duck-geocoder/**

形式もライセンスも配布元もばらばらな日本の地理空間データを、GeoParquetに揃えて
[STAC](https://stacspec.org/) のカタログに載せ、**ブラウザから直接クエリして
その場で見られる**ようにしている。サーバーは持たない
(静的ホスティング + オブジェクトストレージ)。

全国の行政区域に対する逆ジオコーディングが **1.5MB の転送**で動く (ファイルは98MB)。
ジオコーディングAPIと違って返すものが決まっていないので、隣接自治体や範囲内集計の
ような任意の空間クエリを足していける。

**正典のカタログを作ろうとしているのではない。** ここにあるのは変換した複製で、
**原典は配布元**。出典とライセンスは配布元のものに従う。

- **[pipeline/](pipeline)** — 元データをWGS84のGeoParquetに変換するRust CLI
- **[web/](web)** — DuckDB-WASM + MapLibreで検索・表示するWebアプリ
- **data/** — 元データと変換後のGeoParquet (git管理外)

用途の例として、人口密度をSORA (ドローンの運航リスク評価) の iGRC 区分で
色分けする機能がある。

## ドキュメント

| | |
| --- | --- |
| [docs/roadmap.md](docs/roadmap.md) | 何を目指していて、何が積み残っているか |
| [docs/data-sources.md](docs/data-sources.md) | データ源の調査。権利面と属性の実測 |
| [docs/pipeline.md](docs/pipeline.md) | データの入手から、配信できるGeoParquetを作るまで |
| [docs/deploy.md](docs/deploy.md) | 開発・テスト・デプロイ |
| [docs/duckdb-wasm-range-requests.md](docs/duckdb-wasm-range-requests.md) | ブラウザに部分取得させるまでの調査記録 |
| [AGENTS.md](AGENTS.md) | このリポジトリで作業するときの約束事 |

## データの出所

**配布元へのリンクを併記する。** 実物が欲しくなったら、そちらから取れる。

| データ | 配布元 | ライセンス |
| --- | --- | --- |
| 行政区域・建物 | Overture Maps [divisions](https://docs.overturemaps.org/guides/divisions/) / [buildings](https://docs.overturemaps.org/guides/buildings/) | ODbL 1.0 |
| 建物 (3D・用途・高さ) | [3D都市モデル Project PLATEAU](https://www.mlit.go.jp/plateau/) (国土交通省) | CC BY 4.0 |
| 人口メッシュ (125m・1km) | [令和2年国勢調査 地域メッシュ統計](https://www.e-stat.go.jp/gis) (総務省統計局) | 政府標準利用規約 第2.0版 |
| 大字・町丁目、街区 | [位置参照情報](https://nlftp.mlit.go.jp/isj/) (国土交通省) | PDL 1.0 |
| 地形 (標高タイル) | [Mapterhorn](https://mapterhorn.com/attribution) (基盤地図情報が原典) | ソースごと |
| 地図タイル | [国土地理院](https://maps.gsi.go.jp/development/ichiran.html) | — |

行政区域は[国土数値情報 (N03)](https://nlftp.mlit.go.jp/ksj/) の方が正確だが、配布データに
測量法に基づく複製承認 (`R 7JHf 351`) が付いており、再配布には国土地理院への承認申請が要る。
申請が下りるまではOvertureを使う。変換自体は `n03_to_geoparquet` で今も行える
(出力する列はOverture版と揃えてあるので、差し替えるだけで済む)。

Overtureの区画は湾を跨いでいて、そのままでは海上の点に自治体が返る。
同じOvertureの海域データ (`base/water` の `subtype='ocean'`) で削っている
([docs/pipeline.md](docs/pipeline.md) の「海域を削る」を参照)。

## ライセンス・出典

このリポジトリの**コード**は [MIT License](LICENSE)。**データは配布元のライセンスに従う。**

**ODbLの同一ライセンス条項が掛かるのはOverture由来のものだけ。**
行政区域と建物 (`overture/*.parquet`) はOverture Mapsから切り出したもので、
**ODbL 1.0の派生データベースにあたる**。ODbLは派生データベースを公に利用する場合に
同一ライセンスでの提供を求めるため、**これらはODbL 1.0で提供する**。
出典表示だけでは要件を満たさない。

PLATEAU・国勢調査・位置参照情報から作ったものには、この条項は掛からない。
それぞれのライセンスと出典表示に従う。

| データ | 出典表示 |
| --- | --- |
| 行政区域・建物 (Overture) | Overture Maps / © OpenStreetMap contributors (ODbL 1.0) |
| 建物 (PLATEAU) | 「3D都市モデル（Project PLATEAU）」（国土交通省）をもとに作成 |
| 人口メッシュ | 「令和2年国勢調査 地域メッシュ統計」（総務省統計局）をもとに作成 |
| 大字・町丁目、街区 | 「位置参照情報ダウンロードサービス」（国土交通省）をもとに作成 |
| 地形 | © Mapterhorn |
| 地図タイル | [国土地理院](https://maps.gsi.go.jp/development/ichiran.html) |
| 国土数値情報 (使う場合) | 「国土数値情報（行政区域データ）」（国土交通省）をもとに作成 |

**この表はカタログから組み立てたものと一致している。** 地図に出る出典表示は
`catalog.json` の `duck:attribution` から作られるので、配信するデータと必ず揃う
([docs/pipeline.md](docs/pipeline.md) の「カタログは STAC 1.1.0」)。
