# デプロイ

アプリとデータを別々の場所に置く。

| | 置き場所 | 理由 |
| --- | --- | --- |
| アプリ (約1.2MB) | GitHub Pages | — |
| DuckDB-WASM本体 (約77MB) | GitHub Pages | アプリと同一オリジンから配る。1ファイル35〜40MBあり、1ファイル25MiB制限のあるホスティングには置けない |
| DuckDBの拡張 (spatial/parquet、約50MB) | GitHub Pages | 本家 (extensions.duckdb.org) への実行時の依存を無くすため。詳細は下記 |
| GeoParquet (約3.7GB) | Cloudflare R2 | 容量の天井が無く、egressが無料。PLATEAU 306都市を足しても困らない |

## なぜR2か、超えたらどうするか

**この配信はほぼ全部がegress**になる。ブラウザがRangeで引くたびに転送が出るので、
そこが効く。

| | ストレージ | egress |
| --- | ---: | ---: |
| **Cloudflare R2** | $0.015/GB-月 | **$0** |
| AWS S3 | $0.023/GB-月 | $0.09/GB (最初の10TB) |
| Google Cloud Storage | $0.020/GB-月 | 約$0.12/GB |

100GB保存 + 500GB転送で **R2が約$1.50、S3が約$47.30**。
**R2はS3互換**なので、エンドポイントを差し替えれば他へ移れる (囲い込みにはならない)。

無料枠は**永続**で 10GB-月 / Class A 100万 / Class B 1000万。
**Rangeリクエストは1回ずつClass B**に数えられるので、1クエリ数十リクエストとして
月50万クエリ程度までは無料枠に収まる。

**超えた分は払う。** 100GBでも月約¥200なので、配信先を先回りして移す価値が無い。
PLATEAUを306都市に広げた実測が**3.6GB**で、配信物の合計は約3.7GB。
無料枠 (10GB-月) の中に収まっている。

桁が変わるのは点群で、生のまま持つとTB級になり**どの無料枠にも入らない**。
持つなら派生物 (間引き・障害物面・送電線の抽出など) にする。

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

**R2 の遅さは手元では見えない** (往復の待ちがほぼ0)。手元の配信に待ちを足して確かめられる
(1回 450ms・16Mbps は r2.dev を測った値。テストの待ちも R2 と同じ長さになる)。

```sh
DATA_LATENCY_MS=450 DATA_BANDWIDTH_MBPS=16 pnpm test:dist
```

**CI の失敗は注釈で読める。** CI では Playwright が失敗を GitHub の注釈にも書くので、認証なしで
`https://api.github.com/repos/<owner>/<repo>/check-runs/<job id>/annotations` から読める
(ジョブのログは認証が要る)。

## 0. 公開前に権利を確かめる (2026-10-05 に通しで見た)

**配るもの・読みに行くもの・表示するものを、それぞれの条件と突き合わせた。** 規約は変わるので、
出所を足したときと、しばらく空いてから公開するときに見直す。法律の専門家の判断ではない。

| もの | うちがしていること | 条件 | 状態 |
| --- | --- | --- | --- |
| このリポジトリのコード | 公開 | MIT | ✅ |
| 束ねたライブラリ (MapLibre・DuckDB-WASM の JS など) | ビルドに含めて配る | MIT・BSD など: 著作権表示と許諾文を含める | ✅ **直した** (表示が落ちていた)。`THIRD-PARTY-LICENSES.md` |
| DuckDB-WASM 本体と拡張 | 写して配る | MIT。spatial は **GEOS (LGPL-2.1)** を中に持つ | ✅ **直した**。`duckdb/LICENSES.md` に本文とソースの在りか。変えずに配っている |
| STAC Browser | ビルドして配る (パッチ1つ) | ISC: 著作権表示と許諾文 | ✅ **直した**。`/catalog/LICENSE` と依存の一覧 |
| STAC Browser の背景地図 | 表示 | 既定は OSM の公式タイル (重い使い方は禁止) | ✅ **地理院タイルに替えた** |
| PLATEAU | 変換して配る / 公式の 3D Tiles と CityGML を指す | PDL1.0・CC BY 4.0: 出典と加工の明記 | ✅ 配信 API は手続き不要・無償 (試験運用で保証なし) |
| Overture | 変換して配る | **ODbL**: 出典、派生物は ODbL で提供 | ✅ ODbL で提供 (README)。**出典を主題ごとに直した** (下の注意) |
| 国土数値情報 (鉄道 N02) | 変換して配る | 2020年以降はオープンデータ | ✅ |
| 国勢調査 (地域メッシュ) | 変換して配る | 政府標準利用規約 2.0: 出典と加工の明記 | ✅ |
| 位置参照情報 | 変換して配る | 独自の約款: 出典の書き方の指定、**精度の要る測量・証明には使えない** | ✅ 第三者への提供も可 |
| 地理院タイル・ベクトルタイル | 表示 (公開元を直接読む) | 国土地理院コンテンツ利用規約: 出典 | ✅ |
| Mapterhorn・Re:Earth | 表示 (公開元を直接読む) | 出典 (Mapterhorn の日本は測量法の承認を向こうが取得) | ✅ 利用方針・保証の記載なし |
| N03・基盤地図情報 (標高) | **配らない** (参照だけ) | 複製に測量法の承認が要る | ✅ |
| AW3D30 (JAXA)・NASADEM・ASTER GDEM | **配らない** (参照だけ) | JAXA は商用なら事前に連絡 | ✅ |

