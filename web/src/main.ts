import './style.css';
import * as duckdb from '@duckdb/duckdb-wasm';
import {
  MapLibreMap,
  GeoJSONSource,
  Popup,
  AttributionControl,
  NavigationControl,
  TerrainControl,
  setWorkerUrl,
  type RasterTileSource,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibreは既定では new URL(`./${名前}`, import.meta.url) でワーカーを探すが、
// 名前が変数なのでバンドラが静的に検出できず、ビルド成果物に出力されない。
// 結果、本番だけGeoJSONソースが一切描画されなくなる (地図タイルもポップアップも
// 動くので気付きにくい)。?worker&url で Vite にワーカーとしてバンドルさせ、
// 解決済みのURLを setWorkerUrl で明示する。
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(maplibreWorkerUrl);

/**
 * カタログは [STAC 1.1.0](https://github.com/radiantearth/stac-spec)。
 * Rust側の build_catalog がGeoParquetのメタデータから生成するので、
 * 変換したファイルが増えればUIは自動で追随する。
 *
 * ```text
 * catalog.json                ← Catalog。各Collectionへの child リンク
 * estat-mesh-pop.json         ← Collection。何があるか。件数で増えない
 * estat-mesh-pop-items.json   ← ItemCollection。ファイル1つずつの href と bbox
 * ```
 *
 * **起動時に読むのは Catalog と Collection だけ。** Item は使う段になって読む。
 * 1ファイルに全部入れていた頃は、人口メッシュ47件で72KBまで膨らんでいた。
 */
interface StacLink {
  rel: string;
  href: string;
  type?: string;
  title?: string;
}

type DatasetKind =
  | 'admin'
  | 'admin_names'
  | 'oaza'
  | 'block'
  | 'buildings'
  | 'plateau_buildings'
  | 'population_mesh';

/** STAC Collection。`duck:` の付いたものはSTACに無い独自項目。 */
interface StacCollection {
  id: string;
  title?: string;
  /** 種別。UIが扱いを切り替えるのに使う。STACにこの概念は無い。 */
  'duck:kind': DatasetKind;
  /** 地図に出す出典の文言。**表示義務があるので縮めない。** */
  'duck:attribution': string;
  'duck:attribution_url': string;
  /** 地域メッシュの細かさ (メッシュコードの桁数)。メッシュ以外には無い。 */
  'duck:mesh_digits'?: number;
  extent: { spatial: { bbox: (number | null)[][] } };
  /**
   * 列がとりうる値。列名 → 値 (件数の多い順)。語彙を持たない列は入っていない。
   *
   * **絞り込みの選択肢はここから作る。** データを走査して作ると、
   * 表示範囲で絞れない (範囲外にしか無い用途を落とすと、その建物が
   * 絞り込みから消える) ため、ファイルの数だけ往復することになる。
   */
  summaries?: Record<string, string[]>;
  item_assets?: { data?: { 'table:columns'?: { name: string; type: string }[] } };
  links: StacLink[];
}

/** STAC Item。1つのGeoParquetに対応する。 */
interface StacItem {
  id: string;
  bbox?: number[];
  properties: { 'table:row_count'?: number };
  assets: { data: { href: string } };
}

/** Collectionを扱いやすい形にしたもの。Itemは呼ばれるまで読まない。 */
interface Collection {
  id: string;
  kind: DatasetKind;
  title: string;
  attribution: string;
  attributionUrl: string;
  /** 収録範囲 (Item全部の和)。Itemを読まずに分かる。 */
  bbox: Bbox | null;
  summaries: Record<string, string[]>;
  /** 列名。何で絞れるかをこれで決める。 */
  columns: Set<string>;
  /** 地域メッシュの細かさ (メッシュコードの桁数)。メッシュ以外は undefined。 */
  meshDigits: number | undefined;
  /** Itemを読む。**Collectionごとに1回だけ**通信する。 */
  items: () => Promise<StacItem[]>;
}

/**
 * GeoParquetの置き場所。
 *
 * 開発時は同一オリジンの /data/ (vite.config.ts が data/output/ を配信する)。
 * 公開時はオブジェクトストレージのURLを VITE_DATA_BASE_URL で渡す。
 * 別オリジンになるので、置き場所側のCORSで
 * `Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges`
 * を返すこと。これが無いとDuckDB-WASMがファイルサイズを取得できず、
 * 部分取得に失敗して黙って全件ダウンロードに落ちる。
 */
const DATA_BASE_URL = (
  import.meta.env.VITE_DATA_BASE_URL ?? `${import.meta.env.BASE_URL}data`
).replace(/\/$/, '');

function dataUrl(file: string): string {
  return new URL(`${DATA_BASE_URL}/${file}`, window.location.href).toString();
}

/** E2Eテストのために公開するもの。アプリ本体はこれを参照しない。 */
interface TestHooks {
  __map?: MapLibreMap;
  __dataUrl?: (file: string) => string;
}

// データの実際のURLは、テストがデータの有無を確かめるのに要る。
// 初期化に失敗した場合でも参照できるよう、ここで公開しておく
// (データが無くて初期化できないこと自体が、判定したい状態のひとつなので)。
(window as unknown as TestHooks).__dataUrl = dataUrl;

/**
 * DuckDB-WASM本体の置き場所。
 *
 * バンドルには含めず、アプリと同じオリジンの /duckdb/ から配る。
 * duckdb-eh.wasm が35MB、duckdb-mvp.wasm が40MBあり、バンドラに通すと
 * ホスティングのファイルサイズ制限に当たるため (Cloudflare Pagesは25MiBまで)。
 * 開発時は vite.config.ts が node_modules から配信し、ビルド時は同じ場所から
 * dist/duckdb/ にコピーされる。別の場所に置きたい場合は
 * VITE_DUCKDB_BASE_URL で上書きできる。
 */
const DUCKDB_BASE_URL = (
  import.meta.env.VITE_DUCKDB_BASE_URL ?? `${import.meta.env.BASE_URL}duckdb`
).replace(/\/$/, '');

function duckdbUrl(file: string): string {
  return new URL(`${DUCKDB_BASE_URL}/${file}`, window.location.href).toString();
}

/**
 * spatialなど拡張の置き場所。DuckDB本体と同じく自前配信にしてある
 * (`web/duckdb-extensions.ts` が実行時にDuckDB本体のバージョンへ合わせて取得し、
 * `web/vite.config.ts` が `duckdb/extensions/` として配る)。
 *
 * 本家 (extensions.duckdb.org) にあるのと同じ署名済みファイルをそのまま
 * 置いているだけなので、`allowUnsignedExtensions` は要らない。
 */
const DUCKDB_EXTENSIONS_URL = duckdbUrl('extensions');

async function fetchStac<T>(href: string): Promise<T> {
  const response = await fetch(dataUrl(href));
  if (!response.ok) {
    throw new Error(
      `${href} が読めません (${response.status})。` +
        '`cargo run --bin build_catalog -- ../data/output` を実行してください。',
    );
  }
  return (await response.json()) as T;
}

/**
 * Catalogから全Collectionを読む。
 *
 * Collectionは**ファイルが増えても大きくならない** (収録範囲は全体の1件だけ、
 * 列構成と語彙は出所ごとに1つ) ので、起動時に全部読んでよい。
 * ファイル1つずつの情報を持つItemは、使う段になってから読む。
 */
async function fetchCollections(): Promise<Collection[]> {
  const catalog = await fetchStac<{ links: StacLink[] }>('catalog.json');
  const children = catalog.links.filter((link) => link.rel === 'child');
  const documents = await Promise.all(
    children.map((link) => fetchStac<StacCollection>(link.href)),
  );
  return documents.map(toCollection);
}

function toCollection(document: StacCollection): Collection {
  // 空間範囲は「先頭が全体」。ジオメトリを持たないデータセットは null が並ぶ。
  const [extent] = document.extent.spatial.bbox;
  const bbox =
    extent?.length === 4 && extent.every((value) => typeof value === 'number')
      ? (extent as Bbox)
      : null;

  const itemsHref = document.links.find((link) => link.rel === 'items')?.href;
  let items: Promise<StacItem[]> | undefined;

  return {
    id: document.id,
    kind: document['duck:kind'],
    title: document.title ?? document.id,
    attribution: document['duck:attribution'],
    attributionUrl: document['duck:attribution_url'],
    meshDigits: document['duck:mesh_digits'],
    bbox,
    summaries: document.summaries ?? {},
    columns: new Set(
      (document.item_assets?.data?.['table:columns'] ?? []).map((column) => column.name),
    ),
    items: () =>
      (items ??= itemsHref
        ? fetchStac<{ features: StacItem[] }>(itemsHref).then((collection) => collection.features)
        : Promise.resolve([])),
  };
}

/** Itemを配信パスと収録範囲の組にする。 */
function itemFiles(items: StacItem[]): { file: string; bbox: Bbox | null }[] {
  return items.map((item) => ({
    file: item.assets.data.href,
    bbox: item.bbox?.length === 4 ? (item.bbox as Bbox) : null,
  }));
}

/**
 * 検索結果は2種類ある。
 * - admin: 行政区域。面を持つので選択するとポリゴンをハイライトする。
 * - oaza:  大字・町丁目(位置参照情報)。代表点しか無いのでその地点へ飛ぶ。
 */
type SearchResult =
  | { kind: 'admin'; label: string; adminId: string }
  | { kind: 'oaza'; label: string; lon: number; lat: number };

/** 範囲 [xmin, ymin, xmax, ymax] (WGS84)。 */
type Bbox = [number, number, number, number];

/** 地図の表示範囲。 */
interface ViewBounds {
  west: number;
  south: number;
  east: number;
  north: number;
  /** 画面中心。傾けると bounds の中心とはずれるので、地図から直接もらう。 */
  centerLon: number;
  centerLat: number;
}

/**
 * 初回に一度だけ実行し、以降は同じ結果を返す。
 * 並行して呼ばれても実行は1回で、両方とも完了を待てる。
 */
function once(run: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | undefined;
  return () => (started ??= run());
}

/** 範囲を、地図に描ける矩形のポリゴンにする。 */
function bboxFeatureCollection([west, south, east, north]: Bbox): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
      },
    ],
  };
}

