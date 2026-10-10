// コードの読みどころ (docs/tour.html) を作る。`node docs/tour/build.mjs` (リポジトリの起点で)。
//
// ダッシュボードの「見てほしい箇所」から、ファイルを開かずに読めるようにするための読み物。
// **コードの抜き出しはソースから作る** (extract.mjs)。コードを変えたら作り直す。
// 文章はここに書く。何のためか → どう解いたか → 要のコード、の順。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from './extract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = `${ROOT}/docs/tour.html`;

/**
 * @typedef {{ file: string, anchor: string, until?: string, maxLines?: number, note?: string }} Excerpt
 * @typedef {{ id: string, title: string, lead: string, body: string, code?: Excerpt[], docs?: [string, string][] }} Section
 */

/** @type {{ title: string, intro: string, sections: Section[] }[]} */
const PARTS = [
  {
    title: '配り方 (パイプライン)',
    intro:
      '原典を GeoParquet と STAC に変換して、静的な置き場所 (R2) に置く側。ブラウザが <b>必要な範囲だけを HTTP Range で読める形</b>に整えるのが仕事で、速さの大半はここで決まる。',
    sections: [
      {
        id: 'remote-zip',
        title: 'zip を落とさずに中身を取る (remote-zip)',
        lead: 'PLATEAU の CityGML は都市ごとの zip (数百MB〜数GB) で配られる。要るのは建物の GML だけなので、全体を落とすのは無駄が大きい。',
        body: `
<p>zip は<b>末尾に目次 (中央ディレクトリ)</b> があり、各ファイルが何バイト目から始まるかが書いてある。
HTTP Range で末尾を読み、目次から欲しいファイルの位置だけを取れば、全体を落とさずに済む。</p>
<p>Rust の <code>zip</code> クレートは <code>Read + Seek</code> を受け取って読むので、<b>Range で取る処理を
<code>Read + Seek</code> に見せる</b> <code>RangeReader</code> を作った。zip の読み方には手を入れていない。</p>
<ul>
<li>続けて読んでいる間はまとめ読みの大きさを伸ばし、離れた場所へ飛ぶと小さく戻す (往復の回数を減らす)。
ブラウザの DuckDB-WASM も同じ考え方で読んでいる</li>
<li>パイプラインから切り出した単体のクレート (CLI 付き)。<b>API が無くても Range に応える配信元なら使える</b>のが売り</li>
</ul>`,
        code: [
          { file: 'crates/remote-zip/src/range.rs', anchor: 'pub struct RangeReader<F: FetchRange>' },
          { file: 'crates/remote-zip/src/range.rs', anchor: 'impl<F: FetchRange> Read for RangeReader<F>' },
        ],
      },
      {
        id: 'spatial-pack',
        title: '行を場所で並べ、行グループで切る (STR・場所ごと・段ごと)',
        lead: 'Parquet の統計 (最小・最大) は行グループ単位。変換した直後は全国が1つの行グループに入っていて、1点を調べるだけでもジオメトリ列を丸ごと読む。',
        body: `
<p>行を <b>STR (Sort-Tile-Recursive)</b> で空間的に並べ、行グループに切る。行グループごとの bbox の統計で、
画面に掛からない行グループを読み飛ばせる。逆ジオコーディングは全国の行政区域 97.6MB のうち <b>1.5MB</b> で済むようになった。</p>
<p>建物は「重要度の段 (<code>lod</code>)」も持つので、並べ方を2通り比べた。</p>
<ul>
<li><b>段ごと → 場所</b>: 引いた表示 (上の段だけを広く) に向くが、寄った表示で段の数だけ離れた場所を読みに行く</li>
<li><b>場所ごと → 段</b> (採用、<code>CellFirst</code>): 約1MB ぶんの場所に区切り、その中を段で並べる。寄った表示では同じ場所の全段を続けて読み、引いた表示では要らない段を飛ばす</li>
</ul>
<p>行グループの大きさは<b>読み込み1回の重さ</b>で決まる。R2 は1回ごとに約0.45秒待たされ、転送は約2MB/秒なので、
1回余計に読むのは約0.9MB 余計に読むのと同じ重さ。bbox の列を先頭に置くのも、DuckDB が bbox を読んだあとに
行グループの頭へ戻らずに済ませるため。</p>`,
        code: [{ file: 'pipeline/src/repack.rs', anchor: 'fn pack_by_cell(' }],
        docs: [
          ['geoparquet-layout.md', 'GeoParquet の並べ方と読み方 (測った数字・テストで見えていない部分)'],
          ['pipeline.md', 'pipeline.md の「建物の並べ方」(並べ方ごとの表)'],
        ],
      },
      {
        id: 'coarse-lod',
        title: '線の粗い段 — 統合して簡略化した行を「足す」',
        lead: '引いた表示でも道路・鉄道を出したい (「寄らないとデータがあるか見えない」のは使いにくい)。全国の国道を原寸で読むと28MBある。',
        body: `
<p>路線ごとに統合して簡略化した行を、<b>同じファイルの先頭の行グループに足す</b> (<code>lod = 0</code>)。元の行
(<code>lod = 1</code>) は何も変えない。UI は引いた表示で <code>WHERE lod = 0</code> を投げ、行グループの統計で原寸を読み飛ばす。
全国の高速道路が 483KB、鉄道が 329KB で描ける。</p>
<p>どのズームまで粗い段で足りるかは、ファイルに書いた<b>簡略化の許容誤差</b> (100m) から UI が求める
(<a href="#files-in-view">表示範囲からファイルを選ぶ</a>)。ズームの閾値をどこにも書かない。</p>
<p>COGP (Cloud Optimized GeoParquet) は「行を段に<b>分配</b>する (各行は1度だけ)」形だが、道路網では行を選ぶと
網目が途切れ、行ごとに簡略化した列を持つと行数の壁に当たった。そのため「足す」形にした。</p>`,
        code: [{ file: 'pipeline/src/lod.rs', anchor: 'pub fn build_with_coarse_lod_sql(', maxLines: 80 }],
        docs: [['pipeline.md', 'pipeline.md の「COGP を手元のデータで測った」「粗い段」']],
      },
      {
        id: 'quadkey',
        title: '件数でファイルを割る (適応的な QuadKey)',
        lead: 'Overture の建物は日本付近で7,405万棟。同じ細かさで切ると、都心のタイルはメモリに載らず、過疎地は数棟のファイルが数千に増える。',
        body: `
<p>ズーム7の QuadKey から始め、<b>40万棟を超えるタイルだけを4つに割る</b> (最大ズーム12)。返すキーは互いに
接頭辞にならないので、どの建物もちょうど1つのファイルに入る。392ファイルになった。</p>
<p>QuadKey は Rust (どのタイルに入るか) と SQL (DuckDB で振り分ける) の2通りで書いていて、テストで両者の一致を確かめる。
地域メッシュは日本の基準なので、世界のデータである Overture には使わない。</p>`,
        code: [{ file: 'pipeline/src/quadkey.rs', anchor: 'pub fn choose_tiles', maxLines: 60 }],
      },
      {
        id: 'tiers',
        title: '重要度の段と使う条件を「規則・データ」として持つ',
        lead: '建物を「公共施設 / 商業・業務 / 住宅・その他」に分けたい。PLATEAU の用途は19種類、Overture の種別は語彙が違う。',
        body: `
<p>段は<b>列ではなく規則</b>としてカタログに載せる (<code>duck:tiers</code>)。同じ規則から、SQL の式
(<code>rank_sql</code>) と UI の式 (<code>tierExpression</code>) を作る。一覧での絞り込み・色分け・間引きが同じ規則で動く。</p>
<p>使う条件 (商用可か・出典表示・改変の明記・継承) も <code>duck:terms</code> としてデータで持ち、カードと出典の画面に出す。
<b>規約の本文が正本で、これは要約</b>。画面には必ず本文へのリンクを添える。</p>
<p>注意: 間引きのための <code>lod</code> 列だけはファイルに焼き込んでいる。段の規則を変えたら <code>add_building_lod</code> を掛け直す。</p>`,
        code: [{ file: 'pipeline/src/catalog.rs', anchor: 'pub fn rank_sql(' }],
      },
      {
        id: 'stac-layout',
        title: 'STAC の置き方 — 実データの隣に、Item はまとめて',
        lead: 'データは10の出所・32の Collection・760ファイル。カタログの置き方しだいで、読む回数も、他の道具での読みやすさも変わる。',
        body: `
<ul>
<li><b>出所ごとのディレクトリに、実データと Collection の文書を一緒に置く</b> (<code>plateau/</code>・<code>overture/</code> など)。
ルートは <code>catalog.json</code> だけで、その下に出所ごとのサブカタログ。1つの出所だけを上げ直せる</li>
<li><b>Item を1つずつの JSON にしない。</b>Item は stac-geoparquet 1つにまとめ、Collection はそれをアセット (<code>roles: stac-items</code>) で指す</li>
<li>STAC に無い概念 (種別・段の規則・使う条件・出典の文言・版) は <code>duck:*</code> の独自項目で持つ。
地図の道具が読めるリンク (<code>rel: pmtiles</code>・<code>xyz</code>) は標準の拡張 (web-map-links) で書く</li>
<li>相対リンクは<b>その文書からの相対</b>。起点からのパスで書くと、仕様どおりに解決する道具 (STAC Browser など) で壊れる</li>
</ul>`,
        code: [{ file: 'pipeline/src/stac.rs', anchor: 'fn items_href(' }],
      },
      {
        id: 'stac-geoparquet',
        title: 'Item の一覧も GeoParquet に (stac-geoparquet)',
        lead: 'Item (ファイル1つの説明) は761件。Collection ごとの JSON にすると、起動時に何十回も読み込む。',
        body: `
<p>Item を1つの stac-geoparquet にまとめ、<b>Collection ごとに行グループを分ける</b>。画面は Collection を
<code>file_row_number</code> の範囲で読む (<a href="#catalog-load">カタログを読む</a>)。</p>
<p><b>Item の多い Collection を前に、少ないものをフッターの隣に置く。</b>DuckDB-WASM は 16KB 単位で取り、取ったブロックは
使い回すので、起動時に要る行政区域のような1〜2件の Collection はフッターと同じブロックで読める。</p>`,
        code: [{ file: 'pipeline/src/stac_geoparquet.rs', anchor: 'pub fn write(', maxLines: 30 }],
      },
      {
        id: 'i18n',
        title: '英語版のカタログ — 訳の無い日本語はエラー',
        lead: 'カタログの題名・説明を英語でも出したい。訳し忘れは画面で気付きにくい。',
        body: `
<p>日本語の文書から英語の文書を作るとき、題名・説明・名前を対訳表で置き換え、<b>訳の無い日本語が残ったらエラーで止める</b>。
出典の文言 (規約が書き方を指定している) と語彙 (データの中身) は訳さない。STAC の Language extension で
日本語版と英語版を結ぶ。</p>`,
        code: [{ file: 'pipeline/src/stac_i18n.rs', anchor: 'fn translate(' }],
      },
      {
        id: 'building-tiles',
        title: '引いた表示のための建物のタイル (PMTiles)',
        lead: '引いた表示 (段で間引くズーム) を GeoParquet で読むと、都市ごとのファイルを十数個開き、R2 では1分近くかかった。',
        body: `
<p>最後の段 (住宅・その他) を除いた建物を、出所ごとに <b>PMTiles 1つ</b>にする (PLATEAU 123MB・Overture 39MB)。
段 k はズーム 12+k から入れる。MapLibre はタイルを並列に取り、タイルは描く用に簡略化されて量が少ないので、
東京駅 z13 が <b>39秒 → 10秒</b> になった。</p>
<ul>
<li>元の GeoParquet は都市ごとのまま (寄った表示・周辺検索・保存はそちら)。<b>描くことと調べることを別の形式に分けた</b></li>
<li>どの段まで入っているかは、タイル自身のメタデータ (tilestats の <code>lod</code> の最大) からカタログが読む</li>
<li>用途の列は出所で名前が違うので、タイルでは <code>category</code> にそろえる</li>
</ul>
<p>その前に試した「概観 (上の段だけを都道府県ごとに集めた GeoParquet)」は、「1つの出所 = 1つのファイル」が崩れたうえに
タイルより遅かったのでやめた。</p>`,
        code: [{ file: 'pipeline/src/bin/build_building_tiles.rs', anchor: 'fn build_family(', maxLines: 50 }],
        docs: [['format-survey.md', '他の形式の調査と、タイルを測った結果']],
      },
      {
        id: 'pmtiles',
        title: 'PMTiles をヘッダだけ読んでカタログに載せる',
        lead: '地理院の最適化ベクトルタイルは 16.9GB の PMTiles 1つ。複製はせず、カタログに載せて指すだけにしたい。',
        body: `
<p>PMTiles は先頭127バイトのヘッダに、メタデータ (層の一覧・ズーム・範囲) の位置が書いてある。<b>ヘッダとメタデータの
7KB弱だけを Range で読めば</b>カタログを作れる。GeoParquet のフッターから列を読むのと同じ考え方。</p>
<p>外部のものは取ったメタデータをスナップショットとしてリポジトリに置き、カタログを作るときはネットワークに触らない。
テーマ (人向けのまとまり) が層をちょうど覆っていることも検証する。自前の建物のタイルも同じ読み方で読む。</p>`,
        code: [{ file: 'pipeline/src/pmtiles.rs', anchor: 'pub fn read_local(' }],
      },
    ],
  },
  {
    title: '使い方 (アプリ)',
    intro:
      'ブラウザの中で DuckDB-WASM が GeoParquet を Range で読み、MapLibre で描く側。<b>読む回数と量を減らす</b>工夫と、カタログ (STAC) から画面を組む仕組み。',
    sections: [
      {
        id: 'catalog-load',
        title: 'カタログを読む — まとめ1つと、Item を行番号の範囲で',
        lead: 'カタログを文書ごとに辿ると、起動だけで3段・43回の読み込みになっていた。',
        body: `
<p>起動時は<b>まとめ (<code>collections.json</code>) 1つ</b>だけを読み、そこから Collection を組み立てる。
相対リンクは「その文書からの相対」で解決する (起点からのパスにすると、仕様どおりに解決する道具で壊れる)。</p>
<p>Item は stac-geoparquet から、<b>その Collection の行グループだけ</b>を読む。行グループの統計で Collection の名前を比べたいが、
DuckDB は文字列の統計を頭の数文字でしか比べないため、<code>parquet_metadata</code> から Collection ごとの行番号の範囲を求め、
<code>file_row_number</code> で絞る。</p>`,
        code: [{ file: 'web/src/lib/duckdb.ts', anchor: 'const collectionRows' }],
      },
      {
        id: 'files-in-view',
        title: '表示範囲からファイルを選び、ズームから段を決める',
        lead: 'DuckDB は渡されたファイルを全部開く (1つにつき数回の往復)。PLATEAU だけで306ファイルある。',
        body: `
<p><b>カタログを空間の索引として使う。</b>Item の bbox と画面を比べ、重なるファイルだけを DuckDB に渡す。
収録範囲が分からないファイルは落とさない (判断材料が無いので読む)。</p>
<p>線の粗い段を使うズームは、カタログにある許容誤差から求める: 誤差が2画素以下に収まるズームまでは粗い段で足りる。</p>`,
        code: [
          { file: 'web/src/lib/sources.ts', anchor: 'export function filesInView(' },
          { file: 'web/src/lib/sources.ts', anchor: 'export function coarseLodUntilZoom(' },
        ],
      },
      {
        id: 'buildings',
        title: '建物の出し方 — 全部 / 重要な段だけ (タイル) / 整備範囲',
        lead: '東京駅のズーム13を全部描くと22万棟・31MB。引くほど画面の面積は4倍ずつ増える。',
        body: `
<p><b>1ズーム引くごとに1段減らす</b> (表示量「標準」なら z15〜 全部、z14 公共施設と商業・業務、z13 公共施設、それより引くと整備範囲の1kmメッシュ)。
<b>どこまで出しているかを必ず言う</b> (黙って減らすと「住宅が無い」と読まれる)。</p>
<p>段で間引くズームでは、タイルに入っている段なら GeoParquet を問い合わせずに<b>タイルの層</b>を出す。タイルは数えられないので、
件数の代わりに「表示しています · 公共施設のみ」と段だけを言う。</p>
<ul>
<li>絞り込み (高さ・用途・段) は、問い合わせと同じ条件をスタイルの filter で書く</li>
<li>塗りは GeoJSON の層と同じ規則 (<code>BUILDING_COLOR_BY_*</code>) から作る。出所の番号と段の順位をタイルの属性に置き換えるだけ</li>
</ul>`,
        code: [
          { file: 'web/src/ui/layers/buildings.ts', anchor: 'const buildingDepth' },
          { file: 'web/src/ui/layers/buildings.ts', anchor: 'const tileFilter' },
          { file: 'web/src/ui/map.ts', anchor: 'export function tileColor(' },
        ],
      },
      {
        id: 'nearby',
        title: '周辺検索 — メートルに直してから距離で判定',
        lead: '「この点・建物・線から○m以内に何があるか」を、画面に出していないデータも含めて全部に聞きたい。経緯度のままでは距離が測れない。',
        body: `
<p>起点の近くの緯度で<b>度をメートルに直す</b> (<code>ST_Affine</code>) 。1km以内なら平面とみなした誤差は小さい。
先に bbox で行グループを絞り、そのうえで <code>ST_DWithin</code> で判定する。当たった線は範囲で切り取って描く
(区間ごと描くと範囲の外まで伸びて、どこが当たったか読めない)。</p>
<p>鉄道を起点にしたときは<b>押した地点の前後1.5km</b>だけを起点にする。路線全体の沿線を丸ごと調べると R2 で1分半かかり、
知りたいのはふつう駅や駅と駅の間くらい (利用者の判断)。行グループは都心で約2km四方あり、それより細い範囲は並べ方を変えないと絞れない。</p>`,
        code: [
          { file: 'web/src/lib/nearby.ts', anchor: 'export function nearbyFrame(' },
          { file: 'web/src/lib/nearby.ts', anchor: 'function nearbyCondition(' },
          { file: 'web/src/lib/clip.ts', anchor: 'export function clipLines(' },
        ],
      },
      {
        id: 'gsi-vector',
        title: '地理院のベクトルタイルを、データだけで描く',
        lead: '地理院の最適化ベクトルタイルには配布元のスタイルがあるが、123層あって重く、このアプリの見た目にも合わない。',
        body: `
<p>カタログに写した<b>層ごとの形の種類 (面・線・点)</b> から、層ごとに描き方を決める。テーマ (人向けのまとまり) ごとに
出し入れでき、出るズームはタイル側の minzoom・maxzoom に従う。</p>`,
        code: [{ file: 'web/src/lib/tiles.ts', anchor: 'function vectorLayerSpecs(', maxLines: 40 }],
      },
      {
        id: 'gsi-dem',
        title: '地理院の標高 (独自形式) を読み込むときに直す',
        lead: '地理院の標高タイルは Terrain-RGB に似た独自形式で、そのまま MapLibre に渡すと海に8万mの針が立つ。',
        body: `
<p>独自のプロトコルで画像を受け取り、<b>1画素ずつ高さに直して Terrarium に詰め直す</b>。値なし (海など) は 0m、
負の値 (2の補数) は正しく負にする。背景地図と地形はカタログから組み立てる。</p>`,
        code: [{ file: 'web/src/lib/tiles.ts', anchor: 'export function gsiDemHeight(' }],
      },
      {
        id: 'wkb',
        title: 'DuckDB の返すジオメトリ (WKB) を自前で読む',
        lead: 'SQL でジオメトリを GeoJSON の文字列にしてから JSON.parse すると、文字列を作って読むぶん遅い。',
        body: `
<p>DuckDB-WASM はジオメトリの列をそのまま返すと GeoArrow (WKB) で返す。<b>WKB を直接 GeoJSON のジオメトリに読む</b>小さな読み手を書いた。
単体テストの見本は DuckDB の spatial で作った (WKB と GeoJSON の組)。</p>`,
        code: [{ file: 'web/src/lib/wkb.ts', anchor: '  geometry(): GeoJSON.Geometry {', maxLines: 40 }],
      },
      {
        id: 'draw-shape',
        title: 'データの描き方の共通の形',
        lead: '建物・人口メッシュ・鉄道・道路・送電線と川は、地図が動くたびに引き直す。読み込み中に地図がまた動くと、古い結果を描いてしまう。',
        body: `
<p>どの描き方も同じ形をとる: <b>世代を最初に進める</b> → 出していなければ空にして終わる (既に空なら <code>setData</code> しない)
→ 表示範囲で引き、世代が変わっていなければ描く。世代を進めるのを早期 return より後にしたら、外したあとに前の結果を描いた (実際に起きた)。</p>`,
        code: [{ file: 'web/src/ui/layers/context.ts', anchor: '**データの描き方**', until: ' */' }],
      },
      {
        id: 'export',
        title: 'ブラウザの中で GeoParquet を書き、出典と規約を入れる',
        lead: '「この範囲を保存」で、見ている範囲のデータを持ち帰れるようにしたい。持ち帰ったファイルからも出所と条件が分かるべき。',
        body: `
<p>DuckDB-WASM の <code>COPY … TO</code> でブラウザの中で GeoParquet を書き、<b>出典・規約・配布元を KV メタデータに入れる</b>。
ライセンスを持ち回れるようにするのが、このリポジトリの軸の1つ。</p>`,
        code: [{ file: 'web/src/lib/duckdb.ts', anchor: 'const exportParquet = async' }],
      },
      {
        id: 'layer-order',
        title: '一覧の順番を地図の層へ写す',
        lead: '一覧でデータの重ね順をドラッグで変えられる。地図の層は1つのデータに複数ある (塗り・縁・タイル)。',
        body: `
<p>区分 (データ・地図タイル) ごとに目印の層を置き、<b>一覧の下から順に目印の直下へ積み直す</b>。行ごとに「どの地図の層を持つか」を
持たせてあり、建物は引いた表示のタイルの層も一緒に動く。地図に無い層は飛ばす。</p>`,
        code: [{ file: 'web/src/ui/layer-list.ts', anchor: 'const applyOrder' }],
      },
      {
        id: 'hover',
        title: '吹き出しを層ごとの表で1つの仕掛けに',
        lead: '建物・鉄道・道路・メッシュ・周辺検索の結果など、層ごとに見せたい項目が違う。',
        body: `
<p><b>層の ID → 吹き出しの中身</b> の表を1つ持ち、その点でいちばん上にある地物の層で引く。同じものなら作り直さない
(区間の境でちらつくため)。指で押しても出る。地理院のタイルは層が多いので表に書かず、層の対応から引く。
引いた表示のタイルの建物は、層 (= 出所) から出所と段の名前を補って、GeoJSON の建物と同じ吹き出しにする。</p>`,
        code: [{ file: 'web/src/ui/hover.ts', anchor: 'const HOVER_LAYERS', maxLines: 30 }],
      },
      {
        id: 'dev-server',
        title: '手元の配信をオブジェクトストレージと同じ流儀に (と、R2 の遅さの再現)',
        lead: 'Vite の配信は Range の扱いに穴があり (bytes=0-0 に206を返しながら Content-Range を付けない)、DuckDB-WASM がちょうどそこを踏む。',
        body: `
<p>データの配信を丸ごと引き取り、R2 と同じ流儀 (HEAD・Range・CORS のヘッダ) で返す。開発サーバーと本番ビルドの確認用サーバーの両方で効く。</p>
<p>手元では往復の待ちがほぼ0なので、読み込みの回数が増えても気付けない。<code>DATA_LATENCY_MS=450 DATA_BANDWIDTH_MBPS=16</code> で
<b>R2 と同じ待ちを足せる</b>。<code>DATA_DIR</code> で配るディレクトリを差し替えれば、並べ方を変えたデータをアプリはそのままで比べられる。</p>`,
        code: [{ file: 'web/vite.config.ts', anchor: 'function serveLikeObjectStorage(', maxLines: 70 }],
      },
      {
        id: 'stac-browser',
        title: 'STAC Browser にパッチを1つ当ててビルドする',
        lead: 'カタログを地図ではなくページで辿れるよう、STAC Browser 5.1.0 を /catalog/ に置いている。',
        body: `
<p>相対の <code>rel: items</code> がページ基準で解決されて 404 になる不具合があり、パッチを1つ当ててビルドする
(<code>stac-browser/items-base.patch</code>・<code>build.sh</code>)。Item を stac-geoparquet に移して <code>rel: items</code> が無くなったので、
今は効く場面が無い。上流で直ったら外す。</p>`,
      },
    ],
  },
];