**残っている心配 (どれも公開を止めるものではない):**

- **Overture の出所を数えていない。** Overture は主題ごとに OSM 以外の出所 (建物なら Microsoft・Esri・
  Google・Qian Shi ら) にも出典を求めている。取り出すときに `sources` 列を落としていて、日本に実際に
  どれが入っているか分からないので、**挙げられている出所を全部書いた** (無いものを書いても害は無い)。
  次に Overture を取り直すときに `sources` を残して数え、出典を実際のものに絞る
- **無償の配信に頼っている。** Mapterhorn・Re:Earth・PLATEAU の配信 API はどれも保証が無い。
  止まっても地図は使える (地形は地理院の標高に切り替えられる、テストあり)
- **AW3D30 を地図に出すとき**は、画像に「©JAXA」を出す。商用で使う人には事前の連絡が要ることを示す
- **「手元で変換する」仕組みを作るとき**は、測量法の解釈を地理院に確かめてから (roadmap)

## 1. R2にデータを置く

`data/output/` の中身 (catalog.json と *.parquet) をバケット直下にアップロードし、
CORSを設定する。

**データを作り直したときは、pushより先にここを済ませること。** デプロイのCIは
本番ビルドのE2EをR2の実データに対して流すゲートなので、データが古いままだと
テストが落ちてデプロイが止まる。

カタログ (JSON と items.parquet) も忘れずに上げること。件数・収録範囲・列構成はここから
読まれるので、parquetだけ差し替えると実データとずれる。

### 先に上げると壊れる場合がある

parquetの中身だけを作り直したのなら、先に上げても公開中のコードはそのまま読める。
**壊れるのは catalog.json の構造が変わるとき** (STAC化のような変更)。公開中の
バンドルは古い構造を前提にしているので、**上書きした瞬間から新しいバンドルが
Pagesに載るまで、公開中のサイトが動かない** (ビルドとE2Eで10分前後)。
E2Eが落ちればその間ずっと壊れたままになる。

構造が変わるときは、被害を小さくする順に上げる。

1. **catalog.json 以外を先に上げる。** 新しいパス (`estat/` `isj/` など) に入るので、
   公開中のコードはまだ古いcatalog.jsonを読んでいて影響を受けない
2. **catalog.json を最後に上げ、続けて push する。** 壊れている時間がここに収まる
3. **`--delete` を付けない。** 古いファイルを残しておけば、戻すのは
   古い catalog.json を上げ直すだけで済む

### アップロードのコマンド

rclone を使う。**リモート名は `rclone config` で付けた名前**で、バケットは
`duck-geocoder`。以下は `R2` に入れて使う。

```sh
R2=<リモート名>:duck-geocoder
```

**`--delete` (`rclone sync`) を使わない。** 上の理由で、古いファイルは戻す手段として
残しておく。`rclone copy` は消さないので、既定でこの方針になる。

**`--size-only` を必ず付ける。**`data/output` を丸ごと指定すると、
rclone が更新時刻で比較して**3.7GBを上げ直しにいくことがある**
(ブラウザから入れたファイルには更新時刻が入っていない)。

