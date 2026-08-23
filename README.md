# duck-geocoder

日本の地理空間データをGeoParquetに変換し、DuckDB-WASMからブラウザ上で直接クエリするための実験プロジェクト。

サーバーを持たない。静的ホスティング (Cloudflare R2など) にGeoParquetを置くだけで、
全国の行政区域に対する逆ジオコーディングが数MBの転送で動く。
ジオコーディングAPIと違って返すものが決まっていないので、隣接自治体や範囲内集計のような
任意の空間クエリを足していける。

- **[pipeline/](pipeline)**: 元データを読み、WGS84のGeoParquetに変換するRust CLI。
- **[web/](web)**: 変換したGeoParquetをDuckDB-WASM + MapLibreで検索・表示するWebアプリ。
- **data/**: 元データと変換後のGeoParquet (git管理外)。

## データの出所

| データ | 出所 | ライセンス |
| --- | --- | --- |
| 行政区域 | [Overture Maps](https://docs.overturemaps.org/) (divisions) | ODbL 1.0 |
| 建物 | Overture Maps (buildings) | ODbL 1.0 |
| 大字・町丁目、街区 | [位置参照情報](https://nlftp.mlit.go.jp/isj/) (国土交通省) | PDL1.0 |
| 地図タイル | [国土地理院](https://maps.gsi.go.jp/development/ichiran.html) | — |

行政区域については[国土数値情報 (N03)](https://nlftp.mlit.go.jp/ksj/) の方が正確だが、
配布データに測量法に基づく複製承認 (`R 7JHf 351`) が付いており、
再配布には国土地理院への承認申請が要る。申請が下りるまではOvertureを使う。
変換自体は `n03_to_geoparquet` で今も行える (出力する列はOverture版と揃えてある)。

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

Overture Mapsは後述の切り出しコマンドで取得できる。国土交通省のデータは以下の通り。

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

# 建物 (bboxで範囲指定)
cargo run --release --bin extract_overture -- buildings \
  ../data/output/overture_buildings_minato.parquet 139.73 35.63 139.78 35.68

# 行政区域 (日本全体)
cargo run --release --bin extract_overture -- divisions \
  ../data/overture/divisions_jp.parquet
```

ブラウザのDuckDB-WASMは `httpfs` 拡張を持たず `s3://` を直接読めないため、
この切り出しは手元で行う必要がある。

**S3へのアクセスは最小限にすること。** Overtureは `bbox` covering列を持っているので、
そこで絞ればrow group単位で読み飛ばせる (日本全体のdivisionsで約30秒)。
国名や属性だけで絞ると、この読み飛ばしが効かず何倍も時間がかかる。

行政区域は、切り出したものを手元で整形して使う。S3には触らないので、
粒度の取り方を変えたくなったら何度でもやり直せる。

```sh
cargo run --release --bin overture_divisions_to_geoparquet -- \
  ../data/overture/divisions_jp.parquet ../data/output/overture_admin_jp.parquet
```

Overtureの `locality` は市区町村(1,741)に郡(370)とOSM由来の雑多な地名を加えたもので、
郡が混ざると1点が市区町村と郡の両方にヒットして逆ジオコーディングが壊れる。
市・町・村・区で終わるものだけを採ると、ちょうど1,741件で市区町村の総数と一致する。

出力ファイル名が `overture_admin` / `overture_buildings` で始まっていれば、
カタログがそれぞれ行政区域・建物として認識する。

## 配信用の最適化

変換した直後のGeoParquetは、元データの並び順のまま全行が1つのrow groupに入っている。
Parquetの統計はrow group単位なので、これでは「日本全国」という統計が1つあるだけになり、
1点を調べるだけでもジオメトリ列を丸ごと読むことになる。

そこで、行を空間的に並べ替え (STRパッキング)、row groupに分割して書き直す。

```sh
cd pipeline
cargo run --release --bin optimize_geoparquet -- \
  ../data/output/overture_admin_jp.parquet ../data/output/overture_admin_jp.parquet
```

入力と同じパスを指定すれば上書きできる (一時ファイル経由で書くので、途中で落ちても元は壊れない)。
row groupの行数は、1行あたりのバイト数から自動で決める。1行の重さはデータセットによって
3桁ほど違う (行政区域のポリゴンは約43KB/行、位置参照情報の点は約40バイト/行) ので、
行数で固定するとどれかが必ず不適切になる。第3引数で明示することもできる。

中身は変えない。行数・列構成・`geo` メタデータはそのまま引き継ぎ、並び順とrow groupの区切り、
それと圧縮 (変換直後は無圧縮なのでZSTD) だけを変える。

1点を逆ジオコーディングしたときに、ブラウザが実際に転送した量:

| 行政区域データ | 転送量 |
| --- | ---: |
| 最適化前 (1 row group) | ファイルのほぼ全体 |
| Overture 全国 (34 row groups / 64.1MB) | **2.2 MB** |
| 国土数値情報 全国 (125 row groups / 203MB) | **7.9 MB** |

ブラウザ側でこれが成立するには、DuckDB-WASMに `forceFullHTTPReads: false` を明示し、
配信側がRangeリクエストを正しく扱う必要がある。どちらも欠けると警告なしに全件取得へ戻る
(Viteの開発サーバーは既定でRangeの扱いに穴があるため `web/vite.config.ts` で補っている)。
経緯は [docs/duckdb-wasm-range-requests.md](docs/duckdb-wasm-range-requests.md)。
転送量は `web/tests/demo.spec.ts` のE2Eで見張っている。

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

先に変換とカタログ生成を済ませておくこと。開発サーバーが `data/output/` を `/data/` として、
DuckDB-WASM本体 (`node_modules/@duckdb/duckdb-wasm/dist/`) を `/duckdb/` として配信する
([web/vite.config.ts](web/vite.config.ts))。どちらもビルド成果物には含めない。

読み込むデータセットは `catalog.json` から決まるので、UI側にファイル名は書かれていない。
地図に出る出典表示もカタログの `source` から組み立てるので、配信するデータと必ず一致する。

### E2Eテスト

```sh
cd web
pnpm exec playwright install chromium   # 初回のみ
pnpm test
```

検索・ハイライト・逆ジオコーディングをブラウザ上で通しで検証する。
開発サーバーは Playwright が自動で起動する。
Rust側の統合テストと同様、`data/output/` が無い環境ではスキップされる。

## デプロイ

アプリとデータを別々の場所に置く。

| | 置き場所 | 理由 |
| --- | --- | --- |
| アプリ (約1.2MB) | GitHub Pages | — |
| DuckDB-WASM本体 (約77MB) | GitHub Pages | アプリと同一オリジンから配る。1ファイル35〜40MBあるので、1ファイル25MiB制限のあるホスティングには置けない |
| GeoParquet (約88MB) | Cloudflare R2 | 容量の天井が無く、egressが無料。N03やPLATEAUを足しても困らない |

WASMはgitに入れない。ビルド時に `node_modules` から `dist/duckdb/` へコピーされる
([web/vite.config.ts](web/vite.config.ts) の `bundle-duckdb-runtime`)。
アプリのバンドルと同じ `node_modules` を見るので、`pnpm update` してもバージョンがずれない。

### R2にデータを置く

`data/output/` の中身 (catalog.json と *.parquet) をアップロードし、CORSを設定する。

```
Access-Control-Allow-Origin: https://<user>.github.io
Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges
```

`Expose-Headers` が無いとDuckDB-WASMがファイルサイズを取得できず、部分取得に失敗して
黙って全件取得に落ちる。

置いたら、**Rangeが正しく扱われることを確かめてから先に進むこと**。
開発サーバーが `Range: bytes=0-0` を誤って処理していて嵌った箇所
(詳細は [docs/duckdb-wasm-range-requests.md](docs/duckdb-wasm-range-requests.md))。

```sh
URL=https://<r2>/overture_admin_jp.parquet
curl -sI "$URL" | grep -i accept-ranges                                          # bytes
curl -s -D- -o /dev/null -H 'Range: bytes=0-0' "$URL" | grep -iE 'content-(range|length)'
                                                    # 206 / bytes 0-0/… / 1
curl -s -o /tmp/c.bin -H 'Range: bytes=100-199' "$URL" && stat -c%s /tmp/c.bin   # 100
curl -sI -H 'Origin: https://<user>.github.io' "$URL" | grep -i access-control
```

### GitHub Pages にアプリを載せる

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) が `main` への push で動く。
リポジトリの設定で以下を用意する。

- **Settings → Pages → Source**: GitHub Actions
- **Settings → Secrets and variables → Actions → Variables**: `DATA_BASE_URL` にR2の公開URL

手元で確認する場合:

```sh
cd web
VITE_BASE_PATH=/duck-geocoder/ VITE_DATA_BASE_URL=https://<r2> pnpm build
```

### 公開後の確認

公開URLに対してE2Eを流し、転送量を実測する。ローカルで通っても本番のヘッダ設定で
壊れうる箇所なので、必ず確かめる。

```sh
cd web
PLAYWRIGHT_BASE_URL=https://<user>.github.io/duck-geocoder/ pnpm test
```

## ライセンス・出典

このリポジトリの**コード**は [MIT License](LICENSE)。**データは別のライセンスに従う。**

### 配信しているデータ

行政区域と建物はOverture Mapsから切り出したもので、**ODbL 1.0の派生データベースにあたる**。
ODbLは派生データベースを公に利用する場合に同一ライセンスでの提供を求めるため、
ここで配信しているGeoParquet (`overture_admin_jp.parquet`、`overture_buildings_minato.parquet`) も
**ODbL 1.0で提供する**。出典表示だけでは要件を満たさない。

- 行政区域・建物: Overture Maps (ODbL 1.0) © OpenStreetMap contributors
- 位置参照情報: 『位置参照情報』（国土交通省）を加工して作成 (PDL1.0)
- 地図タイル: [国土地理院](https://maps.gsi.go.jp/development/ichiran.html)

### 使う場合に注意が要るもの

- 国土数値情報: 『国土数値情報（行政区域データ）』（国土交通省）を加工して作成 (CC BY 4.0)。
  ただし配布データに測量法に基づく複製承認 (`R 7JHf 351`) が付いており、
  再配布には国土地理院への承認申請が要る。このため現在は配信していない
