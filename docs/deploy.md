# デプロイ

アプリとデータを別々の場所に置く。

| | 置き場所 | 理由 |
| --- | --- | --- |
| アプリ (約1.2MB) | GitHub Pages | — |
| DuckDB-WASM本体 (約77MB) | GitHub Pages | アプリと同一オリジンから配る。1ファイル35〜40MBあり、1ファイル25MiB制限のあるホスティングには置けない |
| DuckDBの拡張 (spatial/parquet、約50MB) | GitHub Pages | 本家 (extensions.duckdb.org) への実行時の依存を無くすため。詳細は下記 |
| GeoParquet (約88MB) | Cloudflare R2 | 容量の天井が無く、egressが無料。N03やPLATEAUを足しても困らない |

DuckDB-WASM本体はgitに入れない。ビルド時に `node_modules` から `dist/duckdb/` へコピーされる
([web/vite.config.ts](../web/vite.config.ts) の `copy-duckdb-runtime`)。
アプリのバンドルと同じ `node_modules` を見るので、`pnpm update` してもバージョンがずれない。

DuckDBの拡張 (spatial、それとread_parquet()が暗黙に要求するparquet) も同じ理由で自前配信にしてある。
こちらはnode_modulesに同梱されておらず、`web/duckdb-extensions.ts` が実行時に
duckdb-wasmの積んでいるDuckDB本体のバージョンを読み、本家から署名済みの原本を
`web/.duckdb-extensions/` に落としてくる (gitには入れない)。
`vite.config.ts` は開発サーバー・ビルドどちらでもこれを待ってから設定を解決するので、
`pnpm dev` / `pnpm build` の最初の一度だけ、ネットワークに数秒〜十数秒かかる
(2回目以降はキャッシュがあるので即座)。ビルド成果物は `dist/duckdb/extensions/` に置かれ、
`dist/duckdb/` 全体で約77MB→約127MBに増える。

拡張のバージョンはduckdb-wasmに追従するので、`pnpm update` で上がったときは
`web/.duckdb-extensions/` ごと再取得される (古いバージョンのファイルは残り続けるが、
サイズ以外の実害は無い。気になれば手動で消してよい)。

## 開発

```sh
cd web
pnpm install
pnpm dev
```

先に[パイプライン](pipeline.md)で変換とカタログ生成を済ませておくこと。開発サーバーが
`data/output/` を `/data/` として、DuckDB-WASM本体を `/duckdb/` として配信する。
どちらもビルド成果物には含めない。

## テスト

```sh
cd web
pnpm exec playwright install chromium   # 初回のみ

pnpm test         # 開発サーバー
pnpm test:dist    # 本番ビルド (ビルドして vite preview で配信)
```

**`test:dist` を省かないこと。** バンドル後だけ壊れるものがある。実際、MapLibreの
ワーカーがビルド成果物に出力されず、公開してからGeoJSONが一切描画されないことが分かった
(地図タイルもポップアップも動くので気付きにくい)。いまは `setWorkerUrl` で
Viteにバンドルさせているが、同種の破綻は再び起こりうる。

サブパス配信での参照解決まで含めて確かめるなら、`VITE_BASE_PATH` も渡す。

```sh
VITE_BASE_PATH=/duck-geocoder/ pnpm test:dist
```

## 1. R2にデータを置く

`data/output/` の中身 (catalog.json と *.parquet) をバケット直下にアップロードし、
CORSを設定する。

`http://localhost:4173` は `vite preview` の既定ポート。CIの `pnpm test:dist` が
ここからR2を読むので、含めておく (含めないとブラウザがCORSで弾き、E2Eが全件落ちる)。

```json
[
  {
    "AllowedOrigins": ["https://<user>.github.io", "http://localhost:4173"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["range"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`ExposeHeaders` が無いとDuckDB-WASMがファイルサイズを取得できず、部分取得に失敗して
黙って全件取得に落ちる。`AllowedOrigins` は文字列で厳密に一致するので大文字小文字に注意
(GitHub Pagesはユーザー名を小文字にしたホストで配信される)。

置いたら、**Rangeが正しく扱われることを確かめてから先に進むこと**。
開発サーバーが `Range: bytes=0-0` を誤って処理していて嵌った箇所
(詳細は [duckdb-wasm-range-requests.md](duckdb-wasm-range-requests.md))。

```sh
URL=https://<r2>/overture_admin_jp.parquet
curl -sI "$URL" | grep -i accept-ranges                                          # bytes
curl -s -D- -o /dev/null -H 'Range: bytes=0-0' "$URL" | grep -iE 'content-(range|length)'
                                                    # 206 / bytes 0-0/… / 1
curl -s -o /tmp/c.bin -H 'Range: bytes=100-199' "$URL" && stat -c%s /tmp/c.bin   # 100
curl -sI -H 'Origin: https://<user>.github.io' "$URL" | grep -i access-control
```

## 2. GitHub Pages にアプリを載せる

[.github/workflows/deploy.yml](../.github/workflows/deploy.yml) が `main` への push で動く。
先にリポジトリの設定を済ませること (順番を逆にすると、データのURLが空のままビルドされる)。

- **Settings → Pages → Source**: GitHub Actions
- **Settings → Secrets and variables → Actions → Variables**:
  `DATA_BASE_URL` にR2の公開URL (末尾スラッシュ無し)

## 3. 公開後に確かめる

```sh
cd web
PLAYWRIGHT_BASE_URL=https://<user>.github.io/duck-geocoder/ pnpm test
```

ローカルで通っても配信側のヘッダ設定で壊れうるので、必ず実測する。
転送量を見張るテストが `2.2 MB / 64.1 MB` のように報告する。