/** ダッシュボードの表に出す1行の要約。読み物の節へのリンクに添える。 */
const SUMMARY = {
  'remote-zip': 'HTTP Range を <code>Read + Seek</code> に見せ、zip の中身を落とさず取る。<b>単体のクレートに切り出した</b> (CLI 付き)',
  'spatial-pack': 'STR で並べ、<b>場所ごとに区切って段の境で行グループを切る</b>。読み飛ばしが効くかはここで決まる',
  'coarse-lod': '線の粗い段: 名前で束ねて簡略化した行を<b>同じファイルに足す</b> (原寸は消さない)',
  quadkey: '件数の多いタイルだけを割る QuadKey。Rust と SQL の2通りで書き、テストで一致を見る',
  tiers: '重要度の段と使う条件を<b>規則・データ</b>として持ち、SQL とカタログの両方へ出す',
  'stac-layout': '実データの隣に Collection を置き、Item はまとめる。<code>duck:*</code> の独自項目',
  'stac-geoparquet': 'Item を Collection ごとの行グループに。<b>件数の少ないものをフッターの隣に</b> (16KB 単位で読まれるため)',
  i18n: '英語版とまとめ。<b>訳の無い日本語はエラー</b>',
  'building-tiles': '引いた表示のための建物の <b>PMTiles</b>。段の上限はタイル自身から読む',
  pmtiles: 'PMTiles を<b>ヘッダとメタデータだけ</b>読んでカタログへ (16.9GB のうち 7KB)',
  'catalog-load': 'まとめ1つから Collection を作り、Item は<b>行番号の範囲</b>で読む',
  'files-in-view': '<b>表示範囲に重なるファイルだけ</b>を DuckDB に渡し、ズームから粗い段か原寸かを決める',
  buildings: '1ズーム引くごとに1段減らす間引き。<b>引いた表示はタイルで描く</b> (件数は寄った表示でだけ)',
  nearby: '周辺検索: 起点付近を<b>メートルに直してから</b>距離で判定。鉄道は押した地点の前後1.5km',
  'gsi-vector': '地理院のタイルを<b>データだけ</b>読み、形の種類から描く',
  'gsi-dem': '地理院の標高 (独自形式) を読み込むときに Terrarium へ詰め直す',
  wkb: 'DuckDB が返す GeoArrow (WKB) を<b>自前で読む</b> (GeoJSON の文字列を作らない)',
  'draw-shape': 'データの描き方の共通の形 (<b>世代を最初に進める</b>・空なら setData しない)',
  export: 'ブラウザの中で GeoParquet を書き、<b>出典と規約を KV に入れる</b>',
  'layer-order': '一覧の順番を地図の層へ写す (区分ごとの目印の層の直下に積む)',
  hover: '吹き出しを<b>層ごとの表</b>で1つの仕掛けに (周辺検索の結果やタイルの建物にも)',
  'dev-server': '手元の配信をオブジェクトストレージと同じ流儀に。<b>R2 の遅さを再現</b>できる',
  'stac-browser': 'STAC Browser 5.1.0 に<b>パッチを1つ</b>当ててビルドする。上流で直ったら外す',
};

