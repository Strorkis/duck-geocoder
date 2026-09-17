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

**aptを使うのはここだけ。** 他の道具はすべてmise配下に置く。

### 参考資料のPDFを読む

`.reference/` に置いた仕様書などを読むために、Pythonを使えるようにしてある。
**配信データを作る工程には入らない** ([AGENTS.md](../AGENTS.md) の「道具」)。

miseが見るのは `uv` だけで、**Pythonの版は `.python-version`、パッケージは
`uv.lock`** が固定する (`rust` がツールチェーンを、Cargoが crate を見るのと同じ形)。

```sh
mise exec -- uv run python - <<'PY'
import pdfplumber
with pdfplumber.open(".reference/UASL/800055328.pdf") as pdf:
    print(pdf.pages[8].extract_text())   # 0始まりなので9ページ目
PY
```

`pdftotext` や `pdftoppm` は入っていないので、**OCR・ページ画像化・分割結合はできない。**
テキストと表 (`extract_tables()`) の抽出だけ。

## 1. データを手に入れる

Overture Mapsは後述の切り出しコマンドで取れる。国土交通省のデータは手動でダウンロードする。

**配布ページのURLを推測してスクリプトで取得しない。** 公式のAPIが提供されていないため。

ダウンロードしたzipはリネームせず、そのまま置く (`data/` はgit管理外)。

