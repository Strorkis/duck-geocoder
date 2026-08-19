# DuckDB-WASMがHTTP Rangeリクエストを使わず、Parquetファイル全体をダウンロードする

未解決。調査した内容の記録。

このプロジェクトは「サーバーを持たず、静的ホスティングに置いたGeoParquetをブラウザから直接読む」
ことを前提にしている。全国の行政区域データは200MBを超えるので、部分取得が成立しないと前提が崩れる。
GeoParquet側は空間的に並べ替えてrow groupに分けてあり (`pipeline/src/spatial_pack.rs`)、
1点の逆ジオコーディングなら数MBの読み取りで済む形になっている。
しかしブラウザがRangeリクエストを使わないため、その効果が届いていない。

## 環境

| | |
| --- | --- |
| `@duckdb/duckdb-wasm` | `1.33.1-dev57.0` |
| 実行バンドル | `duckdb-browser-eh.worker.js` + `duckdb-eh.wasm` (ネットワークログで確認済み) |
| ブラウザ | Chromium (Playwright経由) |
| サーバー | Vite開発サーバー (cross-origin isolationなし = pthreadなし) |
| 対象ファイル | GeoParquet 202.6 MB / 125 row groups / ZSTD圧縮 / bbox covering列あり |

## 再現コード

```ts
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

const conn = await db.connect();
await conn.query(`INSTALL spatial; LOAD spatial;`);

await db.registerFileURL(
  'n03_all.parquet',
  `${window.location.origin}/data/n03_all.parquet`,
  duckdb.DuckDBDataProtocol.HTTP,
  false,
);
await conn.query(`CREATE VIEW n03 AS SELECT * FROM read_parquet('n03_all.parquet');`);
```

## 症状

Rangeヘッダの無い単一のGETで202.6MB全体を取得する。サーバー側のアクセスログ:

```
[data] GET /data/isj_oaza_13.parquet  Range= undefined
[data] GET /data/n03_all.parquet      Range= undefined
[data] GET /data/overture_buildings_minato.parquet  Range= undefined
```

row groupの統計による絞り込み以前に、部分取得自体が発生していない。

## 試した組み合わせ

| # | 設定 | サーバーに届いたリクエスト | 結果 |
| --- | --- | --- | --- |
| 1 | `registerFileURL(..., directIO: false)` | `GET` (Rangeなし) のみ | 全件DL |
| 2 | `registerFileURL(..., directIO: true)` | 同上 | 全件DL |
| 3 | + `db.open({filesystem:{reliableHeadRequests:false}})` | 同上 | 全件DL |
| 4 | + `db.open({filesystem:{allowFullHTTPReads:false}})` | **0件** | 初期化失敗 |
| 5 | `registerFileURL`をやめ `read_parquet('http://localhost:5173/data/x.parquet')` | `HEAD` (Rangeなし) -> `GET` (Rangeなし) | 全件DL |
| 6 | #5 + `allowFullHTTPReads:false` | `HEAD` (Rangeなし) のみ | 初期化失敗 |

#4 / #6 のエラー:

```
Opening file 'isj_oaza_13.parquet' failed with error: Failed to open file: isj_oaza_13.parquet
```

#4で**HTTPリクエストが1件も出ないまま**失敗するのが特に不可解。
また、#4で失敗する事実から、全件ダウンロードは「Rangeが使えないので仕方なく」ではなく
`allowFullHTTPReads` のフォールバック経路として選ばれていることがわかる。

## サーバーとブラウザは正常

```console
$ curl -s -D- -o /dev/null -H "Range: bytes=0-99" http://localhost:5173/data/n03_all.parquet
HTTP/1.1 206 Partial Content
Content-Length: 100
Content-Range: bytes 0-99/212419603
```

Worker内から同期XHR (DuckDB-WASMと同じ方式) で投げても成功する:

```js
const x = new XMLHttpRequest();
x.open('HEAD', url, false);              // 同期
x.setRequestHeader('Range', 'bytes=0-');
x.send(null);
// -> 206, Content-Length: 315647
```

つまり「サーバーがRangeに対応していない」「WorkerからRangeヘッダを送れない」のどちらでもない。

## 引っかかっている点

### (a) バンドル内の判定ロジックが実行されていないように見える

