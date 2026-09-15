# このリポジトリで作業するときの約束事

いずれも、実際にここで起きた失敗から来ている。

回答・コミットメッセージ・コード内のコメントは日本語で書く。

## 道具

道具ごとに禁止するのではなく、**3つの軸**で決める。

1. **追跡下のファイルを書き換えるか。** 差分の残らない変更は後から追えない
2. **`mise.toml` の管理下か。** 環境が変われば壊れる
3. **何をしたか後から読めるか。** SQLやjqのフィルタは残るが、スクリプトは読み取りにくい

| 道具 | 使うところ | 使わないところ |
| --- | --- | --- |
| `duckdb` | データ (Parquet・CSV・大きなJSON) を見る・作る | — |
| `jq` | 小さなJSON、hookの中 | — |
| `awk` / `grep` | テキストの抽出・集計 | — |
| `sed` | パイプの中の置換 (awkと同じで出力しか変えない) | **`-i` でのファイル書き換え** |
| `python` | — | **使わない** |
| Read / Edit / Write | 追跡下のファイルの変更 | — |
| Rust (`pipeline/src/bin/`) | 繰り返す処理、テストを書きたい処理 | — |

- **追跡下のファイルを変えるのは Read / Edit / Write と Rust のパイプラインだけ。**
  `sed -i` は差分が残らず、PostToolUseのfmt/lint hookも通らない
- **リポジトリのファイルを読むときは Read を使う。** 行番号が付き、承認も要らない。
  `sed -n` や `awk` を使うのは、パイプの途中で流れを加工するときだけ
- **`python` は使わない。** `mise.toml` の管理外で環境が変われば壊れるうえ、
  **自由度が高く何をしたかが後から読めない。** 同じことは `jq` (宣言的) や
  `duckdb` (SQL) でできて、そちらの方が残る。必要になったら mise に足して方針ごと見直す
- **ワンショットでも繰り返すなら Rust に置く。** `pipeline/src/bin/` ならテストが書けて再実行できる
- `mise exec -- <コマンド>` で実行する。`export PATH=...` より短く、状態を持たない
- **プロセスを止めるときは `fuser -k -n tcp <port>`。** `pkill` は終了コード144になる

`sed -i` と `python` は `.claude/settings.json` のhookで止めている。**覚えている前提にすると
取りこぼすため** (このリポジトリでの実績: 1,052回のBashのうち `sed` 22回・`python3` 21回)。

## 約束の変え方

**ここの約束は固定ではない。** 守るコストが利益を上回るなら変えてよい。
**適材適所を、道具の禁止で潰さない。** 実際に2回変えている。

- `jq` は「持ち出さない」から「小さなJSONには使う」へ (hookが `jq` を要求したため)
- `sed` は「使わない」から「`-i` だけ止める」へ
  (パイプの中の置換は `awk` と変わらず、止める理由が無かった)

ただし**黙って回避しない。** 理由を添えて相談し、合意してから
**AGENTS.md と `.claude/settings.json` の両方**を直す。
片方だけ直すと、hookと文書が食い違ったまま残る。

## データの扱い

- **配布ページのURLを推測して取得しない。** 公式のAPIが提供されていない配布元では、
  手動でダウンロードする。無料で公開されているものへの態度の問題として
- **Overture MapsのS3アクセスは最小限にする。** `bbox` covering列で絞ればrow group単位で
  読み飛ばせる (日本全体のdivisionsで約30秒)。国名や属性だけで絞ると効かない。
  取得は1回で済ませ、粒度の変更などは落としたファイルに対して手元でやり直す
- **出典表示はライセンス上の義務。** 地図の表示はカタログから組み立てているので、
  データセットを増やすときは `pipeline/src/catalog.rs` の `DESCRIPTIONS` に必ず出典を書く。
  国土交通省のコンテンツは「コンテンツ名」「（国土交通省）」「当該ページのURL」と、
  加工した旨の記載が要る

### カタログは STAC 1.1.0

