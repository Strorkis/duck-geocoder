# duck-geocoder

国土交通省が公開している[国土数値情報](https://nlftp.mlit.go.jp/ksj/)と[位置参照情報](https://nlftp.mlit.go.jp/isj/)を
Rustで加工してGeoParquetに変換し、DuckDB-WASMからブラウザ上で直接ジオコーディングするための実験プロジェクト。

サーバーを持たず、静的ホスティング (Cloudflare R2など) にGeoParquetを置くだけで動かすことを想定している。

- **本体 (リポジトリ直下)**: ダウンロード済みのzipを読み、WGS84のGeoParquetに変換するRust CLI。
- **[examples/web-demo](examples/web-demo)**: 変換したGeoParquetをDuckDB-WASM + MapLibreで検索・表示するデモ。

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
# 行政区域 (全国)
cargo run --release --bin n03_to_geoparquet -- \
  data/ksj/N03/N03-20260101_GML.zip data/output/n03_all.parquet

# 位置参照情報 (大字・町丁目レベル)
cargo run --release --bin isj_oaza_to_geoparquet -- \
  data/isj/oaza/13000-19.0b.zip data/output/isj_oaza_13.parquet

# 位置参照情報 (街区レベル)
cargo run --release --bin isj_block_to_geoparquet -- \
  data/isj/block/13000-24.0a.zip data/output/isj_block_13.parquet
```

座標系は元データのメタデータ (GeoJSONの `crs` / 位置参照情報のメタデータXML) から実行時に読み取り、
PROJでWGS84 (EPSG:4326) に変換して書き出す。ハードコードはしていない。

## カタログの生成

変換したGeoParquetを走査して、カタログJSONを作る。

```sh
cargo run --release --bin build_catalog -- data/output data/output/catalog.json
```

件数・収録範囲 (bbox)・列構成は実際のParquetメタデータから読むので、中身とずれない。
Webデモはこれを読んで、どのデータセットを使うかを決める
(変換するファイルを増やせば、UIのコードを変えなくても追随する)。

## テスト

```sh
cargo test
```

`tests/real_data.rs` は `data/` 配下の実ファイルを使う統合テスト。
ファイルが無い環境ではスキップされるので、失敗はしない。

## Webデモ

```sh
cd examples/web-demo
pnpm install
pnpm dev
```

`public/data` は `data/output/` へのシンボリックリンクなので、先に変換を済ませておくこと。
読み込むファイルは `src/main.ts` の先頭でハードコードしている。

### E2Eテスト

```sh
cd examples/web-demo
pnpm exec playwright install chromium   # 初回のみ
pnpm test
```

検索・ハイライト・逆ジオコーディングをブラウザ上で通しで検証する。
開発サーバーは Playwright が自動で起動する。
Rust側の統合テストと同様、`data/output/` が無い環境ではスキップされる。

## ライセンス・出典

- 国土数値情報、位置参照情報: 国土交通省 (利用にあたっては各データの利用約款を確認すること)
- 地図タイル: [国土地理院](https://maps.gsi.go.jp/development/ichiran.html)