| データ | 入手先 | 配置先 |
| --- | --- | --- |
| 位置参照情報 (大字・町丁目レベル) | [ダウンロードサービス](https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_choose_method.cgi) | `data/isj/oaza/` |
| 位置参照情報 (街区レベル) | 同上 | `data/isj/block/` |
| 行政区域 (N03) ※現在は未配信 | [行政区域データ](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html) | `data/ksj/N03/` |
| PLATEAU 3D都市モデル (CityGML) | [G空間情報センター](https://www.geospatial.jp/ckan/dataset/plateau) | `data/plateau/` |
| 地域メッシュ統計 (人口・世帯) | [e-Stat 統計GIS](https://www.e-stat.go.jp/gis/statmap-search?page=1&type=1) | `data/estat/mesh/` |

```
data/
├── isj/oaza/13000-19.0b.zip      # 東京都
├── isj/block/13000-24.0a.zip
├── estat/mesh/tblT001231E13.zip  # 都道府県ごと (E13 = 東京都)
└── ksj/N03/N03-20260101_GML.zip  # 全国
```

### 地域メッシュ統計で選ぶもの

**統計データの方を落とす。境界データは要らない** (ジオメトリはメッシュコードから
計算する)。落とすのは `tblT......zip` で、**名前を変えずに置く**
(`E` の後ろが都道府県コードで、変換時にこれを見る)。

- 統計調査: 令和2年国勢調査
- 集計単位: 6次メッシュ (125m) — 使ったのは「人口及び世帯」(JGD2011)
- 47都道府県ぶんを個別に落とす。**全国を1つにまとめた配布は無い**

**47回の手作業になる。** 公式のe-Stat APIを使えばコードから回せるが、
アプリケーションIDの発行が要るので、**アプリの形が決まってから**判断する
(2026-09-14の判断)。国勢調査は5年に1度しか更新されないので、
自動化の利きが薄いという事情もある。

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

# 人口メッシュ (47都道府県をまとめて)
cargo run --release --bin mesh_pop_to_geoparquet -- --all \
  ../data/estat/mesh/ ../data/output/
```

座標系は元データのメタデータ (GeoJSONの `crs` / 位置参照情報のメタデータXML) から
実行時に読み取り、PROJでWGS84 (EPSG:4326) に変換する。ハードコードしていない。

### 人口メッシュ (地上リスク用)

**ジオメトリはメッシュコードから計算する。** 地域メッシュ (JIS X 0410) は経緯度から
機械的に決まる方眼で、測量成果ではない。境界データを落とさずに済むので、
**測量法の懸念が原理的に発生しない** (`pipeline/src/mesh.rs`)。

人口密度はメッシュごとの面積で割って出す。**面積は緯度で変わる** ので定数では割れない
(125mメッシュでも沖縄と北海道で1割以上違う)。

全国の実測 (令和2年国勢調査・125mメッシュ):

| | |
| --- | ---: |
| 都道府県 | 47 |
| メッシュ | 2,821,722 |
| **人口合計** | **126,146,099 人** |
| 変換時間 | 4.6 秒 |
| 最適化前 | 345 MB |
| **配信サイズ** | **75 MB** |

**人口合計は令和2年国勢調査の全国人口と一致する。** 都道府県を1つ落としても
ファイル数だけでは気づけないので、合計を突き合わせられるように出している。

秘匿された欄は `*` で来るので欠損にする。0として読むと人口密度が過小に出て、
**地上リスクを実際より低く見せてしまう。**

項目は名前 (`人口（総数）`) で引く。項目コード (`T001231001`) は調査年や統計表で
変わるため。見つからないときは、その統計表にある項目名を並べて落とす。

#### 集約は125mから作る (e-Statの粗いメッシュは落とさない)

e-Statは3次 (1km)・4次 (500m) のメッシュ統計も配っているが、**落とさない。**
125mを束ねれば足りるうえ、47×2回のダウンロードが要らない。

根拠は**秘匿処理**。束ねると秘匿されたセルが欠けるので、一般には集約は危ない。
だが実測すると、**使っている2列は125mの時点で秘匿がゼロ**だった (東京都65,138メッシュ):

| 列 | 秘匿されたメッシュ |
| --- | ---: |
| **人口総数** | **0** |
| **世帯総数** | **0** |
| 0〜14歳人口 | 4,580 (7.0%) |
| 1人世帯数 | 4,580 (7.0%) |

秘匿がゼロなので合計は正確に出る。125mの全国合計が公表値と一致することも裏付けになる。

**内訳 (年齢別・世帯構成別) を使うなら話が別。** 7%のメッシュが秘匿されているので、
束ねると過小になる。そのときはe-Statの粗いメッシュ表を落とすこと。

```sh
# --all のときだけ、全国を1kmに束ねた mesh_pop_1km.parquet も書く
cargo run --release --bin mesh_pop_to_geoparquet -- --all \
  ../data/estat/mesh/ ../data/output/estat/
```

| | 125m | 1km |
| --- | ---: | ---: |
| ファイル | 47 (都道府県ごと) | **1 (全国)** |
| メッシュ | 2,821,722 | 176,964 |
| 配信サイズ | 75 MB | **5.5 MB** |

**1つの1kmメッシュが県境をまたぐ**ので、県ごとに書かず、全県を積んでから確定する。
束ねたあとの人口が元と一致しなければ落とす (`1kmに束ねたら人口が変わりました`)。

密度は**最大**を取る。列の意味は「このメッシュが代表する最大の人口密度」で、
125mでは自身の密度、束ねたものでは中に含まれる125mの最大値。
平均にするとSORAで見たい「いちばん危ないところ」が薄まって消える。

### PLATEAU (3D都市モデル)

**都市コードを渡せば、zipを落とさずに変換できる。**

```sh
# 公式カタログからHTTP Rangeで読む (手元にzipが無くてよい)
cargo run --release --bin plateau_bldg_to_geoparquet -- \
  --city 13103 ../data/output/plateau_bldg_13103.parquet

# 手元のzipから (落としてあるならこちらが速い)
cargo run --release --bin plateau_bldg_to_geoparquet -- \
  ../data/plateau/13103_minato-ku_pref_2025_citygml_1_op.zip \
  ../data/output/plateau_bldg_minato.parquet
```

**zipは展開しないこと。** 港区のCityGMLは2.0GBで、展開すると57,278ファイル・8.85GBになる。
変換器は中央ディレクトリ経由で `udx/bldg/*.gml` (38本) とコードリストだけを取り出す。

### 落とさずに読む (`--city`)

[公式カタログAPI](https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets) が
都市コードとzipのURLを持っている (307都市、うち306都市が建物を収録)。
配信はHTTP Rangeに対応しているので、**中央ディレクトリと必要なエントリだけを取れる**。

全国のzipを合計すると**1,385GB** (最大の浜松市だけで250.8GB)。
落としてから読む道は無いので、Rangeは最適化ではなく前提。

港区での実測 (`pipeline/src/remote_zip.rs`):

| | 転送量 | リクエスト | 所要 |
| --- | ---: | ---: | ---: |
| 素朴に全エントリを列挙 (`by_index_raw`) | 1,013 MB | 3,097 | 3分58秒 |
| **中央ディレクトリから名前だけ取る (`file_names`)** | **276 MB** | **152** | **51秒** |
| (参考) 手元のzipから | — | — | 13秒 |

**`by_index_raw` は1件ごとにローカルヘッダを読みに行く。** 5万を超えるエントリを
舐めるとファイル全体を引きずるので、名前は `file_names()` から取ること。

同じく効くのが**リダイレクトの解決**で、配信URLは302で実体へ飛ぶ。毎回辿ると
1リクエストあたり約1.2秒を余計に払う (256KBの取得が0.15秒→1.33秒)。
最初の1回だけ辿って以降は実体へ直接行く。

手元のzipから作ったものと `--city` で作ったものが**行単位で一致する**ことを確認済み
(51,170棟、差分0件)。

### 全国に広げるといくらになるか (実測)

変換する前に、`plateau_survey` で**中央ディレクトリだけ読んで**規模を測れる。
1都市あたり17MB・6秒程度で済むので、306都市を変換する (84GB・5時間) 前に見積もれる。

```sh
cargo run --release --bin plateau_survey -- --cities 13103,27100   # 指定した都市
cargo run --release --bin plateau_survey -- --sample 30            # zipの大きさ順に等間隔
```

### まとめて変換する

```sh
cargo run --release --bin plateau_bldg_to_geoparquet -- --cities all ../data/plateau_bldg/
```

**途中で止めても続きから再開できる。** 既にあるファイルは飛ばすので、306都市を
何回かに分けて回せる (配信元にも優しい)。1都市で落ちても止めず、最後にまとめて報告する。

```
[1/3] 埼玉県 戸田市
  取得 16.0 MB / 9 リクエスト (zip全体の 3.5%)
28871 棟を読み込みました
...
変換 1 / 既存を飛ばした 2 / 失敗 0
```

### 都市ごとに分けたまま配る (束ねない)

**1つの大きなファイルに束ねない。** 1都市を更新するたびに全体を書き直すことになるし、
5〜10GBのファイルを作り直すのは現実的でない。都市の境界が空間的な区切りとして働くので、
分かれたままでよい。

代わりに**カタログを空間索引として使う**。`catalog.json` は都市ごとに `bbox` を持つので、
UIは**表示範囲と重なるファイルだけ**を `read_parquet([...])` に渡す
(`filesInView` in `web/src/main.ts`)。表示範囲に重なるのは普通1〜3都市。

これはSTAC / Portolanが「カタログで索く」としているのと同じ考え方。

**起動時にparquetは1つも読まない。** 以前は用途の選択肢を作るためにここだけ全ファイルを
走査していた。用途は表示範囲で絞れない (範囲外にしか無い用途を落とすと、その建物が
絞り込みから消える) ので、ファイルが増えるほど**1ファイル1往復のフッター読み**が
積み上がる形になっていた。**語彙をカタログに入れて解消した** (下記)。

E2Eの「表示範囲と重ならない建物データは読みに行かない」がこれを見ている。
大阪へ飛んでも港区のファイルを読まないこと、港区へ戻れば読むことの両方を確かめる
(後者が無いと「そもそも通信していない」だけでも通ってしまう)。
`filesInView` を無効にすると**6リクエスト**出て落ちることを確認済み。

### カタログの項目名はSTACに合わせる

`catalog.json` はこのリポジトリ独自の形だが、**項目名はSTACから借りている**。

| カタログの項目 | 由来 | 中身 |
| --- | --- | --- |
| `table:columns` (`{name, type}`) | [STAC Table拡張](https://github.com/stac-extensions/table) | 列構成 |
| `table:row_count` | 同上 | 件数 |
| `summaries` | [STAC Collection](https://github.com/radiantearth/stac-spec/blob/master/collection-spec/collection-spec.md#summaries) | 列がとりうる値 |

STAC文書そのもの (Catalog / Collection / Item の入れ子) にはしていない。
静的STACは子を別ファイルに置く形なので、**1リクエストで読める**という
いまの前提から外れるため。名前だけ合わせておけば、後でSTACへ移すときに
値を作り直さずに済む。

**`summaries` が用途の選択肢になる。** `build_catalog` が変換後のparquetを1回だけ
走査して、指定した列 (PLATEAUは `usage`、Overtureは `class`) の値を件数の多い順に
書き出す。UIは**語彙を持っている列 = 用途で絞れる列**と見なすので、列名をUI側に
書かずに済む。語彙にする列は `Description::summary_columns`
([pipeline/src/catalog.rs](../pipeline/src/catalog.rs)) の一箇所で決める。

名前や住所のような列を誤って指しても壊れないよう、値が256種類を超えたら
語彙にしない (`MAX_VOCABULARY`)。

港区だけの実測で `catalog.json` は 11.7KB → 12.7KB。用途14種類 (PLATEAU)、
種別38種類 (Overture) が入ってこの差なので、都市を増やしても効かない
(語彙は都市をまたいで重複する)。

#### ただしカタログ自体はデータセット数に比例する

人口メッシュで47件増えたところ、`catalog.json` は **12.7KB → 72KB** になった
(55データセット、**1件あたり約1.3KB**)。増えているのは語彙ではなく、
`table:columns` や `title` / `source` / `source_url` といった
**同じ出所なら全ファイルで同一の項目**が、ファイルの数だけ繰り返される分。

このままPLATEAUを306都市に広げると **460KB前後**になる見込み。起動時に
毎回読む1ファイルとしては重い。

**解くならSTACのCollection / Itemに分けることになる** (共通の項目をCollectionに、
ファイルごとの `bbox` だけをItemに置く形)。1リクエストで読める形から外れるので
今は採っていないが、**460KBに届く前に測り直して判断する。**

サンプル30都市 + 大都市19都市を測った結果、**建物CityGMLは大都市で1都市平均205MB
(最大382MB)、その他では59MB**。「建物がzipに占める割合」は都市によって
**0.02%〜28%**まで振れる (大きいzipほど洪水浸水想定 `fld` などが占めるため)。

### 比率での外挿は当てにならない — 実測した3都市

**zipの大きさから配信データの容量は予測できない。** 実際に変換して確かめた。

| 都市 | 棟数 | GeoParquet | **バイト/棟** | **parquet ÷ 建物CityGML** |
| --- | ---: | ---: | ---: | ---: |
| 港区 | 51,170 | 7.7 MB | 150 B | **3.7%** |
| 大阪市 | 616,115 | 112.7 MB | 182 B | **30.3%** |
| 戸田市 | 28,871 | 6.4 MB | 221 B | **45.5%** |

**parquet ÷ CityGML は12倍も振れる。** 港区のCityGMLにはLOD2 (屋根形状) が入っていて
膨らんでいるが、こちらは `lod0RoofEdge` しか使わないので出力に効かない。
LODの入り方が都市ごとに違うので、**この比率での外挿は成り立たない**。

**安定しているのは「バイト/棟」(150〜221、1.5倍の幅)。** つまり容量を決めるのは
棟数であって、zipの大きさではない。

### 全国だといくらか

上の通り、**棟数が分からないと決まらない**。分かっているのは範囲だけ:

- **上限**: 日本の全建物は約8,000万棟 (地理院 `BldA` の実測値)。
  PLATEAUがその全部を収録していたとしても **8,000万 × 185B ≒ 15 GB**
- PLATEAUは1,741市区町村のうち306市区町村。主要都市を含むので、
  現実には **5〜10 GB** の見当

**この幅は判断を変えない。** R2の無料枠 (10GB) を超えても超過分は月数十円で、
配信先を移す話にはならない ([deploy.md](deploy.md))。
正確な数字が要るなら、20都市ほど実際に変換して合計するしかない (1都市1〜3分)。

### 建物以外に何が入っているか

カタログの `feature_types` を306都市ぶん数えたもの。

| 地物 | 収録都市数 | |
| --- | ---: | --- |
| `bldg` 建築物 | 306 | 現在使っているもの |
| `dem` 地形 | 303 | 標高タイルで代替済み |
| `tran` 交通 (道路) | 302 | |
| `luse` 土地利用 | 291 | |
| `urf` 都市計画決定情報 | 284 | 用途地域 |
| `fld` 洪水浸水想定 | 283 | 大きいzipの主因 |
| `lsld` 土砂災害警戒区域 | 252 | |
| `tnm` 津波 / `htd` 高潮 | 104 / 75 | |
| `wtr` 水部 | 57 | |
| `frn` 都市設備 / `brid` 橋梁 | 49 / 45 | |
| **`veg` 植生** | **34** | 樹木の高さ。**薄い** |
| **`cons` その他の構造物** | **5** | 煙突・鉄塔など。**ほぼ無い** |

**道路・土地利用・用途地域は300都市前後で揃っている**が、
**3Dの障害物になる植生と構造物は薄い**。樹木や鉄塔の高さをPLATEAUに期待できない。

CityGMLのパースは自前で書かず、PLATEAU公式コンバータの
[nusamai-citygml / nusamai-plateau](https://github.com/MIERUNE/PLATEAU-GIS-Converter) に任せている
(MITライセンス。crates.io未公開なのでgit依存、`rev` 固定)。

**用途コードの解決 (`401` → 業務施設) は自前で持っている。** nusamai付属のリゾルバは
ローカルのzipパスを前提にしていて、Rangeで読むときは手元にパスが無いため。
コードリスト (293ファイル・10MB) を先にメモリへ載せる形にしたので、
手元でもリモートでも同じ経路になる。副次的に、手元のzipからの変換も
1分45秒から13秒に縮んだ (zipを開き直さなくなったため)。

使うのは `bldg:lod0RoofEdge` (屋根の外周線) だけ。全建物にある2Dのフットプリントで、
地図表示にはこれと `measuredHeight` があれば足りる。

**数値属性には「不明」を表す番兵値が混ざる。** `measuredHeight = -9999` が4.4%、
`storeysAboveGround = 9999` が14.8%。そのまま通すと絞り込みが壊れ、
row groupの統計まで汚れるのでNULLに落としている。

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

# 海域 (行政区域から海を削るのに使う)
cargo run --release --bin extract_overture -- ocean \
  ../data/overture/ocean_jp.parquet
```

**S3へのアクセスは最小限にすること。** Overtureは `bbox` covering列を持っているので、
そこで絞ればrow group単位で読み飛ばせる (日本全体のdivisionsで約30秒)。
国名や属性だけで絞ると読み飛ばしが効かず、何倍も時間がかかる。

### 海域を削る

Overtureの `division_area` は `class='land'` で絞ってもなお湾を跨いでいる。
そのまま使うと、東京湾の真ん中を逆ジオコーディングしたときに江戸川区が返る。
`base/water` の `subtype='ocean'` (OSMの海岸線由来) で削ると、陸地の形だけが残る。

```sh
cargo run --release --bin clip_admin_ocean -- \
  ../data/overture/divisions_jp.parquet \
  ../data/overture/ocean_jp.parquet \
  ../data/overture/divisions_jp_land.parquet
```

出所がdivisionsと同じOvertureなので、**ODbLの扱いは変わらない**。
全国で約17秒、ピーク約1.5GB。1,741件の市区町村はどれも消えず、
離島 (小笠原村・大島町など) も残る。

**削るのは市区町村だけ。** 国 (1件) や都道府県 (47件) の区画は日本中の海域と範囲が
重なるため、同じことをすると海を丸ごと1ポリゴンに束ねることになる。
最初はそれをやって**メモリを使い切りOSごと落とした**。空間関数の中で確保される
メモリはDuckDBの `memory_limit` の外側にあるので、並列度も控えめに固定してある。

海岸線の細かさを取り込む分、**頂点は約1.5倍になる** (516万 → 797万)。
ただし1点あたりの転送量は変わらない (下記の表を参照)。増えるのは置き場所だけ。

**面積がほぼ0の破片は落とす。** `ST_Difference` は、区画の境界が海域ポリゴンの縁と
重なるところに破片を残す。放っておくとハイライトが海の上に直線を引き、bboxも広がって
`fitBounds` が必要以上に引く (対馬市で南西へ約20km)。実測で、残る破片は最大 3.7e-15
平方度、本物の最小の部分は 8.1e-12 と**3桁離れている**ので、1e-12 で切っている
(全国で254個 / 173市区町村が落ち、本物の部分74,025個はすべて残る)。

```sh
cargo run --release --bin overture_divisions_to_geoparquet -- \
  ../data/overture/divisions_jp_land.parquet ../data/output/overture_admin_jp.parquet
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
| Overture 全国 (59 row groups / 97.6MB) | **1.5 MB** |
| 国土数値情報 全国 (125 row groups / 203MB) | **7.9 MB** |

海域を削る前 (34 row groups / 64.1MB) も **1.5 MB** だった。ファイルが1.5倍になっても
1点あたりの転送量が変わらないのは、row groupの数がそれに追随して増えるため。
**ファイルの大きさではなく、1つのrow groupの大きさが転送量を決める。**

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

### 出所ごとにディレクトリを切る

`data/output/` の配下は**出所ごとに分ける**。`build_catalog` は配下を再帰的に見て、
`file` に起点からの相対パスを入れる。配信先 (R2) のキーはこれがそのまま使われる。

```
data/output/
├── catalog.json
├── estat/     mesh_pop_01..47.parquet
├── isj/       isj_oaza_13.parquet, isj_block_13.parquet
├── overture/  overture_admin_jp.parquet, overture_buildings_minato.parquet
└── plateau/   plateau_bldg_minato.parquet
```

入力側 (`data/isj/`, `data/estat/`, `data/plateau/`) と同じ切り方にしてある。
**1つの出所だけを上げ直せる**ようにするのが目的で、ファイルが数百に増えると効く。

**変えるなら早い方がよい。** 配信先のキーが変わるので、後からだと全部を上げ直すことになる。

```sh
cargo run --release --bin build_catalog -- ../data/output
```

件数・収録範囲 (bbox)・列構成は実際のParquetメタデータから読むので、中身とずれない。
Webアプリはこれを読んでどのデータセットを使うかを決めるので、UI側にファイル名は書かれていない。
地図に出る出典表示もカタログから組み立てるため、配信するデータと必ず一致する。

ファイル名の接頭辞で種別とCollectionが決まる。

| 接頭辞 | 種別 | Collection |
| --- | --- | --- |
| `overture_admin` / `n03` | 行政区域 | `overture-admin` / `ksj-admin` |
| `overture_admin_names` / `n03_names` | 行政区域の名称 (検索用) | `overture-admin-names` / `ksj-admin-names` |
| `overture_buildings` | 建物 | `overture-buildings` |
| `plateau_bldg` | 建物 (PLATEAU)。高さ・用途で絞り込める | `plateau-buildings` |
| `mesh_pop` | 人口メッシュ | `estat-mesh-pop` |
| `isj_oaza` | 大字・町丁目 | `isj-oaza` |
| `isj_block` | 街区 | `isj-block` |

### カタログは STAC 1.1.0

独自形式をやめて [STAC](https://github.com/radiantearth/stac-spec) に寄せた。

```text
catalog.json                ← Catalog。各Collectionへの child リンク
estat-mesh-pop.json         ← Collection。何があるか。ファイル数で増えない
estat-mesh-pop-items.json   ← ItemCollection。ファイル1つずつの href と bbox
estat/mesh_pop_13.parquet   ← 実データ
```

**起動時に読むのは Catalog と Collection だけ。** Item は使う段になって読む。

| | 起動時に読む量 |
| --- | ---: |
| 独自形式 (1ファイル) | 72 KB |
| **STAC** | **9.2 KB** (5ファイル) |

Collectionが件数で増えないようにしてある。**空間範囲は全体の1件だけ**で、
ファイルごとの範囲はItemに置く。両方に書くとCollectionがファイル数に比例して
膨らみ (人口メッシュ47件で2.3KB→8.3KB)、起動時に読むものが増えてしまう。

**Itemは1件1ファイルにしない。** 静的STACの標準的な置き方だが、人口メッシュ47件 +
PLATEAU306都市で350ファイルを超え、1つ読むたびに1往復することになる。
代わりにCollectionごとにItemCollection (STAC APIの `/items` が返すのと同じ形) を1つ置く。

**リンクはすべて配信の起点からの相対**にするため、JSONは実データと同じ起点に平置きする。

独自項目には接頭辞を付ける (STACの作法)。

| 項目 | 中身 |
| --- | --- |
| `duck:kind` | 種別。STACにこの概念が無いので独自に持つ |
| `duck:attribution` | 地図に出す出典の文言。**表示義務があるので縮めない** |
| `duck:attribution_url` | 出典元のURL |
| `duck:geometry_types` | ジオメトリの種類 |
| `duck:mesh_digits` | 地域メッシュの細かさ (コードの桁数) |

### 配布元へのリンク (`rel: "via"`)

**ここにあるのは変換した複製で、原典は配布元にある。** 実物が欲しくなった人が
辿れるよう、STACの `rel: "via"` を出している。仕様上「このEntityが作られる元に
なったメタデータ/データ」を指す関係。

**出典表示のリンク先 (`duck:attribution_url`) とは役割が違う。**
Overtureは出典がガイドページを指すのに対し、配布元はデータのページになる。

| | 何を指すか | どこから来るか |
| --- | --- | --- |
| Collection | その出所のダウンロードページ | `Description::via` |
| **Item** | **そのファイル1つの配布元** | GeoParquetの `duck:via` |

ファイルごとに配布元が違うもの (PLATEAUは都市ごとにzipのURLが違う) は、
**変換時にGeoParquetのKVメタデータへ書く** (`geoparquet::VIA_KEY`)。
分からないとき — 手元のzipから変換した場合など — は**書かない。推測で埋めない。**

`optimize_geoparquet` はKVメタデータを解釈せずそのまま引き継ぐので、
空間パッキングを掛けても残る。

**既知の穴1: `datetime` を埋めていない。**

STACの `datetime` は**元データの時点** (取得・観測・調査の時点) を入れる項目で、
加工した日時ではない。加工日時は `created` / `updated` の方
([STAC Common Metadata](https://github.com/radiantearth/stac-spec/blob/master/commons/common-metadata.md))。

このパイプラインは元データの時点を読んでいないので `null` を入れている。
`null` は本来 `start_datetime` / `end_datetime` とセットで使うものなので、
検証にかけると警告になる。分かっているものはあるので (国勢調査なら令和2年の調査期日、
PLATEAUなら整備年度)、`Description` に持たせるのが宿題。

**既知の穴2: Portolanが求めるデータ側の `README.md` / `AGENTS.md` が無い。**

> Every catalog and collection carries `catalog.json` or `collection.json` for machines,
> plus `README.md` and `AGENTS.md` for people and agents.

[Portolan](https://www.portolan-sdi.org/) が言っているのは**配信するデータの側**に置く
ファイルで、**このリポジトリのAGENTS.mdとは別物**。こちらはコードを書くエージェント向け、
あちらはデータを読むエージェント向け。`build_catalog` が `data/output/` に生成する形が素直。

**準拠を名乗るのはv1.0が見えてから。** v0.2.0で破壊的変更が予告されており、
追従コストが読めない。

## テスト

```sh
cd pipeline
cargo test
```

`tests/real_data.rs` は `data/` 配下の実ファイルを使う統合テスト。
ファイルが無い環境ではスキップされるので、失敗はしない。