配信するデータの目録は [STAC](https://github.com/radiantearth/stac-spec) で書いている。
`catalog.json` (Catalog) → `<collection>.json` (Collection) →
`<collection>-items.json` (ItemCollection) の3階層で、**すべて配信の起点に平置き**。
リンクはその文書からの相対として解決されるため。

- **Collectionはファイル数で増やさない。** 空間範囲は全体の1件だけにして、
  ファイルごとの範囲はItemに置く。Collectionは起動時に読むので小さく保つ
- **Itemは1件1ファイルにしない。** 350ファイルを超えるので、
  Collectionごとに1つのItemCollectionにまとめる
- **独自項目には `duck:` を付ける** (`duck:kind` / `duck:attribution`)。
  種別も出典の文言もSTACに専用の場所が無い
- 詳細と既知の穴 (`datetime` を埋めていない) は [docs/pipeline.md](docs/pipeline.md)

[Portolan](https://www.portolan-sdi.org/) は同じ構成 (オブジェクトストレージに
静的ファイル + STAC + GeoParquet) を仕様にしたもの。**まだ準拠していない。**

> Every catalog and collection carries `catalog.json` or `collection.json` for machines,
> plus `README.md` and `AGENTS.md` for people and agents.

Portolanが求める `README.md` / `AGENTS.md` は**配信するデータの側** (カタログと
各コレクションの隣) に置くもので、**このリポジトリのAGENTS.mdとは別物**。
こちらはコードを書くエージェント向けで、あちらはデータを読むエージェント向け。
`data/output/` 側にはまだ無い。

準拠を名乗るのはv1.0が見えてから。v0.2.0で破壊的変更が予告されている。

## 実装の方針

- **曖昧なら黙って通さず、エラーにする。** 実際にあった例:
  - zipに候補が複数あるとき (全国版N03には詳細版と簡易版の2つのGeoJSONが入っていて、
    `ends_with` だけで探すと意図しない方を拾っていた)
  - 座標系の識別子が既知の値でないとき (将来JGD2024に変わっても気付けるように)
  - ジオメトリ種別の名前が未知のとき
- **決め打ちせず、ファイルのメタデータから読む。** 座標系はGeoJSONの `crs` や
  位置参照情報のメタデータXMLから、covering列の位置はGeoParquetの `geo` から読んでいる
- **n=1で「同じ」と判断しない。** 座標系が一致して見えても、変換パラメータを確認する

## 静かに壊れるもの

警告もエラーも出ないまま結果だけが変わる箇所があり、いずれもテストで見張っている。

- **部分取得。** DuckDB-WASMの `filesystem` 設定、配信側のRange対応、GeoParquetの
  row group分割のどれが欠けても、全件ダウンロードに落ちる。
  `web/tests/demo.spec.ts` が転送量そのものを測っている。
  経緯は [docs/duckdb-wasm-range-requests.md](docs/duckdb-wasm-range-requests.md)
- **本番ビルドだけの破綻。** MapLibreのワーカーがバンドラから見えず、出力されないまま
  公開してしまい、GeoJSONが一切描画されなくなった。地図タイルもポップアップも動くので
  気付きにくい。`pnpm test:dist` を省かない
- **テストの空振り。** 転送量を測るテストは、当初0バイトでも通る書き方になっていた。
  「効いている」ことを確かめるテストには、「測れている」ことの確認も入れる

## 変更を入れるとき

```sh
cd pipeline && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
cd web && pnpm exec tsc --noEmit && pnpm test && pnpm test:dist
```

CIも同じものを回す (`.github/workflows/`)。Web側の検証はデプロイの手前に置いてあるので、
落ちれば公開されない。

コミットメッセージはConventional Commits (`feat:` `fix:` `perf:` `refactor:` `docs:` `test:`)。

- **体言止めで書く。** 「〜を直す」ではなく「〜を修正」、「変えた」ではなく「変更」
- 本文には「何をしたか」ではなく「なぜそうしたか」と、判断の根拠になった実測値を書く