**ただし `--size-only` は大きさが同じファイルを飛ばす。** 中身だけ差し替えた
ときに危ない — `add_coarse_lod` のように**既存のファイルを書き換える**工程が
あるので、大きさが偶然揃うと古いものが載ったままになる。
心配なときは、その数ファイルだけ名指しで `--size-only` を外して上げる。

```sh
# 中身を書き換えたファイルを名指しで上げ直す (--size-only を付けない)
rclone copy data/output/ksj/n02_sections_all.parquet "$R2/ksj/" -P
```

**JSONは実データと同じディレクトリにある** (2026-09-27に寄せた。ルートは
`catalog.json` 1つだけ)。出所ごとのディレクトリを上げれば、その出所の
サブカタログ・Collection・ItemCollection・parquetがまとまって載る。

**出所ごとにサブカタログ (`plateau/catalog.json` など) がある** (2026-09-29に挟んだ)。
ルートの子はCollectionではなくサブカタログで、UIの一覧の見出しはここから来る。
**これを入れたときは構造の変更にあたる** — 公開中の古いバンドルはルートの子を
Collectionとして読むので、新しい `catalog.json` を上げた瞬間から起動に失敗する。
上の「先に上げると壊れる場合がある」の順で上げること。

**`build_catalog` は古いJSONを消さない。** データセットをやめたときは
手元にCollectionのJSONが残るので、上げる前に消すこと
(残っていても `catalog.json` が参照しないので壊れはしないが、配信先に
誰も読まないファイルが積み上がる)。リンクが全部解決するかはこれで見られる
(**サブカタログの下まで辿る**)。

```sh
cd data/output && mise exec -- jq -r '.links[] | select(.rel=="child") | .href' catalog.json |
  while read sub; do
    [ -f "$sub" ] && echo "OK   $sub" || { echo "欠落 $sub"; continue; }
    dir=$(dirname "$sub")
    mise exec -- jq -r '.links[] | select(.rel=="child") | .href' "$sub" |
      while read h; do [ -f "$dir/$h" ] && echo "OK   $dir/$h" || echo "欠落 $dir/$h"; done
  done; cd -
```

**アプリの入口はまとめ (`collections.json` / `collections.en.json`)** (2026-10-07 から)。
アプリは起動時にこれだけを読み、Item は `items.parquet` から読む。文書ごとの JSON
(`catalog.json` から辿るもの) は STAC Browser などの道具が読む。
**まとめを最後に上げれば、その前に上げたものはアプリから見えない。**
(それまでは `catalog.json` が入口で、これを最後に上げていた。)

**JSON と `items.parquet` は `--size-only` を付けずに上げる。** 中身だけが変わって大きさが
揃うことがある (サブカタログを挟んだときは全Collectionの `parent` が書き換わった)。
`items.parquet` は `build_catalog` のたびに書き直される。JSONは88ファイル・合計430KB、
`items.parquet` は80KBなので、毎回全部上げても安い。

```sh
# 1. 実データの parquet を上げる (大きさで比べる。全部を上げ直さないため)
rclone copy data/output "$R2" --filter '- /items.parquet' --filter '+ *.parquet' --filter '- **' \
  --size-only -P

# 2. まとめ以外の JSON と items.parquet を上げる (大きさで比べない)
rclone copy data/output "$R2" \
  --filter '- /collections*.json' --filter '+ *.json' --filter '+ /items.parquet' --filter '- **' -P

# 3. まとめを最後に上げる
rclone copy data/output "$R2" --filter '+ /collections*.json' --filter '- **' -P

# 4. 続けて push する (壊れうる時間をここに収める)
git push
```

**`--filter` で書く。** `--include` と `--exclude` を混ぜると、rclone自身が
「解釈の順が不定」と警告する。`--filter` は**上から順に最初に当たった規則**が効く。

- `- /collections*.json` — 先頭の `/` で**ルートのものだけ**を外す
- `+ *.json` — 残りのJSON (Catalog・サブカタログ・Collection と、その英語版)
- `- **` — それ以外は外す

選ばれるファイルは、**上げる前に手元で確かめられる** (`lsf` はリモートに触れない。
暗号化した設定のパスワードを聞かれないよう、空の設定を渡す)。

