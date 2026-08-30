# パイプライン

元データを読み、配信できる形のGeoParquetにするまで。すべて `pipeline/` のRust CLI。

## 必要なもの

ツールチェーンは [mise](https://mise.jdx.dev/) で管理している (`mise.toml`)。

```sh
mise install
```

加えて、`proj` クレートがPROJをソースからビルドするため、以下のシステムパッケージが要る
(ディストリビューション同梱のlibprojはバージョンが古く使えないことが多い)。

```sh
sudo apt install -y build-essential cmake sqlite3 libsqlite3-dev
```

## 1. データを手に入れる

Overture Mapsは後述の切り出しコマンドで取れる。国土交通省のデータは手動でダウンロードする。

**配布ページのURLを推測してスクリプトで取得しない。** 公式のAPIが提供されていないため。

ダウンロードしたzipはリネームせず、そのまま置く (`data/` はgit管理外)。

| データ | 入手先 | 配置先 |
| --- | --- | --- |
| 位置参照情報 (大字・町丁目レベル) | [ダウンロードサービス](https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_choose_method.cgi) | `data/isj/oaza/` |
| 位置参照情報 (街区レベル) | 同上 | `data/isj/block/` |
| 行政区域 (N03) ※現在は未配信 | [行政区域データ](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html) | `data/ksj/N03/` |

```
data/
├── isj/oaza/13000-19.0b.zip      # 東京都
├── isj/block/13000-24.0a.zip
└── ksj/N03/N03-20260101_GML.zip  # 全国
```

## 2. GeoParquetに変換する

```sh
cd pipeline

# 位置参照情報
cargo run --release --bin isj_oaza_to_geoparquet -- \
  ../data/isj/oaza/13000-19.0b.zip ../data/output/isj_oaza_13.parquet
cargo run --release --bin isj_block_to_geoparquet -- \
  ../data/isj/block/13000-24.0a.zip ../data/output/isj_block_13.parquet

# 国土数値情報 行政区域 (使う場合)
cargo run --release --bin n03_to_geoparquet -- \
  ../data/ksj/N03/N03-20260101_GML.zip ../data/output/n03_all.parquet
```

座標系は元データのメタデータ (GeoJSONの `crs` / 位置参照情報のメタデータXML) から
実行時に読み取り、PROJでWGS84 (EPSG:4326) に変換する。ハードコードしていない。

GeoParquetの書き出し (WKBへの変換、`covering.bbox` 列、`geo` メタデータ) は
`pipeline/src/geoparquet.rs` が自前で行う。以前は `geoparquet-batch-writer` を使っていたが、
それが固定する `parquet ^56` 経由で `thrift 0.17.0` ([GHSA-2f9f-gq7v-9h6m](https://github.com/advisories/GHSA-2f9f-gq7v-9h6m))
が入り込んでいたため、依存を外して `wkb` crateで直接書く形にした。

## 3. Overture Maps を切り出す

Overtureは最初からGeoParquetなので、変換は不要で必要な範囲を切り出すだけでよい。
ブラウザのDuckDB-WASMは `httpfs` 拡張を持たず `s3://` を読めないため、手元で行う。

```sh
cd pipeline

# 建物 (bboxで範囲指定)
cargo run --release --bin extract_overture -- buildings \
  ../data/output/overture_buildings_minato.parquet 139.73 35.63 139.78 35.68

# 行政区域 (日本全体)
cargo run --release --bin extract_overture -- divisions \
  ../data/overture/divisions_jp.parquet
```

**S3へのアクセスは最小限にすること。** Overtureは `bbox` covering列を持っているので、
そこで絞ればrow group単位で読み飛ばせる (日本全体のdivisionsで約30秒)。
国名や属性だけで絞ると読み飛ばしが効かず、何倍も時間がかかる。

行政区域は、切り出したものを手元で整形して使う。S3には触らないので、
粒度の取り方を変えたくなったら何度でもやり直せる。

```sh
cargo run --release --bin overture_divisions_to_geoparquet -- \
  ../data/overture/divisions_jp.parquet ../data/output/overture_admin_jp.parquet
```

Overtureの `locality` は市区町村(1,741)に郡(370)とOSM由来の雑多な地名を加えたもので、
郡が混ざると1点が市区町村と郡の両方にヒットして逆ジオコーディングが壊れる。
市・町・村・区で終わるものだけを採ると、ちょうど1,741件で市区町村の総数と一致する。

## 4. 配信用に最適化する

変換した直後のGeoParquetは、元データの並び順のまま全行が1つのrow groupに入っている。
Parquetの統計はrow group単位なので、これでは「日本全国」という統計が1つあるだけになり、
1点を調べるだけでもジオメトリ列を丸ごと読むことになる。

行を空間的に並べ替え (STRパッキング)、row groupに分割して書き直す。

```sh
cargo run --release --bin optimize_geoparquet -- \
  ../data/output/overture_admin_jp.parquet ../data/output/overture_admin_jp.parquet
```

入力と同じパスを指定すれば上書きできる (一時ファイル経由で書くので、途中で落ちても元は壊れない)。
row groupの行数は1行あたりのバイト数から自動で決める。1行の重さはデータセットによって
3桁ほど違う (行政区域のポリゴンは約43KB/行、位置参照情報の点は約40バイト/行) ので、
行数で固定するとどれかが必ず不適切になる。第3引数で明示もできる。

中身は変えない。行数・列構成・`geo` メタデータはそのまま引き継ぎ、
並び順とrow groupの区切り、それと圧縮 (変換直後は無圧縮なのでZSTD) だけを変える。

1点を逆ジオコーディングしたときに、ブラウザが実際に転送した量:

| 行政区域データ | 転送量 |
| --- | ---: |
| 最適化前 (1 row group) | ファイルのほぼ全体 |
| Overture 全国 (34 row groups / 64.1MB) | **2.2 MB** |
| 国土数値情報 全国 (125 row groups / 203MB) | **7.9 MB** |

ブラウザ側でこれが成立する条件は [duckdb-wasm-range-requests.md](duckdb-wasm-range-requests.md) を参照。

## 5. 検索用の名称を抜き出す

```sh
cargo run --release --bin build_admin_names -- \
  ../data/output/overture_admin_jp.parquet ../data/output/overture_admin_names_jp.parquet
```

UIは地名検索のために全行政区域の名称を必要とするが、これを行政区域の
GeoParquetから直接引くと**HTTP越しでは極端に遅くなる**。名称の列は合計65KB程度しか
ないのに、64MBのファイル全体に row group の数だけ散らばっているためで、
実測では42回のRangeリクエストと約24秒を要した。転送量ではなく往復回数の問題。

抜き出したファイルは76KB・1 row group で、初期化のリクエストは11回に減る。

ジオメトリを持たないのでGeoParquetではなく素のParquetになる。
ファイル名が `overture_admin_names` / `n03_names` で始まっていれば、
カタログが検索用の名称として認識する
(行政区域そのものより**前**に判定される必要があるので、
`pipeline/src/catalog.rs` の表では長い接頭辞を先に置いている)。

無くてもUIは動くが、その場合は行政区域から都度作るので初期化が遅くなる。

## 6. カタログを作る

```sh
cargo run --release --bin build_catalog -- ../data/output ../data/output/catalog.json
```

件数・収録範囲 (bbox)・列構成は実際のParquetメタデータから読むので、中身とずれない。
Webアプリはこれを読んでどのデータセットを使うかを決めるので、UI側にファイル名は書かれていない。
地図に出る出典表示もカタログから組み立てるため、配信するデータと必ず一致する。

ファイル名の接頭辞で種別が決まる。

| 接頭辞 | 種別 |
| --- | --- |
| `overture_admin` / `n03` | 行政区域 |
| `overture_admin_names` / `n03_names` | 行政区域の名称 (検索用) |
| `overture_buildings` | 建物 |
| `isj_oaza` | 大字・町丁目 |
| `isj_block` | 街区 |

## テスト

```sh
cd pipeline
cargo test
```

`tests/real_data.rs` は `data/` 配下の実ファイルを使う統合テスト。
ファイルが無い環境ではスキップされるので、失敗はしない。
