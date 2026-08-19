# duck-geocoder

国土交通省が公開している[国土数値情報](https://nlftp.mlit.go.jp/ksj/)と[位置参照情報](https://nlftp.mlit.go.jp/isj/)を
Rustで加工してGeoParquetに変換し、DuckDB-WASMからブラウザ上で直接ジオコーディングするための実験プロジェクト。

サーバーを持たず、静的ホスティング (Cloudflare R2など) にGeoParquetを置くだけで動かすことを想定している。

- **[pipeline/](pipeline)**: ダウンロード済みのzipを読み、WGS84のGeoParquetに変換するRust CLI。
- **[web/](web)**: 変換したGeoParquetをDuckDB-WASM + MapLibreで検索・表示するWebアプリ。
- **data/**: 手動ダウンロードした元データと、変換後のGeoParquet (git管理外)。

## 必要なもの

ツールチェーンは [mise](https://mise.jdx.dev/) で管理している (`mise.toml` を参照)。

```sh
mise install
```

加えて、`proj` クレートがPROJをソースからビルドするため、以下のシステムパッケージが必要
(ディストリビューション同梱のlibprojはバージョンが古く使えないことが多い)。

```sh
sudo apt install -y build-essential cmake sqlite3 libsqlite3-dev
```

## データの入手

**データは手動でダウンロードすること。** 公式のAPIが提供されていないため、
配布ページのURLを推測してスクリプトで取得するようなことはしない。

ダウンロードしたzipはリネームせず、そのまま以下に配置する (`data/` はgit管理外)。

| データ | 入手先 | 配置先 |
| --- | --- | --- |
| 行政区域 (N03) | [行政区域データ](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html) | `data/ksj/N03/` |
| 位置参照情報 (大字・町丁目レベル) | [ダウンロードサービス](https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_choose_method.cgi) | `data/isj/oaza/` |
| 位置参照情報 (街区レベル) | 同上 | `data/isj/block/` |

配置例:

```
data/
├── ksj/N03/
│   ├── N03-20260101_GML.zip        # 全国
│   └── N03-20260101_14_GML.zip     # 神奈川県
├── isj/oaza/
│   ├── 13000-19.0b.zip             # 東京都
│   └── 14000-19.0b.zip             # 神奈川県
└── isj/block/
    ├── 13000-24.0a.zip
    └── 14000-24.0a.zip
```

## GeoParquetへの変換

```sh
cd pipeline

# 行政区域 (全国)
cargo run --release --bin n03_to_geoparquet -- \
  ../data/ksj/N03/N03-20260101_GML.zip ../data/output/n03_all.parquet

# 位置参照情報 (大字・町丁目レベル)
cargo run --release --bin isj_oaza_to_geoparquet -- \
  ../data/isj/oaza/13000-19.0b.zip ../data/output/isj_oaza_13.parquet

# 位置参照情報 (街区レベル)
cargo run --release --bin isj_block_to_geoparquet -- \
  ../data/isj/block/13000-24.0a.zip ../data/output/isj_block_13.parquet
```

座標系は元データのメタデータ (GeoJSONの `crs` / 位置参照情報のメタデータXML) から実行時に読み取り、
PROJでWGS84 (EPSG:4326) に変換して書き出す。ハードコードはしていない。

## Overture Maps の取り込み

[Overture Maps](https://docs.overturemaps.org/) は最初からGeoParquetで配布されているので、
変換は不要で、必要な範囲を切り出すだけでよい。

```sh
cd pipeline
cargo run --release --bin extract_overture -- \
  ../data/output/overture_buildings_minato.parquet 139.73 35.63 139.78 35.68
```

S3上の全件をスキャンするため、範囲が狭くても数分かかる。
ブラウザのDuckDB-WASMは `httpfs` 拡張を持たず `s3://` を直接読めないため、
この切り出しは手元で行う必要がある。

出力ファイル名が `overture_buildings` で始まっていれば、カタログが建物データとして認識する。

## 配信用の最適化

変換した直後のGeoParquetは、元データの並び順のまま全行が1つのrow groupに入っている。
Parquetの統計はrow group単位なので、これでは「日本全国」という統計が1つあるだけになり、
1点を調べるだけでもジオメトリ列を丸ごと読むことになる。

そこで、行を空間的に並べ替え (STRパッキング)、row groupに分割して書き直す。

```sh
cd pipeline
cargo run --release --bin optimize_geoparquet -- \
  ../data/output/n03_all.parquet ../data/output/n03_all.parquet
```

入力と同じパスを指定すれば上書きできる (一時ファイル経由で書くので、途中で落ちても元は壊れない)。
row groupの行数は、1行あたりのバイト数から自動で決める
(行政区域のポリゴンは約2KB/行、位置参照情報の点は約40バイト/行と桁が違うため)。
第3引数で明示することもできる。

中身は変えない。行数・列構成・`geo` メタデータはそのまま引き継ぎ、並び順とrow groupの区切り、
それと圧縮 (変換直後は無圧縮なのでZSTD) だけを変える。

全国の行政区域で、1点を逆ジオコーディングするときに読む必要があるgeometryの量:

| | 変換直後 | 最適化後 |
| --- | ---: | ---: |
| 東京駅 | 243.0 MB | 19.5 MB |
| 大阪市 | 243.0 MB | 4.3 MB |
| 那覇市 | 243.0 MB | 1.4 MB |
| 稚内市 | 243.0 MB | 2.5 MB |

> **既知の問題**: DuckDB-WASM (1.33.1-dev57.0) は `registerFileURL` で登録したHTTPファイルに
> Rangeリクエストを出さず、開いた時点でファイル全体をダウンロードする。
> そのため上の効果はまだブラウザまで届いていない。調査記録は
> [docs/duckdb-wasm-range-requests.md](docs/duckdb-wasm-range-requests.md)。

## カタログの生成

変換したGeoParquetを走査して、カタログJSONを作る。

```sh
cd pipeline
cargo run --release --bin build_catalog -- ../data/output ../data/output/catalog.json
```

件数・収録範囲 (bbox)・列構成は実際のParquetメタデータから読むので、中身とずれない。
Webデモはこれを読んで、どのデータセットを使うかを決める
(変換するファイルを増やせば、UIのコードを変えなくても追随する)。

## テスト

```sh
cd pipeline
cargo test
```

`tests/real_data.rs` は `data/` 配下の実ファイルを使う統合テスト。
ファイルが無い環境ではスキップされるので、失敗はしない。

## Webデモ

```sh
cd web
pnpm install
pnpm dev
```

`public/data` は `data/output/` へのシンボリックリンクなので、先に変換とカタログ生成を済ませておくこと。
読み込むデータセットは `catalog.json` から決まるので、UI側にファイル名は書かれていない。

### E2Eテスト

```sh
cd web
pnpm exec playwright install chromium   # 初回のみ
pnpm test
```

検索・ハイライト・逆ジオコーディングをブラウザ上で通しで検証する。
開発サーバーは Playwright が自動で起動する。
Rust側の統合テストと同様、`data/output/` が無い環境ではスキップされる。

## ライセンス・出典

- 国土数値情報、位置参照情報: 国土交通省 (利用にあたっては各データの利用約款を確認すること)
- 地図タイル: [国土地理院](https://maps.gsi.go.jp/development/ichiran.html)