```sh
rclone --config /dev/null lsf -R data/output --files-only \
  --filter '- /collections*.json' --filter '+ *.json' --filter '+ /items.parquet' --filter '- **'
# 87行 (2026-10-07)。collections*.json が無く、items.parquet があること
```

**`rclone` はループで回さない。** 設定を暗号化していると**起動ごとに
パスワードを聞かれる**ので、出所ごとに5回回すと5回打つことになる。
`data/output` を1回で渡せば済む (`--size-only` が無いと全部を上げ直しに行く)。

上の手順は**3回呼ぶ** (3回聞かれる)。比べ方がそれぞれ違うため —
JSONは大きさで比べると取りこぼし、parquetは大きさで比べないと全部上げ直し、
まとめは最後でなければならない。

初回は**306都市で3.6GB**あるので時間がかかる。`-P` で進捗が出る。
2回目以降は `--size-only` が効いて差分だけになる。

聞かれるのを無くすなら `--password-command` がある。
**平文でどこにも置かずに済む** (鍵はOSのキーリングが持つ) が、
`secret-tool` の導入と登録が要る。

```sh
rclone --password-command "secret-tool lookup rclone config" copy …
```

### 2026-10-03 と 10-07 の分 (まとめて1回で上げる)

10-03 の分 (段の間引き・Overtureの取り直しと全国化) と、10-07 の分 (Item を stac-geoparquet に・
英語版・まとめ) を**1回で上げる**。**上の「いつもの手順」とは順が違う** — 入口が
`catalog.json` からまとめに変わる切り替えなので、公開中の古いアプリを壊さない順にする。

**公開中の古いアプリは、日本語の Collection の JSON にある `rel: items` を頼りに
`*-items.json` を読む。** 新しい Collection の JSON にはこれが無い (Item は items.parquet へ移った)。
**日本語の JSON を push より先に上げると、その瞬間から公開中のサイトが起動しなくなる。**
新しいアプリは日本語の JSON を起動時に読まないので、push の後に上げれば壊れる時間が無い。

**plateau/ と overture/ の parquet は全部書き換わっている** (建物に `lod` 列を足した・
Overtureを 2026-09-23.1 で取り直した)。大きさで比べると偶然揃ったものを取りこぼすので、
**この2つは `--size-only` を外して上げる** (plateau 3.8GB + overture 5.7GB、707ファイル。
ほぼ全部が上げ直しになる)。ksj/ estat/ isj/ の parquet は変えていない。

```sh
# 1. plateau/ と overture/ の parquet を、大きさで比べずに上げる (古いアプリはそのまま動く)
rclone copy data/output "$R2" \
  --filter '+ /plateau/*.parquet' --filter '+ /overture/*.parquet' --filter '- **' -P

# 2. 新しく増えるものだけを上げる (items.parquet・まとめ・英語版。古いアプリは読まない)
rclone copy data/output "$R2" \
  --filter '+ /items.parquet' --filter '+ /collections*.json' --filter '+ *.en.json' --filter '- **' -P

# 3. push する。CI の E2E は新しいアプリを、2で上げたまとめと items.parquet で確かめる
git push

# 4. 実サイトが新しいアプリを配り始めたら (下の「確かめる」)、日本語の JSON を上げる
rclone copy data/output "$R2" \
  --filter '- /collections*.json' --filter '- *.en.json' --filter '+ *.json' --filter '- **' -P
```

上げる前に、選ばれるファイルの数を手元で確かめられる。

```sh
rclone --config /dev/null lsf -R data/output --files-only \
  --filter '+ /items.parquet' --filter '+ /collections*.json' --filter '+ *.en.json' --filter '- **'
# 2: 46行 (items.parquet 1・まとめ 2・英語版 43)
rclone --config /dev/null lsf -R data/output --files-only \
  --filter '- /collections*.json' --filter '- *.en.json' --filter '+ *.json' --filter '- **'
# 4: 43行 (catalog.json を含む)
```

- **3と4の間は、文書ごとの日本語の JSON が古い。** 新しいアプリはまとめで動くので困らない。
  STAC Browser (`/catalog/`) と、ⓘ から開く STAC の文書は古いものを見せる (4で揃う)。
  E2E はこの間でも通るように書いてある (画面と比べるカタログはまとめから読む)
- **新しいアプリが配られたかの確かめ方:** 実サイトを開き、開発者ツールのネットワークで
  `collections.json` を読んでいること (古いアプリは `catalog.json` から辿る)