/** 複数の範囲を包む範囲。データセットが分割されていても1つに畳める。 */
function unionBbox(boxes: Bbox[]): Bbox | null {
  return boxes.reduce<Bbox | null>(
    (union, box) =>
      union === null
        ? box
        : [
            Math.min(union[0], box[0]),
            Math.min(union[1], box[1]),
            Math.max(union[2], box[2]),
            Math.max(union[3], box[3]),
          ],
    null,
  );
}

/**
 * 建物データの出所。出所ごとに別のビューを持つ。
 *
 * OvertureとPLATEAUは列構成が違うので、1つのビューに束ねられない
 * (`read_parquet([a, b])` はスキーマが揃っていることを前提にする)。
 *
 * **何で絞れるかは列の有無から決める。** 出所ごとに決め打ちすると、
 * 「高さがあるのに立体では見えるのに絞れない」といった食い違いが起きる。
 * カタログはGeoParquetの実際のメタデータから作られているので、そちらに従う。
 */
interface BuildingSource {
  /** Collectionの識別子。 */
  id: string;
  /** UIに出す名前。 */
  label: string;
  /**
   * このデータセットを構成するファイルと、それぞれの収録範囲。
   *
   * **`ensure()` を呼ぶまで空。** Itemを読まないと分からないため。
   * 収録範囲の枠 (`bbox`) と絞り込みの選択肢はCollectionだけで作れるので、
   * 寄って実際に引くまでItemを取りに行かずに済む。
   */
  files: { file: string; bbox: Bbox | null }[];
  /** 収録範囲 (ファイル全部の和)。Collectionが持っているので最初から分かる。 */
  bbox: Bbox | null;
  /** 高さの列があるか。あれば高さで絞れるし、立体の高さにも使える。 */
  hasHeight: boolean;
  /** 用途・種別を表す列。無ければ null。出所によって列名が違う。 */
  categoryColumn: string | null;
  /** 用途の選択肢 (件数の多い順)。カタログの語彙をそのまま使う。 */
  usages: string[];
  /** 引く前に呼ぶ (Itemの読み込み・ファイル登録・空間関数の読み込み)。 */
  ensure: () => Promise<void>;
}

/**
 * 人口メッシュの出所。**SORAの地上リスクを見るためのもの。**
 *
 * 建物と違って「引いた状態で見たい」データなので、ズームに応じて
 * メッシュを粗くして出す ([`meshDigits`])。
 */
interface MeshSource {
  id: string;
  /** このデータの細かさ (メッシュコードの桁数)。11桁=125m、8桁=1km。 */
  digits: number;
  /** 収録範囲。 */
  bbox: Bbox | null;
  /** このデータセットを構成するファイル。`ensure()` を呼ぶまで空。 */
  files: { file: string; bbox: Bbox | null }[];
  ensure: () => Promise<void>;
}

/**
 * 要求する細かさに対して、どの出所を引くか。
 *
 * **要求より細かいものの中で、いちばん粗いものを選ぶ。** 125mのファイルからでも
 * 1kmは作れるが、そのぶん元の行を多く読む (実測でズーム7のとき21.1MB)。
 * 全国を1kmで束ねたファイル (5.5MB) があれば、そちらを読む方がずっと軽い。
 *
 * 逆に、要求より粗いものからは作れない (1kmのファイルで500mは描けない)。
 */
function meshSourceFor(sources: MeshSource[], digits: number): MeshSource | undefined {
  return sources
    .filter((source) => source.digits >= digits)
    .sort((a, b) => a.digits - b.digits)[0];
}

/**
 * ズームに対して、メッシュコードを何桁で束ねるか。
 *
 * **メッシュコードは階層になっている**ので、前から切るだけで粗くできる
 * (11桁=125m、10桁=250m、9桁=500m、8桁=1km、6桁=10km、4桁=80km)。
 *
 * 引くほど粗くするのは、描く数を抑えるため。125mメッシュは全国で282万件ある。
 * どのファイルから作るかは [`meshSourceFor`] が別に決める。
 */
/** メッシュコードの桁数から、人間に見せる大きさの呼び名。 */
const MESH_SIZE_LABELS: Record<number, string> = {
  4: '80km',
  6: '10km',
  8: '1km',
  9: '500m',
  10: '250m',
  11: '125m',
};

function meshDigits(zoom: number): number {
  if (zoom >= 15) return 11;
  if (zoom >= 14) return 10;
  if (zoom >= 12) return 9;
  if (zoom >= 9) return 8;
  if (zoom >= 6) return 6;
  return 4;
}

/** 機体の区分。SORA 2.5 の iGRC 表の列。 */
const AIRCRAFT_CLASSES = [
  { label: '1m / 25m/s', dimension: '1m' },
  { label: '3m / 35m/s', dimension: '3m' },
  { label: '8m / 75m/s', dimension: '8m' },
  { label: '20m / 120m/s', dimension: '20m' },
  { label: '40m / 200m/s', dimension: '40m' },
];

/**
 * SORA 2.5 の iGRC 表 (JARUS JAR_doc_25 Table 2) の、人口密度の行。
 *
 * **色の区切りをこの表に合わせる。** 連続的なグラデーションだと「濃い/薄い」しか
 * 読めないが、判断の区切りで段を切れば、地図がそのまま iGRC を答える。
 *
 * `igrc` は [`AIRCRAFT_CLASSES`] と同じ並び。`null` は**SORAの適用範囲外**。
 *
 * 表の写しなので、**運用に使う前に原文を確認すること。**
 * <http://jarus-rpas.org/wp-content/uploads/2024/06/SORA-v2.5-Main-Body-Release-JAR_doc_25.pdf>
 */
const IGRC_BANDS: {
  /** この帯の上限 (人/km²)。未満ならこの帯。 */
  limit: number;
  label: string;
  color: string;
  igrc: (number | null)[];
}[] = [
  { limit: 5, label: '5 未満', color: '#ffffb2', igrc: [2, 3, 4, 5, 6] },
  { limit: 50, label: '5 〜 50', color: '#fed976', igrc: [3, 4, 5, 6, 7] },
  { limit: 500, label: '50 〜 500', color: '#feb24c', igrc: [4, 5, 6, 7, 8] },
  { limit: 5000, label: '500 〜 5,000', color: '#fd8d3c', igrc: [5, 6, 7, 8, 9] },
  { limit: 50000, label: '5,000 〜 50,000', color: '#f03b20', igrc: [6, 7, 8, 9, 10] },
  {
    limit: Number.POSITIVE_INFINITY,
    label: '50,000 超',
    color: '#bd0026',
    igrc: [7, 8, null, null, null],
  },
];

/** 人口密度 (人/km²) から iGRC の帯を引く。 */
function igrcBand(density: number) {
  return IGRC_BANDS.find((band) => density < band.limit) ?? IGRC_BANDS[IGRC_BANDS.length - 1];
}

/**
 * 表示範囲と重なるファイルだけを選ぶ。**カタログを空間索引として使う。**
 *
 * 建物は都市ごとに1ファイルで、PLATEAUを全国に広げると300を超える。
 * 全部を `read_parquet([...])` に渡すと、**ファイルの数だけフッターを読みに行く**
 * (1ファイル1往復)。表示範囲に重なるのは普通1〜3都市なので、そこだけ渡す。
 *
 * 1つの大きなファイルに束ねる手もあるが、そちらは1都市の更新で全体を書き直すことになる。
 * 都市の境界が空間的な区切りとして働くので、分かれたままでよい。
 *
 * 人口メッシュ (都道府県ごとに1ファイル) も同じ仕組みで絞る。
 */
function filesInView(
  source: { files: { file: string; bbox: Bbox | null }[] },
  bounds: ViewBounds,
): string[] {
  const overlapping = source.files.filter(({ bbox }) => {
    // 収録範囲が分からないファイルは落とさない (判断材料が無いので読む)。
    if (!bbox) return true;
    const [west, south, east, north] = bbox;
    return west <= bounds.east && east >= bounds.west && south <= bounds.north && north >= bounds.south;
  });
  return overlapping.map(({ file }) => file);
}