`duckdb-browser-eh.worker.js` の `openFile` (`dataProtocol` 4=HTTP / 5=S3) を整形すると:

```js
if (!forceFullHttpReads && (reliableHeadRequests || !allowFullHttpReads)) {
  try {
    const f = new XMLHttpRequest();
    f.open("HEAD", dataUrl, false);
    f.setRequestHeader("Range", "bytes=0-");   // <- このリクエストが一度も観測できない
    f.send(null);
    const len = f.getResponseHeader("Content-Length");
    if (len !== null && f.status == 206) { /* 部分取得モード */ }
  } catch (e) { console.warn("HEAD request with range header failed: " + e); }
}
if (allowFullHttpReads) { /* GET Range: bytes=0-0 を試し、ダメなら全件GET */ }
```

`reliableHeadRequests` は既定 `true` なので条件は成立するはずだが、
この `HEAD` + `Range: bytes=0-` がサーバーに届かない。

なお、読んだバンドルと実際に実行されているバンドルが同一であることは確認済み
(ネットワークログに `duckdb-browser-eh.worker.js` と `duckdb-eh.wasm` が出る)。

### (b) `Content-Length` を `/` で分割している

フォールバック側:

```js
const h = m.getResponseHeader("Content-Length");
const v = h?.split("/")[1];      // "bytes 0-0/12345" 形式 = Content-Range のはず
```

`/` で割るのは `Content-Range` の形式であり、`Content-Length` ではない。上流の取り違えの可能性がある。

### (c) Viteが `Range: bytes=0-0` を誤処理する

```console
$ curl -s -D- -o /dev/null -H "Range: bytes=0-0" http://localhost:5173/data/x.parquet
HTTP/1.1 206 Partial Content
Content-Length: 315647     # 全体サイズ
# Content-Range ヘッダなし
```

`bytes=0-99` は正常なのに、`bytes=0-0` だけおかしい。
DuckDB-WASMのフォールバック判定はまさに `bytes=0-0` を使うので、
仮に (a) を解決してもここで再び噛み合わない可能性がある。

### (d) ViteはHEADに `Accept-Ranges` を付けない

これは別系統の問題。DuckDB-WASMには emscripten の `createLazyFile` を使う経路もあり、
そちらは HEAD の `Accept-Ranges` を見てチャンクサイズを決める:

```js
const y = h.getResponseHeader("Accept-Ranges") === "bytes";
let A = 1024 * 1024;   // チャンクサイズ
y || (A = v);          // Accept-Ranges が無ければ、チャンク = ファイル全体
```

Viteの開発サーバーはGETのRangeには206で応えるのに、HEADには `Accept-Ranges` を付けない。
オブジェクトストレージ (S3 / R2) は付けるので、開発サーバー固有の差。
Viteプラグインで `Accept-Ranges: bytes` を足し、HEAD + Range に206を返すようにしても
本件の症状は変わらなかったが、いずれ必要になる可能性がある。

## 確認したいこと

1. `1.33.1-dev57.0` (dev版) 固有の問題か、安定版でも同じか
2. `registerFileURL` + `DuckDBDataProtocol.HTTP` で**実際に部分取得できている**構成の実例
3. `filesystem.allowFullHTTPReads` / `reliableHeadRequests` / `forceFullHTTPReads` の正しい組み合わせ
4. Vite以外 (R2 / S3 / nginx / `vite preview`) で挙動が変わるか
5. `httpfs` 拡張なしで部分取得が成立する前提で合っているか
   (`s3://` は読めないが `https://` は読める、という理解)

## 検索キーワード

```
duckdb-wasm registerFileURL range request full download
duckdb-wasm DuckDBDataProtocol.HTTP not using HTTP range requests
duckdb-wasm allowFullHTTPReads reliableHeadRequests
duckdb-wasm parquet httpfs partial read browser
duckdb-wasm downloads entire parquet file instead of range requests
```

## 関連

- `web/tests/demo.spec.ts` の「逆ジオコーディングはファイル全体のごく一部しか読まない」を
  `test.fixme` で残してある。解決したら外す。
- `pipeline/src/spatial_pack.rs` — GeoParquet側の空間的な並べ替えとrow group分割。