- **R2の無料枠 (10GB) にほぼ届く。** 手元の `data/output` は9.6GB、R2には古いファイル (下) も残る。
  超えた分は払う方針 (上の節)
- 新しいサブカタログ (`gsi/` `mapterhorn/` `reearth/` `jaxa/` `nasa/`) は **JSON だけ**で、4で上がる。
  タイルは公開元が配信しているので、R2には何も置かない

**R2に残る古いファイル** (新しいカタログからは参照されない)。4のあと、実サイトが新しいアプリを
配っていることを確かめてから消す (古いアプリは `*-items.json` を読むので、先に消すと壊れる)。

| ファイル | 何か |
| --- | --- |
| `*/*-items.json` (15個) | Collection ごとの ItemCollection (items.parquet に移った) |
| `overture/overture_buildings_minato.parquet` | 港区だけだった頃の建物 |

```sh
# 消すものを先に見る (--dry-run は何も消さない)
rclone delete "$R2" --include '*-items.json' --dry-run
rclone delete "$R2" --include '*-items.json'
rclone delete "$R2/overture/overture_buildings_minato.parquet"
```

### 2026-10-08 の分 (建物の並べ直し)

上の「10-03 と 10-07 の分」は 1〜3 まで済んだが、**CI の E2E が落ちてデプロイが止まった。**
建物の並べ方 (段ごと) が R2 では遅く、テストの待ち時間を超えていた。並べ方を直したので
(docs/pipeline.md の「建物の並べ方」)、**建物のファイルを上げ直す。**

```sh
# 1. 建物のファイル (PLATEAU 306・Overture 392、計9.3GB) を、大きさで比べずに上げる。
#    中身を並べ替えただけなので、公開中の古いサイトもそのまま読める
rclone copy data/output "$R2" \
  --filter '+ /plateau/plateau_bldg_[0-9]*.parquet' --filter '+ /overture/overture_buildings_*.parquet' \
  --filter '- **' -P

# 2. カタログの増えたもの (列の並びが変わったので作り直した。46ファイル)
rclone copy data/output "$R2" \
  --filter '+ /items.parquet' --filter '+ /collections*.json' --filter '+ *.en.json' --filter '- **' -P

# 3. push すると CI が流れ直す
git push
```

選ばれるのは、1が698ファイル・9.3GB、2が46ファイル
(`rclone --config /dev/null size data/output --filter …` で上げる前に確かめられる)。
`plateau_bldg_[0-9]*` なので、整備範囲 (`plateau_bldg_coverage`) は入らない。

CI が通ったら、上の「10-03 と 10-07 の分」の 4 (日本語の JSON) と 5 (古いファイルを消す) に戻る。

### 2026-10-09 の分 (建物の概観)

10-08 の分も 1〜3 まで済んだが、**CI の E2E はまだ落ちた** (手元から R2 に向けて流すと 116件中9件。
引いた表示の間引きに1分以上かかり、ほかの読み込みが後ろで待たされる)。引いた表示のための
**概観** (docs/pipeline.md の「建物の概観」) を足したので、**それを上げる。**

```sh
# 1. 概観 (PLATEAU 45・Overture 3、計409MB)。新しいファイルなので、公開中の古いサイトは読まない
rclone copy data/output "$R2" \
  --filter '+ /plateau/plateau_bldg_overview_*.parquet' --filter '+ /overture/overture_buildings_overview_*.parquet' \
  --filter '- **' -P

# 2. カタログ (items.parquet に概観の Item が増えた。46ファイル)
rclone copy data/output "$R2" \
  --filter '+ /items.parquet' --filter '+ /collections*.json' --filter '+ *.en.json' --filter '- **' -P

# 3. push すると CI が流れ直す
git push
```

- **1 を 2 より先に。** items.parquet が概観を指しているのに概観が無いと、新しいアプリの
  引いた表示が読めずに失敗する (古いサイトは items.parquet を読まないので、どちらの順でも壊れない)
- 選ばれるのは 1 が48ファイル、2 が46ファイル (`rclone --config /dev/null lsf -R data/output --files-only --filter …`)
- 建物の元のファイルは変えていない (上げ直さなくてよい)

CI が通ったら、上の「10-03 と 10-07 の分」の 4 (日本語の JSON) と 5 (古いファイルを消す) に戻る。