async function initDuckDb(collections: Collection[]): Promise<{
  conn: duckdb.AsyncDuckDBConnection;
  /** 建物データの出所。カタログにあるものだけが並ぶ。 */
  buildingSources: BuildingSource[];
  /** 人口メッシュ。細かさの違うものが並ぶ。空なら地上リスクの表示を出さない。 */
  meshSources: MeshSource[];
  /** 空間関数を使う前に呼ぶ。 */
  ensureSpatial: () => Promise<void>;
  /** 地名 (isj_oaza) を引く前に呼ぶ。 */
  ensureOaza: () => Promise<void>;
}> {
  const bundle = await duckdb.selectBundle({
    mvp: {
      mainModule: duckdbUrl('duckdb-mvp.wasm'),
      mainWorker: duckdbUrl('duckdb-browser-mvp.worker.js'),
    },
    eh: {
      mainModule: duckdbUrl('duckdb-eh.wasm'),
      mainWorker: duckdbUrl('duckdb-browser-eh.worker.js'),
    },
  });
  // new Worker() は別オリジンのスクリプトを直接は読み込めない。createWorker は
  // 取得してからBlob URLにして起動するので、WASM本体を別のドメインに置ける。
  const worker = await duckdb.createWorker(bundle.mainWorker!);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  // どちらも指定しないと、警告も出さずにファイル全体のダウンロードに落ちる。
  // 詳細: docs/duckdb-wasm-range-requests.md
  //
  // forceFullHTTPReads: これを明示しないとRangeリクエストを一切出さない。
  //   既定値は false のはずだが、指定した場合としない場合で挙動が変わることを実測で確認。
  // reliableHeadRequests: DuckDB-WASMはまず「HEADにRangeを付けて206が返るか」で
  //   部分取得の可否を判断するが、GitHub Pagesなど200を返すサーバーがある。
  //   false にすると「GET bytes=0-0 で206を確認し、通常のHEADでサイズを取る」経路に
  //   なり、配信元の流儀に左右されにくくなる。
  await db.open({
    filesystem: { forceFullHTTPReads: false, reliableHeadRequests: false },
  });

  const conn = await db.connect();
  // 拡張の取得元をここで切り替えておく。read_parquet() は直後の行政区域の
  // ビュー作成 (このすぐ下) で使うため、遅延させると初期化そのものが
  // 本家 (extensions.duckdb.org) に依存したままになる。
  // parquet拡張は明示LOADしていないが、read_parquet()の時点でDuckDBが自動取得する
  // (autoload) ので、取得元さえ切り替えておけば以降は暗黙に自前配信から読まれる。
  await conn.query(`SET custom_extension_repository = '${DUCKDB_EXTENSIONS_URL}';`);

  // 空間関数は逆ジオコーディングと建物表示にしか要らない。拡張の取得に
  // 数秒かかるので、起動時ではなく最初に必要になったときに読む。
  //
  // duckdb-wasmはCRSメタデータ付きのGeoParquetをread_parquetすると
  // "stoi: no conversion" でクラッシュすることがある (PROJ初期化のタイミング問題、
  // duckdb/duckdb-wasm#2199)。spatial拡張を明示ロードする"前"に
  // duckdb_coordinate_systems() を一度呼んでおくと回避できる
  // (逆に LOAD spatial の後に呼ぶとクラッシュを再現してしまうので順序に注意)。
  // https://github.com/duckdb/duckdb-wasm/issues/2199#issuecomment-4205882097
  const ensureSpatial = once(async () => {
    await conn.query(`SELECT * FROM duckdb_coordinate_systems();`);
    await conn.query(`INSTALL spatial; LOAD spatial;`);
  });

  // DuckDBにファイルを教える。通信はしないので、何度呼んでも安い。
  const registered = new Set<string>();
  const register = async (files: string[]) => {
    for (const file of files) {
      if (registered.has(file)) continue;
      registered.add(file);
      await db.registerFileURL(file, dataUrl(file), duckdb.DuckDBDataProtocol.HTTP, false);
    }
  };

  const byKind = (kind: DatasetKind) => collections.filter((c) => c.kind === kind);
  const oazaCollections = byKind('oaza');
  const adminCollections = byKind('admin');
  if (oazaCollections.length === 0 || adminCollections.length === 0) {
    throw new Error('カタログに必要なCollection (oaza / admin) がありません。');
  }

  // 行政区域は全国版と都道府県版が同居しうる。範囲の広いもの (=件数が最多) を採用する。
  // ここだけは起動時にItemが要る (どのファイルを読むか決まらないため)。
  const adminItems = (await Promise.all(adminCollections.map((c) => c.items()))).flat();
  const adminItem = adminItems.sort(
    (a, b) => (b.properties['table:row_count'] ?? 0) - (a.properties['table:row_count'] ?? 0),
  )[0];
  if (!adminItem) throw new Error('行政区域のItemがありません。');
  const adminFile = adminItem.assets.data.href;

  // 検索用の名称を抜き出したものがあれば使う。無い場合は行政区域から作るが、
  // そちらは名称の列がファイル全体に散らばっているため、HTTP越しだと
  // 往復が積み上がって初期化が数十秒かかる。
  const adminNamesCollection = byKind('admin_names')[0];
  const adminNamesFile = adminNamesCollection
    ? (await adminNamesCollection.items())[0]?.assets.data.href
    : undefined;

  await register(adminNamesFile ? [adminFile, adminNamesFile] : [adminFile]);

  console.info(
    '[catalog] 行政区域:',
    adminItem.id,
    '/ 名称:',
    adminNamesFile ?? '(行政区域から都度作成)',
    '/ 地名:',
    oazaCollections.map((c) => c.id).join(', '),
  );

  // ビューを作るだけでもDuckDBはスキーマ検証のためにフッターを読むので、
  // 1ファイルあたり数回の往復が発生する。起動時に要るのは行政区域と名称だけで、
  // 地名は検索時、建物はズームしたときにしか使わないので、そのときまで作らない。
  await conn.query(`CREATE VIEW admin AS SELECT * FROM read_parquet('${adminFile}');`);

  const ensureOaza = once(async () => {
    // 地名のItemもここで初めて読む。検索するまで要らない。
    const files = (await Promise.all(oazaCollections.map((c) => c.items())))
      .flat()
      .map((item) => item.assets.data.href);
    await register(files);
    const list = files.map((file) => `'${file}'`).join(', ');
    await conn.query(`CREATE VIEW isj_oaza AS SELECT * FROM read_parquet([${list}]);`);
    // ビューを作るだけではデータを読まないので、検索に使う列に一度触れておく。
    // ここを省くと、読み込みの待ち時間が最初の検索にそのまま乗る。
    await conn.query(`
      SELECT count(pref_name || city_name || oaza_name) FROM isj_oaza;
      SELECT count(pref_name || county_name || city_name || ward_name) FROM admin_names;
    `);
  });

  // 建物は任意。無ければ建物レイヤーを出さないだけで、他の機能は動く。
  // 並び順がそのまま選択肢の順になり、先頭が既定になる。
  // 属性が揃っているPLATEAUを先に置く。
  //
  // **ビューは作らない。** 出所ごとに1つのビューへ束ねると、その時点で
  // ファイルの数だけフッターを読みに行くことになる (1ファイル1往復)。
  // 建物は都市ごとに1ファイルで、PLATEAUを全国に広げると300を超えるので、
  // 引くときに表示範囲と重なるものだけを渡す (`filesInView`)。
  const buildingKinds: { kind: DatasetKind; label: string }[] = [
    { kind: 'plateau_buildings', label: 'PLATEAU' },
    { kind: 'buildings', label: 'Overture' },
  ];
  const buildingSources: BuildingSource[] = buildingKinds.flatMap(({ kind, label }) => {
    const collection = byKind(kind)[0];
    if (!collection) return [];
    // 何で絞れるかは列の有無から決める。高さは列があれば絞れる。
    // 用途で絞れる列は**カタログが語彙を持っている列**。列名 (PLATEAUは usage、
    // Overtureは class) をここに書かないのは、出所が増えたときに書き足す場所が
    // 分かれてしまうため。語彙を出すかどうかはパイプライン側が一箇所で決める。
    const [categoryColumn, usages] = Object.entries(collection.summaries)[0] ?? [null, []];
    const source: BuildingSource = {
      id: collection.id,
      label,
      // Itemを読むまで空。寄って実際に引くまで通信しない。
      files: [],
      hasHeight: collection.columns.has('height'),
      categoryColumn,
      usages,
      bbox: collection.bbox,
      ensure: once(async () => {
        const items = await collection.items();
        source.files = itemFiles(items);
        await register(source.files.map(({ file }) => file));
        await ensureSpatial();
      }),
    };
    return [source];
  });

  // 人口メッシュ。建物と同じく、寄るまでItemを読まない。
  // **細かさの違うCollectionが並ぶ** (125mは都道府県ごと、1kmは全国で1つ) ので、
  // どれを引くかはズームに応じて `meshSourceFor` が決める。
  const meshSources: MeshSource[] = byKind('population_mesh').flatMap((collection) => {
    const digits = collection.meshDigits;
    if (digits === undefined) {
      // 細かさが分からないメッシュは使いようがない (どのズームで引くか決まらない)。
      console.warn('[catalog] duck:mesh_digits がありません:', collection.id);
      return [];
    }
    const source: MeshSource = {
      id: collection.id,
      digits,
      bbox: collection.bbox,
      files: [],
      ensure: once(async () => {
        const items = await collection.items();
        source.files = itemFiles(items);
        await register(source.files.map(({ file }) => file));
        await ensureSpatial();
      }),
    };
    return [source];
  });

  // 行政区域は1つの自治体が複数のポリゴン行に分かれることがある (飛び地や島など) ので、
  // 検索には名称を重複排除したものを使う。
  //
  // 専用のファイルがあればそれを読む。無い場合は行政区域から作るが、名称の列は
  // 合計65KB程度しかないのに row group の数だけ散らばっているため、HTTP越しでは
  // 往復回数が効いて極端に遅くなる (実測で42リクエスト・約24秒)。
  // 転送量ではなく往復の問題なので、pipeline の build_admin_names で
  // まとまった小さなファイルを作っておくこと。
  await conn.query(
    adminNamesFile
      ? `CREATE VIEW admin_names AS SELECT * FROM read_parquet('${adminNamesFile}');`
      : `CREATE TABLE admin_names AS
           SELECT DISTINCT
             admin_id,
             pref_name,
             coalesce(county_name, '') AS county_name,
             coalesce(city_name, '') AS city_name,
             coalesce(ward_name, '') AS ward_name
           FROM admin;`,
  );

  return { conn, buildingSources, meshSources, ensureSpatial, ensureOaza };
}

/**
 * 地域メッシュ (JIS X 0410) のコードから範囲を求める。
 *
 * **束ねたセルは、この矩形で描く。** 中に入っている子メッシュのbboxの和で描くと、
 * 人のいる子だけを囲った形になり、細い縦帯のような「メッシュではない形」が出る。
 * 実際に地図で見て分かった。
 *
 * パイプライン側の `pipeline/src/mesh.rs` と同じ計算。JIS X 0410 は変わらないので、
 * 二重に持つことを受け入れている (SQLで書くよりこちらの方が読める)。
 */
function meshBounds(code: string): Bbox {
  const digits = [...code].map(Number);
  // 1次メッシュ。緯度は1.5倍した整数部、経度は100を引いた整数部。
  let latSize = 2 / 3;
  let lonSize = 1;
  let south = (digits[0] * 10 + digits[1]) / 1.5;
  let west = digits[2] * 10 + digits[3] + 100;

  // 2次メッシュ。1次を縦横8分割し、南西を0として行・列で指す。
  if (digits.length >= 6) {
    latSize /= 8;
    lonSize /= 8;
    south += digits[4] * latSize;
    west += digits[5] * lonSize;
  }
  // 3次メッシュ。2次を縦横10分割する。
  if (digits.length >= 8) {
    latSize /= 10;
    lonSize /= 10;
    south += digits[6] * latSize;
    west += digits[7] * lonSize;
  }
  // 分割メッシュ。1桁ごとに4分割で、1=南西 2=南東 3=北西 4=北東。
  for (const quadrant of digits.slice(8)) {
    latSize /= 2;
    lonSize /= 2;
    south += Math.floor((quadrant - 1) / 2) * latSize;
    west += ((quadrant - 1) % 2) * lonSize;
  }
  return [west, south, west + lonSize, south + latSize];
}

