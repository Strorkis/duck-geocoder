# duck-geocoder

日本の地理空間データをGeoParquetに変換し、DuckDB-WASMからブラウザ上で直接クエリする実験プロジェクト。

**デモ: https://strorkis.github.io/duck-geocoder/**

サーバーを持たない。静的ホスティングにGeoParquetを置くだけで、全国の行政区域に対する
逆ジオコーディングが **2.2MB の転送**で動く (ファイルは64MB)。
ジオコーディングAPIと違って返すものが決まっていないので、隣接自治体や範囲内集計のような
任意の空間クエリを足していける。

- **[pipeline/](pipeline)** — 元データをWGS84のGeoParquetに変換するRust CLI
- **[web/](web)** — DuckDB-WASM + MapLibreで検索・表示するWebアプリ
- **data/** — 元データと変換後のGeoParquet (git管理外)

## ドキュメント

| | |
| --- | --- |
| [docs/pipeline.md](docs/pipeline.md) | データの入手から、配信できるGeoParquetを作るまで |
| [docs/deploy.md](docs/deploy.md) | 開発・テスト・デプロイ |
| [docs/duckdb-wasm-range-requests.md](docs/duckdb-wasm-range-requests.md) | ブラウザに部分取得させるまでの調査記録 |
| [AGENTS.md](AGENTS.md) | このリポジトリで作業するときの約束事 |

## データの出所

| データ | 出所 | ライセンス |
| --- | --- | --- |
| 行政区域 | Overture Maps [divisions](https://docs.overturemaps.org/guides/divisions/) | ODbL 1.0 |
| 建物 | Overture Maps [buildings](https://docs.overturemaps.org/guides/buildings/) | ODbL 1.0 |
| 大字・町丁目、街区 | [位置参照情報](https://nlftp.mlit.go.jp/isj/) (国土交通省) | PDL1.0 |
| 地図タイル | [国土地理院](https://maps.gsi.go.jp/development/ichiran.html) | — |

行政区域は[国土数値情報 (N03)](https://nlftp.mlit.go.jp/ksj/) の方が正確だが、配布データに
測量法に基づく複製承認 (`R 7JHf 351`) が付いており、再配布には国土地理院への承認申請が要る。
申請が下りるまではOvertureを使う。変換自体は `n03_to_geoparquet` で今も行える
(出力する列はOverture版と揃えてあるので、差し替えるだけで済む)。

## ライセンス・出典

このリポジトリの**コード**は [MIT License](LICENSE)。**データは別のライセンスに従う。**

行政区域と建物はOverture Mapsから切り出したもので、**ODbL 1.0の派生データベースにあたる**。
ODbLは派生データベースを公に利用する場合に同一ライセンスでの提供を求めるため、
ここで配信しているGeoParquet (`overture_admin_jp.parquet`、`overture_buildings_minato.parquet`) も
**ODbL 1.0で提供する**。出典表示だけでは要件を満たさない。

- 行政区域・建物: Overture Maps / © OpenStreetMap contributors (ODbL 1.0)
- 位置参照情報:「位置参照情報ダウンロードサービス」（国土交通省）をもとに作成
- 地図タイル: [国土地理院](https://maps.gsi.go.jp/development/ichiran.html)
- 国土数値情報 (使う場合):「国土数値情報（行政区域データ）」（国土交通省）をもとに作成