### 2026-10-10 の分 (引いた表示をタイルに)

10-09 の分で CI が通り、**10-10 11:19 に今のカタログ形式のアプリが公開された** (日本語の JSON と
古いファイルの削除はまだ)。そのあと、引いた表示を GeoParquet の概観から **PMTiles** に置き換えた
(docs/pipeline.md の「引いた表示はタイル (PMTiles) で描く」)。

**公開中のアプリは `collections.json` を読む新しいもの**なので、日本語の JSON も順番を気にせず上げられる
(「10-03 と 10-07 の分」の 4 はここでまとめて済む)。

```sh
# 1. タイル (PLATEAU 123MB・Overture 39MB、2ファイル)
rclone copy data/output "$R2" \
  --filter '+ /plateau/plateau_bldg_tiles.pmtiles' --filter '+ /overture/overture_buildings_tiles.pmtiles' \
  --filter '- **' -P

# 2. カタログ (items.parquet・まとめ・英語版・日本語の JSON。89ファイル)
rclone copy data/output "$R2" \
  --filter '+ /items.parquet' --filter '+ *.json' --filter '- **' -P

# 3. push すると CI が流れ直す
git push

# 4. 新しいアプリが公開されたら、使わなくなったファイルを消す (先に --dry-run で見る)
rclone delete "$R2" --include '/plateau/plateau_bldg_overview_*.parquet' --include '/overture/overture_buildings_overview_*.parquet' --dry-run
rclone delete "$R2" --include '/plateau/plateau_bldg_overview_*.parquet' --include '/overture/overture_buildings_overview_*.parquet'
rclone delete "$R2" --include '*-items.json' --dry-run
rclone delete "$R2" --include '*-items.json'
rclone delete "$R2/overture/overture_buildings_minato.parquet"
```

- **1 を 2 より先に。** カタログがタイルを指しているのにタイルが無いと、新しいアプリの引いた表示が描けない
- 2 と 3 の間、公開中のアプリ (概観を読む版) は items.parquet から概観が消えるので、引いた表示で
  都市ごとの GeoParquet を読む (遅いが壊れない)。3 のデプロイで直る
- 4 の概観は 48ファイル・409MB。消すと R2 の合計は無料枠に収まる (下のボードの数字)
- 選ばれるのは 1 が2ファイル、2 が89ファイル (`rclone --config /dev/null lsf -R data/output --files-only --filter …`)

### 平置きだった頃の古いJSONを消す

`rclone copy` は消さないので、ルートに残る。`catalog.json` を差し替えれば
参照されなくなるだけなので、**急いで消さない。戻す手段になる。**

**消してよいのは「実サイトが新しいバンドルを配り始めてから」。**
CIのsuccessだけでは足りない。**古いバンドルは古い平置きJSONに依存している**ので、
Pagesの配信が切り替わる前に消すと公開中のサイトが壊れる。

| | 消してよいか |
| --- | --- |
| CI が success | ❌ まだ。本番ビルドが通っただけ |
| Deploy が success | ❌ まだ。配信の切り替わりを確かめる |
| **実サイトが新バンドルを配っている** | ⭕ ここから |

利用者のブラウザにキャッシュされた古いバンドルは消した瞬間に壊れるので、
**急がないなら数日置く。**

```sh
rclone delete "$R2" --include '*.json' --exclude 'catalog.json' --max-depth 1
```

**`--max-depth 1` を忘れない。** これが無いと**ディレクトリの中の
新しいJSONも消える。**

上げたものを確かめる。

```sh
rclone ls "$R2" | sort -k2
```

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

同じワークフローが **STAC Browser** (カタログをページで辿る画面) を `/catalog/` に置く
([stac-browser/build.sh](../stac-browser/build.sh))。カタログは `DATA_BASE_URL` の `catalog.json`
を読むので、R2 に上げたカタログがそのまま見える。アプリと同じオリジンなので CORS の追加は要らない。

## 3. 公開後に確かめる

```sh
cd web
PLAYWRIGHT_BASE_URL=https://<user>.github.io/duck-geocoder/ pnpm test
```

ローカルで通っても配信側のヘッダ設定で壊れうるので、必ず実測する。
転送量を見張るテストが `1.5 MB / 97.6 MB` のように報告する。