/** 集約したメッシュ1つ分。 */
interface MeshCell {
  /** メッシュコード。矩形はここから計算する。 */
  code: string;
  population: number;
  /** 人口密度 (人/km²)。**中の最大値**。 */
  density: number;
}

/**
 * 表示範囲の人口メッシュを、指定の桁で束ねて取り出す。
 *
 * **密度は平均ではなく最大を取る。** SORAは運航範囲の中で最も密度の高いところを
 * 採るので、平均にすると危ないセルが薄まって消える。人口は合計。
 *
 * 矩形は返さない。**メッシュコードから計算する** ([`meshBounds`])。
 * 子のbboxの和で描くと、メッシュではない形になってしまう。
 */
async function fetchMeshInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: MeshSource,
  bounds: ViewBounds,
  digits: number,
): Promise<MeshCell[]> {
  const files = filesInView(source, bounds);
  if (files.length === 0) return [];
  const list = files.map((file) => `'${file}'`).join(', ');

  const result = await conn.query(`
    SELECT
      substr(mesh_code, 1, ${digits}) AS code,
      sum(population) AS population,
      max(density) AS density
    FROM read_parquet([${list}])
    WHERE bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}
      AND bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}
      AND density IS NOT NULL
    GROUP BY code;
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      code: string;
      population: number | bigint | null;
      density: number;
    };
    return {
      code: r.code,
      population: Number(r.population ?? 0),
      density: r.density,
    };
  });
}

/** 建物1件分の表示用データ。 */
interface BuildingFeature {
  geojson: GeoJSON.Geometry;
  name: string | null;
  /** 用途 (PLATEAU) または種別 (Overture)。出所によって語彙が違う。 */
  category: string | null;
  height: number | null;
}

/** 建物の絞り込み条件。PLATEAUのように属性が揃っている出所でだけ意味を持つ。 */
interface BuildingFilter {
  /** 高さの下限 (m)。0なら絞らない。 */
  minHeight: number;
  /** 対象の用途。null なら絞らない。 */
  usages: string[] | null;
}

/**
 * 表示範囲に入る建物を取り出す。
 *
 * 逆ジオコーディングと同じく、ジオメトリ本体を評価する前に bbox 列で絞る。
 *
 * 件数が多いと描画が重くなるので上限を設けるが、単に LIMIT で切るとまずい。
 * データは空間的にソートされているため、先頭から N 件を取ると地図の一部分にだけ
 * 固まって「帯状に消える」ように見える。
 *
 * **画面中心に近い順に取る。** 地図を傾けると `getBounds()` は地平線方向へ大きく
 * 広がり (実測でpitch 50度のとき面積3.1倍、60度で7.1倍)、上限に当たりやすくなる。
 * 中心からの距離順にしておけば、間引かれても手前から埋まり、遠景が薄くなるという
 * 見た目として自然な劣化になる。範囲そのものを切り詰めるより調整値が要らない。
 */
async function fetchBuildingsInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: BuildingSource,
  bounds: ViewBounds,
  filter: BuildingFilter,
  limit: number,
): Promise<BuildingFeature[]> {
  // 表示範囲に重なるファイルだけを渡す。重なるものが無ければ問い合わせない。
  const files = filesInView(source, bounds);
  if (files.length === 0) return [];
  const list = files.map((file) => `'${file}'`).join(', ');

  // 絞り込みは **SQLに渡す**。取得後にJavaScript側で捨てると、
  // 読む量も転送する量も減らないため。
  const conditions = [
    `bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}`,
    `bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}`,
  ];
  if (source.hasHeight && filter.minHeight > 0) {
    conditions.push(`height >= ${filter.minHeight}`);
  }
  if (source.categoryColumn && filter.usages) {
    // 用途が1つも選ばれていなければ1件も出さない (空のINは常に偽)。
    const list = filter.usages.map((u) => `'${u.replace(/'/g, "''")}'`).join(', ');
    conditions.push(list.length > 0 ? `${source.categoryColumn} IN (${list})` : 'false');
  }
  const categorySelect = source.categoryColumn ?? 'NULL';

  // 緯度方向と経度方向で1度あたりの距離が違うので、経度差を縮めてから比べる
  // (東京付近では経度1度が緯度1度の約0.81倍)。並べ替えの順序だけの話なので、
  // 厳密な測地線距離までは要らない。
  const lonScale = Math.cos((bounds.centerLat * Math.PI) / 180);

  const result = await conn.query(`
    SELECT ST_AsGeoJSON(geometry) AS geojson, name, ${categorySelect} AS category, height
    FROM read_parquet([${list}])
    WHERE ${conditions.join('\n      AND ')}
    ORDER BY
      pow(((bbox.xmin + bbox.xmax) / 2 - ${bounds.centerLon}) * ${lonScale}, 2)
      + pow((bbox.ymin + bbox.ymax) / 2 - ${bounds.centerLat}, 2)
    LIMIT ${limit};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      geojson: string;
      name: string | null;
      category: string | null;
      height: number | null;
    };
    return {
      geojson: JSON.parse(r.geojson) as GeoJSON.Geometry,
      name: r.name,
      category: r.category,
      height: r.height,
    };
  });
}

/**
 * 「港区 芝公園」のように複数の要素が並んだ入力も拾えるよう、空白区切りの
 * トークンごとに「連結した住所」への部分一致をANDで取る条件式を組み立てる。
 * (列ごとの部分一致だと、候補選択後にinputへ入る連結文字列が何にも一致しない)
 */
function buildMatchConditions(keyword: string, concatExpr: string): string {
  return keyword
    .split(/[\s　]+/)
    .filter((token) => token.length > 0)
    .map((token) => `${concatExpr} ILIKE '%${token.replace(/'/g, "''")}%'`)
    .join(' AND ');
}

/** 候補として表示する件数の上限 (行政区域と地名の合計)。 */
const MAX_RESULTS = 10;

async function searchAddress(
  conn: duckdb.AsyncDuckDBConnection,
  keyword: string,
): Promise<SearchResult[]> {
  // 行政区域と地名は別のテーブルにあるので個別に引き、行政区域を優先して
  // 合計 MAX_RESULTS 件に収める (どちらか一方しか無い場合は残りをもう一方で埋める)。
  const adminExpr = `pref_name || county_name || city_name || ward_name`;
  const adminResult = await conn.query(`
    SELECT admin_id, ${adminExpr} AS label
    FROM admin_names
    WHERE ${buildMatchConditions(keyword, adminExpr)}
    ORDER BY length(label)
    LIMIT ${MAX_RESULTS};
  `);
  const admins: SearchResult[] = adminResult.toArray().map((row) => {
    const r = row.toJSON() as unknown as { admin_id: string; label: string };
    return { kind: 'admin', label: r.label, adminId: r.admin_id };
  });

  const oazaExpr = `pref_name || city_name || oaza_name`;
  const oazaResult = await conn.query(`
    -- 位置参照情報は点データなので、covering bbox がそのまま経緯度になる。
    -- ST_X/ST_Y を使うと地名検索のためだけに spatial 拡張の取得を待つことになる。
    SELECT ${oazaExpr} AS label, bbox.xmin AS lon, bbox.ymin AS lat
    FROM isj_oaza
    WHERE ${buildMatchConditions(keyword, oazaExpr)}
    ORDER BY length(label)
    LIMIT ${MAX_RESULTS};
  `);
  const oazas: SearchResult[] = oazaResult.toArray().map((row) => {
    const r = row.toJSON() as unknown as { label: string; lon: number; lat: number };
    return { kind: 'oaza', label: r.label, lon: r.lon, lat: r.lat };
  });

  return [...admins, ...oazas].slice(0, MAX_RESULTS);
}

/**
 * 逆ジオコーディング。指定した座標を含む行政区域を返す。
 *
 * ポリゴンとの包含判定 (ST_Contains) は重いので、先に bbox 列で候補を絞る。
 * bbox はGeoParquet生成時に書き込んである covering 列で、
 * これがあるおかげで全国データ (12万件) でも実用的な速度で返る。
 */
async function reverseGeocode(
  conn: duckdb.AsyncDuckDBConnection,
  lon: number,
  lat: number,
): Promise<{ label: string; adminId: string } | null> {
  const result = await conn.query(`
    SELECT pref_name || coalesce(county_name, '') || coalesce(city_name, '')
             || coalesce(ward_name, '') AS label,
           admin_id
    FROM admin
    WHERE bbox.xmin <= ${lon} AND bbox.xmax >= ${lon}
      AND bbox.ymin <= ${lat} AND bbox.ymax >= ${lat}
      AND ST_Contains(geometry, ST_Point(${lon}, ${lat}))
    LIMIT 1;
  `);
  const rows = result.toArray();
  if (rows.length === 0) return null;
  const row = rows[0].toJSON() as unknown as { label: string; admin_id: string };
  return { label: row.label, adminId: row.admin_id };
}

async function fetchAdminPolygon(
  conn: duckdb.AsyncDuckDBConnection,
  adminId: string,
): Promise<{ geojson: GeoJSON.Geometry; bbox: [number, number, number, number] } | null> {
  const result = await conn.query(`
    SELECT ST_AsGeoJSON(ST_Union_Agg(geometry)) AS geojson,
           min(bbox.xmin) AS xmin, min(bbox.ymin) AS ymin,
           max(bbox.xmax) AS xmax, max(bbox.ymax) AS ymax
    FROM admin
    WHERE admin_id = '${adminId}';
  `);
  const rows = result.toArray();
  if (rows.length === 0) return null;
  const row = rows[0].toJSON() as {
    geojson: string | null;
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  };
  if (!row.geojson) return null;
  return {
    geojson: JSON.parse(row.geojson) as GeoJSON.Geometry,
    bbox: [row.xmin, row.ymin, row.xmax, row.ymax],
  };
}

/**
 * 出典表示のリンク。
 *
 * 国土交通省の利用約款も国土地理院の利用規約も、出典に当該ページのURLを求めている。
 * 表示義務のあるものなので、組み立ては1箇所に置く。
 */
function creditLink(url: string, label: string): string {
  return `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`;
}

// 国土地理院タイル。利用規約により出典表示 (attribution) が必須。
const GSI_TERMS_URL = 'https://maps.gsi.go.jp/development/ichiran.html';

