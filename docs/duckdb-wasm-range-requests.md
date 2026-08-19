# DuckDB-WASMにHTTP Rangeリクエストを使わせる

解決済み。原因が2つあり、どちらも実行時に警告が出ないまま「ファイル全体をダウンロードする」
という結果になるため、記録を残す。

このプロジェクトは「サーバーを持たず、静的ホスティングに置いたGeoParquetをブラウザから
直接読む」ことを前提にしている。全国の行政区域データは200MBを超えるので、部分取得が
成立しないと前提が崩れる。

## 結論

### 1. `forceFullHTTPReads: false` を明示する

```ts
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
await db.open({ filesystem: { forceFullHTTPReads: false } });
```

`DuckDBFilesystemConfig.forceFullHTTPReads` の型は `boolean | undefined` で、
「Force use of full HTTP reads, suppressing range requests」と説明されている。
既定は false のはずだが、**指定しないとRangeリクエストが一切出ない**。
`allowFullHTTPReads` や `reliableHeadRequests` をどう組み合わせても変わらず、
このキーを明示的に `false` にしたときだけ挙動が変わる。

`registerFileURL` の第4引数 `directIO` は関係しない (true/falseどちらでも変わらない)。

### 2. 配信側がRangeリクエストを正しく扱う必要がある

Viteが内部で使っているsirvには、`Range: bytes=0-0` に対して **206を返しながら
`Content-Range` を付けず、`Content-Length` にファイル全体のサイズを返す**という穴がある
(`bytes=0-99` は正常)。DuckDB-WASMはこの `bytes=0-0` で部分取得の可否を確かめるので、
ちょうど壊れたケースを踏む。

さらに悪いことに、この状態では小さなレンジを要求するたびにファイル全体が返ってくるため、
**転送量がファイルサイズを上回る**。

`vite.config.ts` の `serveDataLikeObjectStorage` プラグインで、`/data/` 配下の配信を
丸ごと引き取っている。オブジェクトストレージ (S3 / R2) は正しく扱うので、これは
開発サーバー固有の措置。

## 実測

全国の行政区域 (`n03_all.parquet`) で1点を逆ジオコーディングしたときの転送量。
`web/tests/demo.spec.ts` の「逆ジオコーディングはファイル全体のごく一部しか読まない」で計測。

| 条件 | 転送量 |
| --- | ---: |
| `forceFullHTTPReads` 未指定 | 202.6 MB (全体) |
| 指定あり + 配信側がRangeを誤処理 (Vite既定) | **405.2 MB** (全体の2倍) |
| 指定あり + 配信側が正しい + 最適化前のGeoParquet (1 row group / 247.9MB) | 90.5 MB |
| 指定あり + 配信側が正しい + 最適化後のGeoParquet (125 row groups / 202.6MB) | **7.9 MB** |

## 環境

| | |
| --- | --- |
| `@duckdb/duckdb-wasm` | `1.33.1-dev57.0` |
| 実行バンドル | `duckdb-browser-eh.worker.js` + `duckdb-eh.wasm` |
| ブラウザ | Chromium (Playwright経由) |
| 対象ファイル | GeoParquet 202.6 MB / 125 row groups / ZSTD / bbox covering列あり |

`httpfs` 拡張は不要。ブラウザのWorker内で動くDuckDB-WASM独自のHTTPファイルシステムが
Rangeリクエストを出す。`s3://` は読めないが `https://` は読める。

## 切り分けの経緯

原因にたどり着くまでに試した組み合わせ。サーバー側のアクセスログで確認している。

| 設定 | サーバーに届いたリクエスト | 結果 |
| --- | --- | --- |
| `registerFileURL(..., directIO: false)` | `GET` (Rangeなし) のみ | 全件DL |
| `registerFileURL(..., directIO: true)` | 同上 | 全件DL |
| + `reliableHeadRequests: false` | 同上 | 全件DL |
| + `allowFullHTTPReads: false` | **0件** | 初期化失敗 |
| `read_parquet('http://…')` に変更 | `HEAD` (Rangeなし) -> `GET` (Rangeなし) | 全件DL |
| 上 + `allowFullHTTPReads: false` | `HEAD` (Rangeなし) のみ | 初期化失敗 |
| **+ `forceFullHTTPReads: false`** | `GET` (Rangeあり) 多数 | **部分取得** |

決め手は「`allowFullHTTPReads: false` にすると**HTTPリクエストを1件も出さずに**失敗する」
という観測だった。サーバーの応答を見て判断しているのではなく、通信の前に決まっている
ということで、`forceFullHttpReads` が実質的に真になっているという仮説が立った。

バンドルを整形すると、`openFile` (`dataProtocol` 4=HTTP / 5=S3) はこうなっている。

```js
if (!forceFullHttpReads && (reliableHeadRequests || !allowFullHttpReads)) {
  // HEAD に Range: bytes=0- を付けて投げ、206なら部分取得モード
}
if (allowFullHttpReads) {
  // GET Range: bytes=0-0 を試し、ダメなら全件GET
}
// どちらも成立しなければ失敗
```

`forceFullHttpReads` が真だと、両方のプローブが飛ばずに全件GETへ落ちる。
`allowFullHttpReads` も false なら、リクエストを1件も出さずに失敗する。観測と一致する。

## 余談: 気になったままの点

同じ `openFile` のフォールバック側にこういう箇所がある。

```js
const h = m.getResponseHeader("Content-Length");
const v = h?.split("/")[1];      // "bytes 0-0/12345" 形式 = Content-Range のはず
```

`/` で割るのは `Content-Range` の形式であり、`Content-Length` ではない。
今回は `forceFullHTTPReads` の指定で回避できたので追っていないが、上流の取り違えに見える。

## 関連

- `pipeline/src/spatial_pack.rs` — GeoParquet側の空間的な並べ替えとrow group分割
- `web/vite.config.ts` — 開発サーバーのRange配信
- `web/tests/demo.spec.ts` — 転送量を見張るE2E