// ---- HTML ------------------------------------------------------------------------------

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function excerptHtml(spec) {
  const r = extract(ROOT, spec);
  const width = String(r.end).length;
  // 共通の字下げを取る (クラスや関数の中から抜き出したとき、全行が右へずれるので)。
  const indent = Math.min(...r.lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  const body = r.lines
    .map((line, i) => `<span class="ln">${String(r.start + i).padStart(width)}</span>${escape(line.slice(indent))}`)
    .join('\n');
  const more = r.truncated ? `<div class="more">… 続きは <a href="../${r.file}">${r.file}</a> で</div>` : '';
  return `<figure class="code">
<figcaption><a href="../${r.file}">${r.file}</a> <span class="lines">${r.start}〜${r.end} 行</span></figcaption>
<pre><code>${body}</code></pre>${more}
</figure>`;
}

function sectionHtml(section) {
  const code = (section.code ?? []).map(excerptHtml).join('\n');
  const docs = section.docs?.length
    ? `<p class="docs">関連: ${section.docs.map(([href, label]) => `<a href="${href}">${label}</a>`).join(' · ')}</p>`
    : '';
  return `<section class="card" id="${section.id}">
<h3><a class="anchor" href="#${section.id}">#</a>${section.title}</h3>
<p class="lead">${section.lead}</p>
${section.body.trim()}
${docs}
${code}
</section>`;
}

const toc = PARTS.map(
  (part) =>
    `<li>${part.title}<ol>${part.sections.map((s) => `<li><a href="#${s.id}">${s.title}</a></li>`).join('')}</ol></li>`,
).join('');

const html = `<!doctype html>
<!--
  コードの読みどころ。**このファイルは生成物**: docs/tour/build.mjs を直して \`node docs/tour/build.mjs\` で作り直す。
  コードの抜き出しはソースから取るので、コードを変えたら作り直す (行番号がずれる)。
-->
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>duck-geocoder コードの読みどころ</title>
    <style>
      :root { --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781; --hairline:#e1e0d9; --accent:#2a78d6; --code:#f1f0ec; }
      @media (prefers-color-scheme: dark) {
        :root { --page:#0d0d0d; --surface:#1a1a19; --ink:#fff; --ink-2:#c3c2b7; --muted:#898781; --hairline:#2c2c2a; --accent:#3987e5; --code:#141413; }
      }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 1.25rem 1.5rem 3rem; font-family: system-ui, 'Hiragino Sans', 'Noto Sans JP', sans-serif;
        color: var(--ink); background: var(--page); line-height: 1.7; }
      main { max-width: 60rem; margin: 0 auto; }
      a { color: var(--accent); }
      header { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: baseline; margin-bottom: 1rem; }
      h1 { font-size: 1.4rem; margin: 0; }
      h2 { font-size: 1.15rem; margin: 2rem 0 0.25rem; }
      h3 { font-size: 1.05rem; margin: 0 0 0.4rem; }
      .meta, .intro, .lines, .docs { color: var(--ink-2); font-size: 0.9rem; }
      .card { background: var(--surface); border: 1px solid var(--hairline); border-radius: 0.6rem; padding: 1rem 1.2rem; margin: 0.9rem 0; }
      .lead { color: var(--ink-2); margin: 0 0 0.6rem; }
      .anchor { color: var(--muted); text-decoration: none; margin-right: 0.35rem; }
      code { font-size: 0.85em; padding: 0 0.25rem; border-radius: 0.2rem; background: var(--hairline); }
      figure.code { margin: 0.8rem 0 0; }
      figcaption { font-size: 0.85rem; margin-bottom: 0.2rem; }
      pre { margin: 0; padding: 0.7rem 0.9rem; overflow-x: auto; background: var(--code); border: 1px solid var(--hairline);
        border-radius: 0.4rem; font-size: 0.8rem; line-height: 1.5; }
      pre code { padding: 0; background: none; font-size: inherit; }
      .ln { display: inline-block; color: var(--muted); user-select: none; margin-right: 1rem; text-align: right; }
      .more { font-size: 0.85rem; color: var(--ink-2); margin-top: 0.2rem; }
      nav.toc { background: var(--surface); border: 1px solid var(--hairline); border-radius: 0.6rem; padding: 0.6rem 1.2rem; }
      nav.toc ol { margin: 0.2rem 0; padding-left: 1.4rem; }
      nav.toc > ol { padding-left: 1rem; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>コードの読みどころ</h1>
        <span class="meta"><a href="board.html">← ダッシュボード</a> · このリポジトリ独自の判断が入っているところを、ファイルを開かずに読めるようにしたもの</span>
      </header>
      <p class="intro">各項目は <b>何のための仕組みか → どう解いたか → 要のコード</b> の順。コードはソースから抜き出していて、見出しのファイル名から元のファイルを開ける。
      測った数字の詳しい表は <a href="geoparquet-layout.md">geoparquet-layout.md</a> と <a href="pipeline.md">pipeline.md</a> にある。</p>
      <nav class="toc" aria-label="目次"><ol>${toc}</ol></nav>
${PARTS.map((part) => `<h2>${part.title}</h2>\n<p class="intro">${part.intro}</p>\n${part.sections.map(sectionHtml).join('\n')}`).join('\n')}
    </main>
  </body>
</html>
`;

writeFileSync(OUTPUT, html);
console.log(`${OUTPUT} を書きました (${PARTS.reduce((n, p) => n + p.sections.length, 0)} 項目)`);

// ---- ダッシュボードの表 ------------------------------------------------------------------
//
// board.html の「見てほしい箇所」のうち、目印 (`tour:begin` / `tour:end`) で挟んだ行を作り直す。
// 項目を足したり名前を変えたりしたときに、表と読み物が食い違わないようにするため。
const BOARD = `${ROOT}/docs/board.html`;
const BEGIN = '<!-- tour:begin (docs/tour/build.mjs が書く。手で直さない) -->';
const END = '<!-- tour:end -->';
const board = readFileSync(BOARD, 'utf8');
const from = board.indexOf(BEGIN);
const to = board.indexOf(END);
if (from < 0 || to < from) throw new Error(`${BOARD} に目印がありません (${BEGIN} … ${END})`);
const rows = PARTS.map((part) => {
  const head = `            <tr class="group"><th colspan="2">${part.title}</th></tr>`;
  const body = part.sections.map((s) => {
    if (!SUMMARY[s.id]) throw new Error(`ダッシュボードの要約がありません: ${s.id}`);
    return `            <tr>\n              <td><a href="tour.html#${s.id}">${s.title}</a></td>\n              <td>${SUMMARY[s.id]}</td>\n            </tr>`;
  });
  return [head, ...body].join('\n');
}).join('\n');
writeFileSync(BOARD, `${board.slice(0, from + BEGIN.length)}\n${rows}\n            ${board.slice(to)}`);
console.log(`${BOARD} の「見てほしい箇所」を書き直しました`);