/**
 * 選べる地図。**先頭が既定** (建物の出所と同じ流儀)。
 *
 * 出典はどれも「国土地理院」で同じなので、切り替えても出典表示は変えなくてよい。
 * 3種とも z18 までタイルがあることを実測で確かめてある (港区・高尾山)。
 * 地形を入れたときは航空写真の方が起伏が分かる。
 */
const BASEMAPS = [
  { id: 'pale', label: '淡色地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png' },
  { id: 'std', label: '標準地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png' },
  {
    id: 'photo',
    label: '航空写真',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
  },
] as const;

/**
 * 地形の標高タイル。
 *
 * Mapterhornの日本のソースは基盤地図情報 (数値標高モデル) で、1m・5m・10m版を持つ。
 * 測量法に基づく国土地理院長承認 (使用) はMapterhorn側が取得済み (R 7JHs 542) で、
 * こちらは配信されているタイルを実行時に読むだけなので、地理院タイルを
 * ベースマップに使っているのと同じ立場になる (出典表示のみ)。
 *
 * PLATEAUのCityGMLにも地形モデル (TINRelief) が同梱されているが、実測すると
 * 三角形の辺が5.00mと7.08m (=5×√2) しか無く、**5mグリッドを三角形に割っただけ**
 * だった。情報量は5mラスタと同じで、港区の4メッシュだけで展開後960MBある。
 * 表示のためにこれをラスタタイルへ焼く工程を持つ意味がないので使わない。
 */
const TERRAIN_TILEJSON_URL = 'https://tiles.mapterhorn.com/tilejson.json';

const GSI_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    gsi: {
      type: 'raster',
      // 切り替えは setTiles でURLだけ差し替える。tileSize も maxzoom も出典も
      // 3種で共通なので、ソースを作り直す必要がない。
      tiles: [BASEMAPS[0].url],
      tileSize: 256,
      maxzoom: 18,
      attribution: creditLink(GSI_TERMS_URL, '国土地理院'),
    },
    terrain: {
      type: 'raster-dem',
      // tiles / encoding (terrarium) / tileSize / attribution は tilejson から読ませる。
      // 個別に書き写すと、向こうが変えたときに黙ってずれる。
      url: TERRAIN_TILEJSON_URL,
      // tilejson が maxzoom を宣言していないのに、実際は z16 までしか無い
      // (z17以降は404)。明示しないと建物を見るズームで404を撃ち続ける。
      maxzoom: 16,
    },
  },
  layers: [
    {
      id: 'gsi-basemap',
      type: 'raster',
      source: 'gsi',
    },
  ],
  // ここに terrain を書かないこと。スタイルに書くと地形タイルの取得が
  // map の 'load' の条件に入り、**Mapterhornが落ちていると起動できなくなる**
  // (読み込み中の表示から進まない)。読み込み後に setTerrain で有効にする。
};

const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

/**
 * 地図を生成し、スタイルのロードとハイライト用レイヤーの追加が終わるまで待つ。
 *
 * 出典表示はカタログから組み立てる。どのデータセットを配信するかはカタログ次第なので、
 * ここに書き並べると実際に使っているものとずれる。表示義務のある出典が抜けるのは
 * ライセンス違反になるため、データ側に追随させる。
 */
/**
 * 出典表示が下端から占めている高さを測り、CSS変数 `--attribution-space` に入れる。
 *
 * **出典は出所が増えるほど行が増える。** 人口メッシュ (47都道府県) を足したときに
 * 1行から2行になり、全幅40pxに広がって左下の「建物のある範囲へ移動」を覆った
 * (押せなくなった)。いまはたたんであるが、広げれば452×112pxの箱になる。
 * パネルの位置を固定値で避けると、出所を足すたびに破れる。
 *
 * **高さではなく「下端からどこまで」を測る。** 出典の箱の下にはMapLibreが
 * 余白を入れるので、高さだけで避けると余白のぶん足りない (実測で2px重なった)。
 *
 * 出典そのものは縮めない。表示義務があるので、避けるのはこちらの役目。
 */
function watchAttributionHeight(map: MapLibreMap): void {
  const container = map.getContainer();
  const attribution = container.querySelector<HTMLElement>('.maplibregl-ctrl-attrib');
  if (!attribution) return;
  const apply = () => {
    const space = container.getBoundingClientRect().bottom - attribution.getBoundingClientRect().top;
    document.documentElement.style.setProperty(
      '--attribution-space',
      `${Math.ceil(space)}px`,
    );
  };
  new ResizeObserver(apply).observe(attribution);
  apply();
}

/**
 * 出典をたたんだ状態から始める。
 *
 * MapLibreは `compact` でも**初回だけ広げた状態**で出す。出所が6件あるこのアプリでは
 * 418×230pxの箱になり、右下のパネルを押し上げてしまう。ⓘ を押せば出るので、
 * 最初からたたんでおく。
 *
 * 広げ閉じはMapLibreがクラスの付け外しでやっているので、こちらも外して合わせる。
 */
function collapseAttribution(map: MapLibreMap): void {
  map
    .getContainer()
    .querySelector('.maplibregl-ctrl-attrib')
    ?.classList.remove('maplibregl-compact-show');
}

/**
 * 出典の文言に、**それが何のデータの出典なのか**を添える。
 *
 * 出典だけを並べると、どれがどのデータのものか読み取れない
 * (「（国土交通省）をもとに作成」が2つ並ぶ)。カタログの `title` を前置きして、
 * 「建物 (PLATEAU): 「3D都市モデル…」」の形にする。
 *
 * 同じ出典を使うCollectionはまとめる (大字・町丁目と街区は同じ位置参照情報)。
 */
function groupCredits(
  collections: Collection[],
): { titles: string[]; attribution: string; url: string }[] {
  const byAttribution = new Map<string, { url: string; titles: string[] }>();
  for (const collection of collections) {
    const entry = byAttribution.get(collection.attribution) ?? {
      url: collection.attributionUrl,
      titles: [],
    };
    // 同じ出典で細かさ違いのCollectionが並ぶことがある (人口メッシュの125mと1km)。
    if (!entry.titles.includes(collection.title)) entry.titles.push(collection.title);
    byAttribution.set(collection.attribution, entry);
  }
  // 並べ替えは表示する文言で行う (組み立てたHTMLで並べると、順序がタグの中身に左右される)。
  return [...byAttribution]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([attribution, { url, titles }]) => ({ titles, attribution, url }));
}

function buildDataCredits(collections: Collection[]): string[] {
  return groupCredits(collections).map(
    ({ titles, attribution, url }) =>
      `<span class="credit"><b>${titles.join('・')}</b> ${creditLink(url, attribution)}</span>`,
  );
}

/**
 * 出典をパネルにも出す。**地図右下の ⓘ とは別に持つ。**
 *
 * MapLibreは出典の間を `" | "` のテキストで繋ぐので、1件ずつ改行させられない
 * (ブロックにすると区切りだけの行ができる)。結果として ⓘ の中身は1行に詰まり、
 * どれが何の出典なのか目で追いにくい。
 *
 * ⓘ は表示義務を果たす標準の置き場所として残し、**読ませるのはこちら**。
 * 地形 (Mapterhorn) のようにTileJSONから来る出典はカタログに無いので、
 * ⓘ の側が引き続き唯一の出どころになる。
 */
function renderCredits(container: HTMLElement, collections: Collection[]): void {
  container.replaceChildren();
  for (const { titles, attribution, url } of groupCredits(collections)) {
    const term = document.createElement('dt');
    term.textContent = titles.join('・');
    const detail = document.createElement('dd');
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = attribution;
    detail.append(link);
    container.append(term, detail);
  }
}

function initMap(collections: Collection[]): Promise<MapLibreMap> {
  const map = new MapLibreMap({
    container: 'map',
    style: GSI_STYLE,
    center: [139.767, 35.681],
    zoom: 9,
    // 既定の出典表示を止め、カタログ由来の出典を足したものに差し替える。
    attributionControl: false,
  });
  // **たたんで出す。** 出所が増えるほど文言が伸びるので、広げたままだと
  // 地図の下端を何行も占める (人口メッシュを足しただけで1行から2行になり、
  // 左下のボタンを覆った)。ⓘ を押せば全文が出る。
  map.addControl(
    new AttributionControl({ compact: true, customAttribution: buildDataCredits(collections) }),
  );
  collapseAttribution(map);
  watchAttributionHeight(map);
  // 建物を立体で描くので、傾きを操作する手段を出しておく。
  // visualizePitch を付けるとコンパスが傾きも表し、クリックで方位と傾きが
  // 0に戻る。つまり「2Dに戻す」手段が標準で付いてくるので、自前で切り替えUIを持たない。
  // 左上は検索欄、右下は出典表示があるので右上に置く。
  map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
  // 地形を切る手段。平野部では起伏が無く、タイルを読むだけになる場面もある。
  // MapLibreに標準で付いてくるので、自前のトグルは作らない。
  map.addControl(new TerrainControl({ source: 'terrain' }), 'top-right');

  map.on('error', (e) => console.error('[map] error', e.error ?? e));

  return new Promise((resolve) => {
    map.on('load', () => {
      // 人口メッシュは一番下に敷く。判断の背景であって、主役ではない。
      map.addSource('population-mesh', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'population-mesh-fill',
        type: 'fill',
        source: 'population-mesh',
        paint: {
          // 色はSORAの iGRC の区切りで段を切る (`IGRC_BANDS`)。
          // 連続的なグラデーションにすると「濃い/薄い」しか読めない。
          'fill-color': ['get', 'color'],
          // 下の地図 (地名や道路) が透けて見える濃さにする。
          // 判断に使うのは色の段であって、塗りつぶしそのものではない。
          'fill-opacity': 0.55,
        },
      });

      // 建物はハイライトより先に追加して、下に敷く。
      // 出典表示はカタログ由来のものが上の AttributionControl に入っている。
      map.addSource('buildings', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      // 立体 (fill-extrusion) で描く。平面用と2枚持たないのは、傾き0度なら
      // 真上から見ることになり、平面塗りとほとんど同じに見えるため。
      // 2Dに戻したいときは NavigationControl のコンパスで傾きを0にする。
      map.addLayer({
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'buildings',
        paint: {
          // 高さで塗り分ける。傾けずに見るときも高さが分かるようにするため。
          // 高さを持たないデータ (Overtureはほぼ全件がそう) では既定色のままになる。
          'fill-extrusion-color': [
            'case',
            ['==', ['get', 'height'], null],
            '#4a6785',
            [
              'interpolate',
              ['linear'],
              ['get', 'height'],
              0,
              '#c6d4e4',
              20,
              '#8fabc9',
              60,
              '#4a6785',
              150,
              '#2d3f52',
            ],
          ],
          // 高さが無い建物にも既定値を与える。0にすると描画されず、
          // Overtureは高さが1.5%しか入っていないのでほぼ全部消えてしまう。
          'fill-extrusion-height': ['coalesce', ['get', 'height'], 3],
          // **地盤標高を入れないこと。** 地形が有効なとき、MapLibreは
          // get_elevation(重心) を base と height の両方に加算する
          // (fill_extrusion.vertex.glsl)。base は地形面からの相対値なので、
          // ここに海抜を入れると二重に足して建物が空へ飛ぶ。
          'fill-extrusion-base': 0,
          // 1未満にすると面同士が透けて見える描画崩れが出るので、下地を
          // わずかに透かす程度に留める。
          'fill-extrusion-opacity': 0.9,
        },
      });

      // 建物の収録範囲。引くと建物そのものは消えるので、どこにデータがあるかを
      // 枠で示す。偶然その場所へ行かないと機能に気づけない、という状態を避ける。
      map.addSource('buildings-coverage', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'buildings-coverage-fill',
        type: 'fill',
        source: 'buildings-coverage',
        paint: { 'fill-color': '#4a6785', 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: 'buildings-coverage-outline',
        type: 'line',
        source: 'buildings-coverage',
        paint: { 'line-color': '#4a6785', 'line-width': 1.5, 'line-dasharray': [3, 2] },
      });

      map.addSource('highlight', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'highlight-fill',
        type: 'fill',
        source: 'highlight',
        paint: { 'fill-color': '#ff6600', 'fill-opacity': 0.35 },
      });
      map.addLayer({
        id: 'highlight-outline',
        type: 'line',
        source: 'highlight',
        paint: { 'line-color': '#ff6600', 'line-width': 2 },
      });

      // 行政区域データ(N03)は市区町村・行政区までしか持たないため、
      // 丁目を選んでもポリゴンは区全体になる。どの丁目を選んだかは
      // 位置参照情報の代表点(ポイント)で示す。
      map.addSource('selected-point', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'selected-point-circle',
        type: 'circle',
        source: 'selected-point',
        paint: {
          'circle-radius': 7,
          'circle-color': '#d94500',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });
      // 地形は最後に有効にする。ここまで来ていれば、以降タイルが取れなくても
      // 起伏が出ないだけで地図は使える。起動を外部サービスに握らせない。
      map.setTerrain({ source: 'terrain', exaggeration: 1 });
      resolve(map);
    });
  });
}

async function main() {
  const input = document.querySelector<HTMLInputElement>('#search-input')!;
  const resultsEl = document.querySelector<HTMLUListElement>('#results')!;
  const clearButton = document.querySelector<HTMLButtonElement>('#clear-button')!;
  const pickButton = document.querySelector<HTMLButtonElement>('#pick-location')!;
  const loadingEl = document.querySelector<HTMLDivElement>('#loading')!;
  const loadingMessageEl = document.querySelector<HTMLParagraphElement>('#loading-message')!;
  const busyEl = document.querySelector<HTMLDivElement>('#busy')!;
  const busyLabelEl = document.querySelector<HTMLSpanElement>('#busy-label')!;
  const gotoBuildingsButton = document.querySelector<HTMLButtonElement>('#goto-buildings')!;
  const basemapSelect = document.querySelector<HTMLSelectElement>('#basemap')!;
  const buildingsSection = document.querySelector<HTMLDivElement>('#buildings-section')!;
  const sourceSelect = document.querySelector<HTMLSelectElement>('#building-source')!;
  const filtersEl = document.querySelector<HTMLDivElement>('#building-filters')!;
  const heightField = document.querySelector<HTMLDivElement>('#height-field')!;
  const usageField = document.querySelector<HTMLDivElement>('#usage-field')!;
  const minHeightInput = document.querySelector<HTMLInputElement>('#min-height')!;
  const minHeightValue = document.querySelector<HTMLOutputElement>('#min-height-value')!;
  const usageOptionsEl = document.querySelector<HTMLDivElement>('#usage-options')!;
  const usageAllButton = document.querySelector<HTMLButtonElement>('#usage-all')!;
  const usageNoneButton = document.querySelector<HTMLButtonElement>('#usage-none')!;
  const buildingCountEl = document.querySelector<HTMLParagraphElement>('#building-count')!;
  const meshSectionEl = document.querySelector<HTMLDivElement>('#mesh-section')!;
  const meshToggle = document.querySelector<HTMLInputElement>('#mesh-toggle')!;
  const meshControlsEl = document.querySelector<HTMLDivElement>('#mesh-controls')!;
  const aircraftSelect = document.querySelector<HTMLSelectElement>('#aircraft-class')!;
  const meshLegendBody = document.querySelector<HTMLTableSectionElement>('#mesh-legend tbody')!;
  const meshSummaryEl = document.querySelector<HTMLParagraphElement>('#mesh-summary')!;
  const creditsEl = document.querySelector<HTMLDListElement>('#credits')!;

  // DuckDB-WASMの初期化とParquetの読み込みには数秒かかるので、
  // 準備が終わるまでは操作できないことが分かるようにしておく。
  loadingMessageEl.textContent = '地図とデータベースを準備中…';
  let conn: duckdb.AsyncDuckDBConnection;
  let map: MapLibreMap;
  let buildingSources: BuildingSource[] = [];
  let meshSources: MeshSource[] = [];
  let ensureSpatial: () => Promise<void>;
  let ensureOaza: () => Promise<void>;
  try {
    const collections = await fetchCollections();
    const [db, createdMap] = await Promise.all([
      initDuckDb(collections),
      initMap(collections),
    ]);
    conn = db.conn;
    buildingSources = db.buildingSources;
    meshSources = db.meshSources;
    ({ ensureSpatial, ensureOaza } = db);
    map = createdMap;
    renderCredits(creditsEl, collections);
  } catch (e) {
    console.error('[init] failed', e);
    loadingEl.innerHTML = '<p>初期化に失敗しました。コンソールを確認してください。</p>';
    return;
  }
  // E2Eテストから地図の状態 (ハイライトされている地物など) を検証したり、
  // データの実際のURLを知るための足がかり。アプリ本体はこれを参照しない。
  // dataUrl を公開しているのは、データが別オリジン (オブジェクトストレージ) に
  // 移っても、テスト側を書き換えずに公開URLへ流せるようにするため。
  (window as unknown as TestHooks).__map = map;

  loadingEl.hidden = true;

  // 操作できるようになった後、使われそうなものを裏で用意しておく。
  // 待たないので操作は妨げないが、実際に使うころには済んでいることが多い。
  // (用意していないと、最初の検索やクリックでその場の待ち時間になる)
  void ensureOaza().catch((e: unknown) => console.error('[warmup] oaza', e));
  void ensureSpatial().catch((e: unknown) => console.error('[warmup] spatial', e));
  input.disabled = false;
  pickButton.disabled = false;
  input.focus();

  // 地図の切り替え。出典も maxzoom も tileSize も3種で同じなので、
  // ソースを作り直さずURLだけ差し替える。
  //
  // 地形の入切とは連動させない。自分で選んだものが別の操作で勝手に変わるのは、
  // 逆ジオコーディングを📍ボタンにしたときに取り除いた感覚と同じになる。
  for (const basemap of BASEMAPS) {
    const option = document.createElement('option');
    option.value = basemap.id;
    option.textContent = basemap.label;
    basemapSelect.append(option);
  }
  basemapSelect.value = BASEMAPS[0].id;
  basemapSelect.addEventListener('change', () => {
    const basemap = BASEMAPS.find((b) => b.id === basemapSelect.value);
    if (!basemap) return;
    (map.getSource('gsi') as RasterTileSource | undefined)?.setTiles([basemap.url]);
  });

  // 初期化のオーバーレイ (#loading) は上で消えるが、その後も数秒かかる操作がある。
  // 操作を先に触れる作りにしている以上、「触れる」と「終わっている」を
  // 見分ける手がかりが要る。
  //
  // 同時に複数走っても消えないよう、真偽値ではなく件数で持つ。
  let busyCount = 0;
  let failureTimer: ReturnType<typeof setTimeout> | undefined;

  const busy = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    busyCount += 1;
    clearTimeout(failureTimer);
    busyEl.classList.remove('failed');
    busyLabelEl.textContent = label;
    busyEl.hidden = false;
    try {
      return await run();
    } finally {
      busyCount -= 1;
      if (busyCount === 0) busyEl.hidden = true;
    }
  };

  /**
   * 失敗を画面にも出す。コンソールに残すのとは別の役割で、
   * console.error だけだと利用者には「何も起きない」としか見えない。
   */
  const showFailure = (message: string) => {
    console.error('[failure]', message);
    clearTimeout(failureTimer);
    busyLabelEl.textContent = message;
    busyEl.classList.add('failed');
    busyEl.hidden = false;
    // 出したままにすると次の操作の邪魔になる。他の処理が走っていなければ引っ込める。
    failureTimer = setTimeout(() => {
      if (busyCount > 0) return;
      busyEl.hidden = true;
      busyEl.classList.remove('failed');
    }, 5000);
  };

  // MapLibre v6 の setData は Promise を返す (v5までは同期)。await しないと
  // データ適用の完了を待てず、エラーも握り潰されるので必ず待つ。
  const setSourceData = async (sourceId: string, geometry: GeoJSON.Geometry | null) => {
    const source = map.getSource(sourceId) as GeoJSONSource | undefined;
    if (!source) return;
    await source.setData(
      geometry ? { type: 'Feature', properties: {}, geometry } : EMPTY_FEATURE_COLLECTION,
    );
  };

  // 逆ジオコーディングの結果を出すポップアップ。1つを使い回す。
  //
  // closeOnClick を切ってあるのは、建物を見るつもりのクリックで結果が消えると、
  // 📍ボタン化して消したはずの「勝手に変わる」感覚が戻ってくるため。
  // 消すのは×かEscだけにする。
  const popup = new Popup({ closeButton: true, closeOnClick: false });

  // ハイライトとポップアップは1つの結果なので、片方を閉じたら両方消す。
  const clearHighlight = () => {
    Promise.all([setSourceData('highlight', null), setSourceData('selected-point', null)]).catch(
      (e: unknown) => console.error('[clearHighlight] failed', e),
    );
  };
  popup.on('close', clearHighlight);

  const clearSearch = () => {
    input.value = '';
    resultsEl.innerHTML = '';
    clearButton.hidden = true;
    // 開いていれば close が飛んで clearHighlight も走るが、開いていないときの
    // ために自分でも消す (どちらも繰り返して困らない)。
    popup.remove();
    clearHighlight();
    input.focus();
  };

  const showResult = async (result: SearchResult) => {
    // 地名(代表点しか無い)はその地点へ飛ぶ。ポリゴンは消す。
    if (result.kind === 'oaza') {
      await Promise.all([
        setSourceData('highlight', null),
        setSourceData('selected-point', {
          type: 'Point',
          coordinates: [result.lon, result.lat],
        }),
      ]);
      map.flyTo({ center: [result.lon, result.lat], zoom: 16, duration: 1500 });
      return;
    }

    // 行政区域は面をハイライトして全体が入るように寄る。
    // ポリゴン取得を待たずにカメラを動かすと、後から呼ぶ fitBounds が
    // アニメーションを横取りしてしまうので、取得を終えてから1回だけ動かす。
    //
    // 逆ジオコーディングでは名前が先に出るので、ここが無言だと
    // 「地名だけ出てポリゴンが出ない」ように見える。大きい自治体ほど重い
    // (対馬市で70,848頂点) ので、待っていることを知らせる。
    const polygon = await busy('範囲を読み込み中…', async () => {
      await ensureSpatial();
      return fetchAdminPolygon(conn, result.adminId);
    });
    if (!polygon) {
      console.warn('admin polygon not found for admin_id', result.adminId);
      showFailure('範囲を取得できませんでした');
      return;
    }

    await Promise.all([
      setSourceData('highlight', polygon.geojson),
      setSourceData('selected-point', null),
    ]);
    map.fitBounds(
      [
        [polygon.bbox[0], polygon.bbox[1]],
        [polygon.bbox[2], polygon.bbox[3]],
      ],
      { padding: 40, duration: 1500 },
    );
  };

  const renderResults = (rows: SearchResult[]) => {
    resultsEl.innerHTML = '';

    // 何も出さないと一覧ごと消えて (#results:empty)、読み込み中と区別がつかない。
    // 地名は収録した都道府県の分しか無いので、この状態には普通に到達する。
    if (rows.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '該当する地名がありません';
      resultsEl.appendChild(li);
      return;
    }

    for (const row of rows) {
      const li = document.createElement('li');
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = row.kind === 'admin' ? '行政区域' : '地名';
      li.append(badge, row.label);
      li.addEventListener('click', () => {
        resultsEl.innerHTML = '';
        input.value = row.label;
        showResult(row).catch((e: unknown) => console.error('[showResult] failed', e));
      });
      resultsEl.appendChild(li);
    }
  };

  let debounceTimer: number | undefined;
  const runSearch = (debounceMs: number) => {
    window.clearTimeout(debounceTimer);
    const keyword = input.value.trim();
    clearButton.hidden = keyword.length === 0;
    if (keyword.length === 0) {
      resultsEl.innerHTML = '';
      return;
    }
    debounceTimer = window.setTimeout(() => {
      // 初回は ensureOaza の読み込みを待つので、ここだけ数秒かかることがある。
      busy('検索中…', async () => {
        await ensureOaza();
        return searchAddress(conn, keyword);
      })
        .then(renderResults)
        .catch((e: unknown) => {
          console.error('[searchAddress] failed', e);
          showFailure('検索に失敗しました');
        });
    }, debounceMs);
  };

  input.addEventListener('input', () => runSearch(200));
  // 候補を選ぶと一覧を閉じるので、再びフォーカスしたときに候補を出し直す。
  // (入力を変えないと候補が出ないのは分かりにくい)
  input.addEventListener('focus', () => runSearch(0));
  input.addEventListener('blur', () => {
    resultsEl.innerHTML = '';
  });
  // 候補のクリックは blur より先に mousedown が走る。既定動作を止めて
  // フォーカスを外させないと、click が発火する前に一覧が消えてしまう。
  resultsEl.addEventListener('mousedown', (e) => e.preventDefault());

  clearButton.addEventListener('click', clearSearch);

  // 建物は件数が多いので、ある程度寄ったときだけ表示範囲の分を読み込む。
  const BUILDINGS_MIN_ZOOM = 15;
  const BUILDINGS_LIMIT = 3000;
  // 高さを持つ建物を表示するときの傾き。
  // 60度まで倒せるが、そこまでいくと表示範囲 (getBounds) が真上から見たときの
  // 7.1倍まで広がる。50度なら3.1倍で、立体感は十分に出る。
  const BUILDINGS_PITCH = 50;
  let buildingsToken = 0;

  // 選択中の出所と絞り込み条件。UIから書き換わる。
  let activeSource: BuildingSource | undefined = buildingSources[0];
  const filter: BuildingFilter = { minHeight: 0, usages: null };

  const refreshBuildings = async () => {
    const mapSource = map.getSource('buildings') as GeoJSONSource | undefined;
    const coverage = map.getSource('buildings-coverage') as GeoJSONSource | undefined;
    if (!mapSource || !activeSource) return;

    // 建物が出ないズームでは、代わりに収録範囲の枠を出す。
    const zoomedOut = map.getZoom() < BUILDINGS_MIN_ZOOM;
    await coverage?.setData(
      zoomedOut && activeSource.bbox
        ? bboxFeatureCollection(activeSource.bbox)
        : EMPTY_FEATURE_COLLECTION,
    );

    if (zoomedOut) {
      await mapSource.setData(EMPTY_FEATURE_COLLECTION);
      buildingCountEl.textContent = '拡大すると建物が出ます';
      return;
    }

    // 連続して地図を動かしたりスライダーを動かしたりすると古い結果が後から届くので、
    // 最新の要求以外は捨てる。
    const token = ++buildingsToken;
    const source = activeSource;
    // 取得を始める前に件数表示を空にする。引いていたときの「拡大すると建物が出ます」が
    // 残っていると、すでに寄っている利用者に拡大しろと言い続けることになる。
    buildingCountEl.textContent = '';
    const rows = await busy('建物を読み込み中…', async () => {
      await source.ensure();
      const b = map.getBounds();
      const c = map.getCenter();
      return fetchBuildingsInView(
        conn,
        source,
        {
          west: b.getWest(),
          south: b.getSouth(),
          east: b.getEast(),
          north: b.getNorth(),
          centerLon: c.lng,
          centerLat: c.lat,
        },
        filter,
        BUILDINGS_LIMIT,
      );
    });
    if (token !== buildingsToken) return;

    await mapSource.setData({
      type: 'FeatureCollection',
      features: rows.map((row) => ({
        type: 'Feature',
        properties: { name: row.name, category: row.category, height: row.height },
        geometry: row.geojson,
      })),
    });
    buildingCountEl.textContent =
      rows.length >= BUILDINGS_LIMIT
        ? `${BUILDINGS_LIMIT}件以上 (表示上限)`
        : `${rows.length}件`;
  };

  const requestRefresh = () => {
    refreshBuildings().catch((e: unknown) => {
      console.error('[buildings] failed', e);
      showFailure('建物の読み込みに失敗しました');
    });
  };

  // ---- 人口密度 (SORAの地上リスク) ----

  /** 選んでいる機体の区分。iGRC表の列にあたる。 */
  let aircraftIndex = 0;
  let meshToken = 0;

  /** 凡例を作り直す。機体を変えると iGRC の値が変わる。 */
  const renderLegend = () => {
    meshLegendBody.replaceChildren();
    // 密度が高い側を上に出す。危ない方から目に入る並びにする。
    for (const band of [...IGRC_BANDS].reverse()) {
      const row = document.createElement('tr');
      const range = document.createElement('td');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = band.color;
      range.append(swatch, document.createTextNode(band.label));

      const igrc = document.createElement('td');
      const value = band.igrc[aircraftIndex];
      if (value === null) {
        igrc.className = 'out-of-scope';
        igrc.textContent = '範囲外';
        igrc.title = 'SORAの適用範囲外';
      } else {
        igrc.textContent = String(value);
      }
      row.append(range, igrc);
      meshLegendBody.append(row);
    }
  };

  /** いま地図にメッシュを載せているか。空を載せ直す無駄を避けるために持つ。 */
  let meshShown = false;

  const refreshMesh = async () => {
    const mapSource = map.getSource('population-mesh') as GeoJSONSource | undefined;
    if (!mapSource) return;

    /**
     * メッシュを消す。**既に空なら何もしない。**
     *
     * `moveend` は地図を動かすたびに飛ぶので、消えている状態で毎回 `setData` を
     * 呼ぶと、空のデータをワーカーへ往復させ続けることになる。建物の描画と
     * 同じワーカーを使うため、そこの取り合いになる。
     */
    const clear = async (message: string) => {
      if (meshShown) {
        await mapSource.setData(EMPTY_FEATURE_COLLECTION);
        meshShown = false;
      }
      meshSummaryEl.textContent = message;
    };

    if (!meshToggle.checked) {
      await clear('');
      return;
    }

    const zoom = map.getZoom();
    const digits = meshDigits(zoom);
    // 要求する細かさを出せる出所が無ければ出せない。125mしか配っていない状態で
    // 引くと、これに当たる代わりに125mから束ねることになっていた。
    const source = meshSourceFor(meshSources, digits);
    if (!source) {
      await clear('この縮尺の人口密度は配信されていません');
      return;
    }

    const token = ++meshToken;
    const cells = await busy('人口密度を読み込み中…', async () => {
      await source.ensure();
      const b = map.getBounds();
      const c = map.getCenter();
      return fetchMeshInView(
        conn,
        source,
        {
          west: b.getWest(),
          south: b.getSouth(),
          east: b.getEast(),
          north: b.getNorth(),
          centerLon: c.lng,
          centerLat: c.lat,
        },
        digits,
      );
    });
    if (token !== meshToken) return;

    meshShown = true;
    await mapSource.setData({
      type: 'FeatureCollection',
      features: cells.map(({ code, population, density }) => {
        // 矩形はメッシュコードから計算する。中に入っている子のbboxの和で描くと、
        // 人のいる子だけを囲った細長い形になり、メッシュに見えなくなる。
        const [west, south, east, north] = meshBounds(code);
        return {
          type: 'Feature',
          // 色は引くときに決めてしまう。スタイル式で段を組むより、
          // 凡例と同じ一つの表 (`IGRC_BANDS`) から作る方がずれない。
          properties: { population, density, color: igrcBand(density).color },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
              ],
            ],
          },
        };
      }),
    });

    // **表示範囲の最大値を出す。** SORAは運航範囲の中で最も密度の高いところを採るので、
    // 地図から目で探させるより数字で出す方が確実。
    if (cells.length === 0) {
      meshSummaryEl.textContent = 'この範囲に人口メッシュがありません';
      return;
    }
    const peak = cells.reduce((max, cell) => Math.max(max, cell.density), 0);
    const band = igrcBand(peak);
    const igrc = band.igrc[aircraftIndex];
    const size = MESH_SIZE_LABELS[digits] ?? `${digits}桁`;
    meshSummaryEl.textContent =
      `${size}メッシュ / 表示範囲の最大 ${Math.round(peak).toLocaleString()} 人/km² ` +
      `(iGRC ${igrc === null ? '範囲外' : igrc})`;
  };

  const requestMeshRefresh = () => {
    refreshMesh().catch((e: unknown) => {
      console.error('[mesh] failed', e);
      showFailure('人口密度の読み込みに失敗しました');
    });
  };

  if (meshSources.length > 0) {
    meshSectionEl.hidden = false;
    for (const [index, { label }] of AIRCRAFT_CLASSES.entries()) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = label;
      aircraftSelect.append(option);
    }
    renderLegend();

    meshToggle.addEventListener('change', () => {
      meshControlsEl.hidden = !meshToggle.checked;
      requestMeshRefresh();
    });
    // 機体を変えても地図の色は変わらない (色は密度の帯で決まる)。
    // 変わるのは凡例と要約に出る iGRC の値だけなので、引き直さない。
    aircraftSelect.addEventListener('change', () => {
      aircraftIndex = Number(aircraftSelect.value);
      renderLegend();
      requestMeshRefresh();
    });
    map.on('moveend', requestMeshRefresh);
  }

  if (activeSource) {
    map.on('moveend', requestRefresh);
    buildingsSection.hidden = false;

    for (const source of buildingSources) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.label;
      sourceSelect.append(option);
    }
    // 出所が1つしか無ければ選ばせる意味がない。
    sourceSelect.disabled = buildingSources.length < 2;

    /** チェック状態を条件に反映する。全部入っていれば「絞っていない」= null。 */
    const syncUsageFilter = (all: string[]) => {
      const checked = [...usageOptionsEl.querySelectorAll<HTMLInputElement>('input:checked')];
      filter.usages = checked.length === all.length ? null : checked.map((c) => c.value);
      requestRefresh();
    };

    // 選択肢はカタログに入っているので、**ここでデータを読まない**。
    // 以前はここで全ファイルの用途の列を走査していて、起動のたびに
    // ファイルの数だけ往復していた。
    const showFilters = (source: BuildingSource) => {
      heightField.hidden = !source.hasHeight;
      usageField.hidden = source.categoryColumn === null;
      filtersEl.hidden = !source.hasHeight && source.categoryColumn === null;

      if (source.categoryColumn === null) return;
      const usages = source.usages;

      // 出所ごとに語彙が違うので、切り替えのたびに作り直す。
      usageOptionsEl.replaceChildren();
      for (const usage of usages) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = usage;
        checkbox.checked = true;
        checkbox.addEventListener('change', () => syncUsageFilter(usages));
        label.append(checkbox, document.createTextNode(usage));
        usageOptionsEl.append(label);
      }

      // 1つだけ見たいときに13個外させない。「なし」→目的の1つ、で済むようにする。
      const setAll = (checked: boolean) => {
        for (const input of usageOptionsEl.querySelectorAll<HTMLInputElement>('input')) {
          input.checked = checked;
        }
        syncUsageFilter(usages);
      };
      usageAllButton.onclick = () => setAll(true);
      usageNoneButton.onclick = () => setAll(false);
    };

    sourceSelect.addEventListener('change', () => {
      activeSource = buildingSources.find((s) => s.id === sourceSelect.value);
      if (!activeSource) return;
      // 出所を変えたら絞り込みは初期状態に戻す。
      // 用途の語彙が出所ごとに違うので、そのまま持ち越すと意味が変わる。
      filter.usages = null;
      // どちらの出所も高さの列を持ち立体で描かれるので、傾きは出所で変えない。
      showFilters(activeSource);
      requestRefresh();
    });
    showFilters(activeSource);
    // 収録範囲の枠は refreshBuildings が出すが、その呼び出しは moveend でしか
    // 起きない。起動直後にも一度呼んでおかないと、地図を動かすまで枠が出ない。
    requestRefresh();

    // スライダーは動かすたびにイベントが飛ぶので、少し待ってからクエリする。
    let heightTimer: ReturnType<typeof setTimeout> | undefined;
    minHeightInput.addEventListener('input', () => {
      filter.minHeight = Number(minHeightInput.value);
      minHeightValue.textContent = `${filter.minHeight} m`;
      clearTimeout(heightTimer);
      heightTimer = setTimeout(requestRefresh, 200);
    });

    // 建物は一部の範囲しか収録していないうえ、寄らないと出てこない。
    // 偶然そこへ行かないと機能に気づけないので、移動する手段を出しておく。
    const bbox = unionBbox(
      buildingSources.map((s) => s.bbox).filter((b): b is Bbox => b !== null),
    );
    if (bbox) {
      const [west, south, east, north] = bbox;
      gotoBuildingsButton.hidden = false;
      gotoBuildingsButton.addEventListener('click', () => {
        // flyTo に1.5秒かかり、その後の moveend まで refreshBuildings は始まらない。
        // 押した感触が無いと二度押しされるので、移動そのものを合図の対象にする。
        // 続けて refreshBuildings 側の合図が立つので、表示は途切れない。
        void busy(
          '建物のある範囲へ移動中…',
          () => new Promise<void>((resolve) => map.once('moveend', () => resolve())),
        );
        // 収録範囲の全体を映すのではなく、その中心に寄る。
        // fitBounds だと範囲が広いときに BUILDINGS_MIN_ZOOM を下回り、
        // 移動した先で建物が出ないという逆の結果になる。
        map.flyTo({
          center: [(west + east) / 2, (south + north) / 2],
          zoom: BUILDINGS_MIN_ZOOM + 1,
          // 立体で見せたいので傾ける。真上に戻したいときはコンパスを押す。
          pitch: BUILDINGS_PITCH,
          duration: 1500,
        });
      });
    }
  }

  // 操作の役割分担:
  //   ホバー = 調べる (建物の情報を見るだけ。地図は動かさない)
  //   📍を押してからクリック = 選ぶ (逆ジオコーディングして行政区域をハイライトする)
  //
  // 逆ジオコーディングは結果の行政区域が全部入るまで地図を引く (showResult の
  // fitBounds)。常時オンだと、建物を眺めている最中のクリックで見ていた場所も
  // 傾きもまとめて失われるので、押したときだけ効かせる。

  // 待ち受け中は十字、建物の上ではポインタ。どちらも同じ canvas の style を
  // 触るので、条件をここに集めて一箇所から書く。
  let picking = false;
  let hoveringBuilding = false;
  const updateCursor = () => {
    map.getCanvas().style.cursor = picking ? 'crosshair' : hoveringBuilding ? 'pointer' : '';
  };

  const setPicking = (on: boolean) => {
    picking = on;
    pickButton.setAttribute('aria-pressed', String(on));
    updateCursor();
  };

  pickButton.addEventListener('click', () => setPicking(!picking));

  // Escの出口を1本にまとめる。押している最中なら解除が先、そうでなければ
  // 出ている結果を消す。window で拾うのは、判定した直後はフォーカスが地図側にあり、
  // 検索欄に付けていると効かないため。
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (picking) {
      setPicking(false);
      return;
    }
    clearSearch();
  });

  // ホバー用。マウスを追うだけなので閉じるボタンは出さない。
  const hoverPopup = new Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 12,
  });

  if (activeSource) {
    map.on('mousemove', 'buildings-3d', (e) => {
      const building = e.features?.[0];
      if (!building) return;
      hoveringBuilding = true;
      updateCursor();

      const props = building.properties;
      const text = [
        (props.name as string | null) ?? '(名称なし)',
        props.category ? `用途: ${props.category as string}` : null,
        props.height ? `高さ: ${props.height as number}m` : null,
      ]
        .filter(Boolean)
        .join('\n');
      hoverPopup.setLngLat(e.lngLat).setText(text).addTo(map);
    });

    map.on('mouseleave', 'buildings-3d', () => {
      hoveringBuilding = false;
      updateCursor();
      hoverPopup.remove();
    });
  }

  // 逆ジオコーディング: クリックした地点がどの行政区域かを引き、
  // その区域をハイライトしてポップアップで名前を出す (popup は上で用意している)。
  map.on('click', (e) => {
    if (!picking) return;
    // 1クリックで解除する。押しっぱなしのモードにすると、今どちらの状態かを
    // 覚えていないと次のクリックの結果が読めなくなる。
    setPicking(false);

    const { lng, lat } = e.lngLat;
    popup.setLngLat(e.lngLat).setText('判定中…').addTo(map);

    busy('地点を判定中…', async () => {
      await ensureSpatial();
      return reverseGeocode(conn, lng, lat);
    })
      .then(async (hit) => {
        if (!hit) {
          popup.setText('該当する行政区域はありません (海上など)');
          return;
        }
        popup.setText(hit.label);
        input.value = hit.label;
        clearButton.hidden = false;
        await showResult({ kind: 'admin', label: hit.label, adminId: hit.adminId });
      })
      .catch((err: unknown) => {
        console.error('[reverseGeocode] failed', err);
        popup.setText('判定に失敗しました');
      });
  });
}

void main();
