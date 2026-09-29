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
 * catalog.json                      ← Catalog。出所ごとのサブカタログへの child リンク
 * estat/catalog.json                ← Catalog (サブカタログ)。「国勢調査」
 * estat/estat-mesh-pop.json         ← Collection。何があるか。件数で増えない
 * estat/estat-mesh-pop-items.json   ← ItemCollection。ファイル1つずつの href と bbox
 * ```
 *
 * **起動時に読むのは Catalog と Collection だけ。** Item は使う段になって読む。
 * 1ファイルに全部入れていた頃は、人口メッシュ47件で72KBまで膨らんでいた。
 *
 * **レイヤーの一覧はこの階層で組む。** サブカタログが見出し、Collectionが行。
 * 画面を読むことがそのままカタログを歩くことになるようにしてある。
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
  | 'building_coverage'
  | 'population_mesh'
  | 'railway'
  | 'railway_station'
  | 'road'
  | 'road_route';

/** STAC Catalog。ルートと、出所ごとのサブカタログ。 */
interface StacCatalog {
  type: 'Catalog';
  id: string;
  title?: string;
  description?: string;
  links: StacLink[];
}

/** STAC Collection。`duck:` の付いたものはSTACに無い独自項目。 */
interface StacCollection {
  type: 'Collection';
  id: string;
  title?: string;
  description?: string;
  /** SPDX識別子か "other"。 */
  license?: string;
  providers?: { name: string; roles?: string[]; url?: string }[];
  /** 種別。UIが扱いを切り替えるのに使う。STACにこの概念は無い。 */
  'duck:kind': DatasetKind;
  /** 地図に出す出典の文言。**表示義務があるので縮めない。** */
  'duck:attribution': string;
  'duck:attribution_url': string;
  /** 地域メッシュの細かさ (メッシュコードの桁数)。メッシュ以外には無い。 */
  'duck:mesh_digits'?: number;
  /**
   * **粗い段の簡略化の許容誤差 (メートル)。** 段を持つファイルにだけ付く。
   *
   * 付いていれば、引いた表示で `lod = 0` の行 (統合して簡略化したもの) を引ける。
   * どのズームまで粗い段で足りるかは [`coarseLodUntilZoom`] が誤差から決めるので、
   * **ズーム閾値をここに書かない。**
   */
  'duck:coarse_lod_tolerance_m'?: number;
  /**
   * **どのCollectionの整備範囲か** (`"plateau-buildings"`)。
   *
   * 整備範囲のメッシュだけが持つ。これを見て建物に結び付ける。
   * 「PLATEAUのものだ」とここで決め打ちすると、出所が増えたときに
   * 書き足す場所が分かれる。
   */
  'duck:covers'?: string;
  /**
   * **いつ時点のデータか。** 配布元が名乗っている形 (`N02-25 (2026-03-06)` など)。
   *
   * ファイルごとに版が違うCollection (PLATEAUは都市ごとに更新年度が揃っていない)
   * には入っていない。**古いものを新しいと思って使う事故を防ぐためのもの**なので、
   * 揃っていないものを代表値で1つに丸めない。
   */
  'duck:vintage'?: string;
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
  properties: {
    'table:row_count'?: number;
    /** 原典にあるLOD ("1,2,3")。**配信しているものより細かいものが原典にある**ときだけ付く。 */
    'duck:source_lod'?: string;
  };
  assets: { data: { href: string } };
}

/**
 * Itemと、それを載せていた文書の位置。
 *
 * **アセットのhrefはその文書からの相対**なので、解決するには文書の位置が要る。
 */
interface LocatedItem {
  feature: StacItem;
  /** ItemCollectionの、配信の起点からのパス。 */
  base: string;
}

/**
 * 出所のまとまり (サブカタログ)。**レイヤー一覧の見出しになる。**
 *
 * 「PLATEAU」「Overture Maps」をここで決め打ちしない。カタログが名乗っている
 * ものをそのまま出すので、出所が増えればパイプライン側で1行足すだけで済む。
 */
interface CatalogGroup {
  id: string;
  title: string;
  description: string;
  /** この文書の、配信の起点からのパス。JSONそのものを見せるのに使う。 */
  path: string;
}

/** Collectionを扱いやすい形にしたもの。Itemは呼ばれるまで読まない。 */
interface Collection {
  id: string;
  kind: DatasetKind;
  title: string;
  description: string;
  /** SPDX識別子か "other"。 */
  license: string;
  /** 組織名 (STACの `providers[].name`)。 */
  provider: string | undefined;
  /**
   * どのサブカタログの下にあるか。**ルート直下に置かれたCollectionは undefined**
   * (サブカタログを挟む前の平らなカタログもそう読める)。
   */
  group: CatalogGroup | undefined;
  /** Collection文書の、配信の起点からのパス。 */
  path: string;
  /** ItemCollection文書の、配信の起点からのパス。無ければ undefined。 */
  itemsPath: string | undefined;
  attribution: string;
  attributionUrl: string;
  /**
   * 配布元。**ここにあるのは変換した複製で、原典は配布元にある。**
   * 実物が欲しくなった人が辿れるようにする (STACの `rel: "via"`)。
   */
  via: string | undefined;
  /** 収録範囲 (Item全部の和)。Itemを読まずに分かる。 */
  bbox: Bbox | null;
  summaries: Record<string, string[]>;
  /** 列名。何で絞れるかをこれで決める。 */
  columns: Set<string>;
  /** 地域メッシュの細かさ (メッシュコードの桁数)。メッシュ以外は undefined。 */
  meshDigits: number | undefined;
  /** 粗い段の許容誤差 (メートル)。段が無ければ undefined。 */
  coarseLodToleranceM: number | undefined;
  /** どのCollectionの整備範囲か。整備範囲のメッシュ以外は undefined。 */
  covers: string | undefined;
  /** いつ時点のデータか。**ファイルごとに版が違うものには入っていない。** */
  vintage: string | undefined;
  /** Itemを読む。**Collectionごとに1回だけ**通信する。 */
  items: () => Promise<LocatedItem[]>;
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

/** 配信の起点にある唯一のファイル。ここから全部を辿る。 */
const CATALOG_PATH = 'catalog.json';

/**
 * STACの相対リンクを、配信の起点からのパスに直す。
 *
 * **STACの相対リンクは「その文書からの相対」。** `overture/roads.json` の中の
 * `roads-items.json` は `overture/roads-items.json` を指す。
 * ここが配信の起点からの相対だと思って読むと、階層を作った瞬間に壊れる。
 *
 * 起点からのパスに正規化して返すのは、**この文字列がDuckDBの登録名を兼ねる**ため
 * (`registerFileURL`)。同じファイルを別の文字列で二重登録しないよう、
 * どの文書から辿っても同じ形にする。
 *
 * `base` は参照元の文書の、起点からのパス (`catalog.json` や `overture/roads.json`)。
 */
function resolveHref(href: string, base: string): string {
  // 絶対URLはそのまま通す (配布元へのリンクなど、起点の外を指すものがある)。
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  // URLの解決規則に任せる。起点は実在しなくてよいので固定の土台を置く。
  const root = 'https://duck.invalid/';
  return new URL(href, new URL(base, root)).href.slice(root.length);
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

async function fetchStac<T>(path: string): Promise<T> {
  const response = await fetch(dataUrl(path));
  if (!response.ok) {
    throw new Error(
      `${path} が読めません (${response.status})。` +
        '`cargo run --bin build_catalog -- ../data/output` を実行してください。',
    );
  }
  return (await response.json()) as T;
}

/**
 * Catalogから全Collectionを読む。**カタログに書かれた順に返す** (一覧の並びになる)。
 *
 * Collectionは**ファイルが増えても大きくならない** (収録範囲は全体の1件だけ、
 * 列構成と語彙は出所ごとに1つ) ので、起動時に全部読んでよい。
 * ファイル1つずつの情報を持つItemは、使う段になってから読む。
 */
async function fetchCollections(): Promise<Collection[]> {
  const catalog = await fetchStac<StacCatalog>(CATALOG_PATH);
  return walkCatalog(catalog, CATALOG_PATH, undefined);
}

/**
 * Catalogの子を辿る。**子がCatalogなら降り、Collectionならそこで止まる。**
 *
 * STACはどちらも子にできる。種類はリンクではなく**文書の `type`** で見分ける
 * (リンクの `type` はメディアタイプで、どちらも `application/json`)。
 *
 * 兄弟は並べて取る。サブカタログを挟んだぶん往復は1段増えるが、
 * 1段の中は並列なので、起動の待ちは1往復ぶんしか伸びない。
 */
async function walkCatalog(
  catalog: StacCatalog,
  path: string,
  group: CatalogGroup | undefined,
): Promise<Collection[]> {
  const children = catalog.links.filter((link) => link.rel === 'child');
  const nested = await Promise.all(
    children.map(async (link) => {
      // **文書の位置を持ち回る。** 中のリンクはその文書からの相対なので、
      // どこにある文書だったかを知らないと解決できない。
      const childPath = resolveHref(link.href, path);
      const document = await fetchStac<StacCatalog | StacCollection>(childPath);
      if (document.type === 'Collection') return [toCollection(document, childPath, group)];
      return walkCatalog(document, childPath, {
        id: document.id,
        title: document.title ?? document.id,
        description: document.description ?? '',
        path: childPath,
      });
    }),
  );
  return nested.flat();
}

function toCollection(
  document: StacCollection,
  path: string,
  group: CatalogGroup | undefined,
): Collection {
  // 空間範囲は「先頭が全体」。ジオメトリを持たないデータセットは null が並ぶ。
  const [extent] = document.extent.spatial.bbox;
  const bbox =
    extent?.length === 4 && extent.every((value) => typeof value === 'number')
      ? (extent as Bbox)
      : null;

  const itemsHref = document.links.find((link) => link.rel === 'items')?.href;
  const itemsPath = itemsHref ? resolveHref(itemsHref, path) : undefined;
  let items: Promise<LocatedItem[]> | undefined;

  return {
    id: document.id,
    kind: document['duck:kind'],
    title: document.title ?? document.id,
    description: document.description ?? '',
    license: document.license ?? 'other',
    provider: document.providers?.[0]?.name,
    group,
    path,
    itemsPath,
    attribution: document['duck:attribution'],
    attributionUrl: document['duck:attribution_url'],
    via: document.links.find((link) => link.rel === 'via')?.href,
    meshDigits: document['duck:mesh_digits'],
    coarseLodToleranceM: document['duck:coarse_lod_tolerance_m'],
    covers: document['duck:covers'],
    vintage: document['duck:vintage'],
    bbox,
    summaries: document.summaries ?? {},
    columns: new Set(
      (document.item_assets?.data?.['table:columns'] ?? []).map((column) => column.name),
    ),
    items: () =>
      (items ??= itemsPath
        ? fetchStac<{ features: StacItem[] }>(itemsPath).then((collection) =>
            // Itemのアセットは**ItemCollectionの文書からの相対**。
            collection.features.map((feature) => ({ feature, base: itemsPath })),
          )
        : Promise.resolve([])),
  };
}

/** Itemのアセットを、配信の起点からのパスに直す。 */
function itemFile(item: LocatedItem): string {
  return resolveHref(item.feature.assets.data.href, item.base);
}

/** Itemを配信パスと収録範囲の組にする。 */
function itemFiles(items: LocatedItem[]): ItemFile[] {
  return items.map(({ feature, base }) => ({
    file: resolveHref(feature.assets.data.href, base),
    bbox: feature.bbox?.length === 4 ? (feature.bbox as Bbox) : null,
    sourceLod: parseSourceLod(feature.properties['duck:source_lod']),
  }));
}

/** ファイル1つ分。収録範囲と、原典がどこまで細かいか。 */
interface ItemFile {
  file: string;
  bbox: Bbox | null;
  /** 原典にあるLOD (昇順)。無ければ空。 */
  sourceLod: number[];
}

/**
 * "1,2,3" を [1,2,3] にする。
 *
 * **読めない値は捨てる。** 配信側の形が変わっても、LODの表示が消えるだけで
 * 建物そのものは出る。
 */
function parseSourceLod(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((lod) => Number.isFinite(lod))
    .sort((a, b) => a - b);
}

/**
 * 検索結果は2種類ある。
 * - admin: 行政区域。面を持つので選択するとポリゴンをハイライトする。
 * - oaza:  大字・町丁目(位置参照情報)。代表点しか無いのでその地点へ飛ぶ。
 */
type SearchResult =
  | { kind: 'admin'; label: string; adminId: string }
  | { kind: 'oaza'; label: string; lon: number; lat: number }
  // 駅。**人が実際に検索する語**なので、地名と並べて出す。
  | { kind: 'station'; label: string; detail: string; lon: number; lat: number }
  // 路線。点ではなく**範囲**なので、飛び先は fitBounds になる。
  // 線そのものは選んだときに読んでハイライトする (`lineName` / `operator` で引く)。
  | { kind: 'line'; label: string; detail: string; bbox: Bbox; lineName: string; operator: string }
  | { kind: 'route'; label: string; detail: string; bbox: Bbox; routeName: string };

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
/**
 * この桁のメッシュ1つに入る1kmセルの数。
 *
 * JIS X 0410 は 4桁 (80km) → 6桁 (10km) → 8桁 (1km) で、
 * 4→6 は緯度経度それぞれ8分割 (8×8)、6→8 は10分割 (10×10)。
 */
function meshCellCapacity(digits: number): number {
  if (digits >= 8) return 1;
  if (digits === 6) return 100;
  if (digits === 4) return 64 * 100;
  throw new Error(`想定していないメッシュの桁数: ${digits}`);
}

/**
 * 整備範囲のメッシュをGeoJSONにする。
 *
 * **矩形はメッシュコードから計算する** (人口メッシュと同じ)。配られた
 * ジオメトリを使わないのは、コードを前から切って束ねたあとの大きさで
 * 描きたいため。
 *
 * **濃淡は充足率で付ける。** 建物の数で濃くすると人口密集部が濃くなるだけで、
 * 「整備されているか」とは別のものを見せてしまう。代わりに
 * **束ねたセルのうち何割にデータがあるか**で塗る。1つでも子があれば塗る形だと、
 * 日本全体が見えるまで引いたときにほぼ全国が埋まって見えてしまうため。
 *
 * **沿岸のセルは決して100%にならない** — 海の子セルは元々データを持てない。
 * つまりこれは「整備率」ではなく**このセルの面積のうちデータがある割合**。
 */
function coverageFeatureCollection(cells: CoverageCell[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cells.map(({ code, buildings, filled, cities }) => {
      const [west, south, east, north] = meshBounds(code);
      const total = meshCellCapacity(code.length);
      return {
        type: 'Feature',
        // **メッシュだと分かる印を持たせる。** 収録範囲の枠も同じソースを
        // 使い回しているので、描き分けと当たり判定をこれで見分ける。
        properties: {
          mesh: true,
          code,
          buildings,
          filled,
          total,
          ratio: filled / total,
          cities: cities.join('、'),
        },
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
  };
}

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
  /** Collectionの識別子。**一覧の行IDも兼ねる。** 名前はカタログ (サブカタログの題名) が持つ。 */
  id: string;
  /**
   * このデータセットを構成するファイルと、それぞれの収録範囲。
   *
   * **`ensure()` を呼ぶまで空。** Itemを読まないと分からないため。
   * 収録範囲の枠 (`bbox`) と絞り込みの選択肢はCollectionだけで作れるので、
   * 寄って実際に引くまでItemを取りに行かずに済む。
   */
  files: ItemFile[];
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
  /**
   * **引いた表示で出す整備範囲。** 無ければ引いた表示では何も出さない。
   *
   * 建物そのものを引いた表示で出す道は無い — 簡略化はズーム12でフットプリントが
   * 1px未満になって効かず、高さで選ぶのは基準に意味を持たせられなかった
   * (2Dなら面積、3Dなら高さで見たいものが違い、「引きで見たい施設」は
   * そのどちらとも別の概念)。**代わりに「どこまで整備されているか」を出す。**
   */
  coverage: BuildingCoverage | undefined;
}

/**
 * 整備範囲のメッシュ。[`BuildingSource.coverage`] が持つ。
 *
 * **1kmで配られている。** 粗くするのはコードを前から切るだけで済む
 * (人口メッシュと同じ仕組み)。
 */
interface BuildingCoverage {
  files: ItemFile[];
  /** 配られている細かさ (メッシュコードの桁数)。これより細かくはできない。 */
  meshDigits: number;
  ensure: () => Promise<void>;
}

/**
 * 人口メッシュの出所。**SORAの地上リスクを見るためのもの。**
 *
 * 建物と違って「引いた状態で見たい」データなので、ズームに応じて
 * メッシュを粗くして出す ([`meshDigits`])。
 */
/**
 * 鉄道 (国土数値情報 N02)。路線と駅で列構成が違うので別のCollectionになっている。
 *
 * **駅のジオメトリも線**。原典がホームの延長を線で持っているので、点ではない。
 */
interface RailwaySource {
  id: string;
  /** 路線か駅か。描き分けと、駅名を引くかどうかに使う。 */
  kind: 'railway' | 'railway_station';
  bbox: Bbox | null;
  files: ItemFile[];
  /** 粗い段の許容誤差 (メートル)。段が無ければ undefined。 */
  coarseLodToleranceM: number | undefined;
  ensure: () => Promise<void>;
}

/**
 * 道路 (Overture)。**国のデータには路線名が無い**ので、名前で引けるのはこれだけ
 * (詳細は docs/data-sources.md)。`class` ごとにファイルが分かれている。
 */
interface RoadSource {
  id: string;
  bbox: Bbox | null;
  files: ItemFile[];
  /** 粗い段の許容誤差 (メートル)。段が無ければ undefined。 */
  coarseLodToleranceM: number | undefined;
  ensure: () => Promise<void>;
}

/**
 * 道路の等級ごとの色と呼び名。**語彙はカタログから来る**ので、ここには
 * 見せ方だけを持つ (鉄道の事業者種別と同じ)。
 *
 * Overtureの `class` はOSM由来で、日本の制度とは1対1で対応しない。
 * 「おおよそ」と分かる書き方にしてある。
 */
const ROAD_STYLES: Record<string, { label: string; color: string; width: number }> = {
  motorway: { label: '高速道路', color: '#2f7d32', width: 3 },
  trunk: { label: '国道', color: '#c2410c', width: 2.4 },
  primary: { label: '都道府県道', color: '#8a6d3b', width: 1.8 },
};

/** 道路1件分の表示用データ。 */
interface RoadFeature {
  geojson: GeoJSON.Geometry;
  /** Overtureの `names.primary`。無いこともある。 */
  roadName: string | null;
  /** 道路等級。色と太さはこれで決める。 */
  roadClass: string;
  /**
   * 属する路線の名前。**1つの区間が複数の路線に属する**
   * (実測で首都圏の約半分が2本以上、最大10本) のでリストで持つ。
   */
  routeNames: string[];
}

/**
 * 事業者種別ごとの色。**語彙はカタログから来る**ので、ここには色だけを持つ。
 *
 * 種別を選んだのは、5つしかなくて凡例に収まり、かつ
 * 「新幹線か在来線か」「公営か民営か」という運航側が気にする区別に近いため。
 * 鉄道区分 (普通鉄道/軌道/モノレールなど11種) は細かすぎて色では読めない。
 */
const RAILWAY_COLORS: Record<string, string> = {
  JRの新幹線: '#c2185b',
  JR在来線: '#1565c0',
  公営鉄道: '#2e7d32',
  民営鉄道: '#ef6c00',
  第三セクター: '#6a1b9a',
};

/** 語彙に無い種別が来たときの色。カタログが増えても消えないようにする。 */
const RAILWAY_FALLBACK_COLOR = '#616161';

interface MeshSource {
  id: string;
  /** このデータの細かさ (メッシュコードの桁数)。11桁=125m、8桁=1km。 */
  digits: number;
  /** 収録範囲。 */
  bbox: Bbox | null;
  /** このデータセットを構成するファイル。`ensure()` を呼ぶまで空。 */
  files: ItemFile[];
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

/** 粗い段 (`lod = 0`)。統合して簡略化した行。 */
const COARSE_LOD = 0;
/** 原寸 (`lod = 1`)。元の行がそのまま入っている。 */
const EXACT_LOD = 1;

/**
 * 緯度36°での1pxの大きさ (メートル)。`156543.03 * cos(36°) / 2^z`。
 *
 * 日本のほぼ中央での値。北海道と沖縄で2割ほど違うが、**段を選ぶのは
 * 「誤差が見えるか」の判断**なので、この程度の差は効かない。
 */
function metersPerPixel(zoom: number): number {
  return 126_643 / 2 ** zoom;
}

/**
 * 許容誤差 `toleranceM` で簡略化したものが使えるのは、どのズームまでか。
 *
 * **誤差が2px以内なら使う。** 100mの誤差はズーム10で0.8px、11で1.6px、12で3.2px
 * なので、100mの段はズーム11まで。線の太さが2px前後あるので、2px以内のずれは
 * 線の中に収まって見えない。
 *
 * **ズーム閾値を書かずにここで決める**のが肝。データ側の誤差が変われば
 * 切り替わるズームも自動で追従する。
 */
function coarseLodUntilZoom(toleranceM: number): number {
  let zoom = 0;
  while (zoom < 24 && toleranceM / metersPerPixel(zoom + 1) <= 2) zoom += 1;
  return zoom;
}

/**
 * このズームで読む段。段を持たないCollectionでは undefined (条件を付けない)。
 *
 * **読む側をこの1箇所に閉じてある。** 将来COGPの読み手に替えるとき、
 * 変更点がここだけで済むようにするため。
 */
function lodForZoom(
  source: { coarseLodToleranceM: number | undefined },
  zoom: number,
): number | undefined {
  if (source.coarseLodToleranceM === undefined) return undefined;
  return zoom <= coarseLodUntilZoom(source.coarseLodToleranceM) ? COARSE_LOD : EXACT_LOD;
}

/**
 * 段を絞るWHERE句の断片。段が無いファイルでは**何も付けない**。
 *
 * 付けてしまうと、段を持たないファイル (`lod` 列が無い) を読んだときに
 * 列が見つからずクエリごと失敗する。後ろに条件が続く形で使う。
 */
function lodFilter(lod: number | undefined): string {
  return lod === undefined ? '' : `lod = ${lod} AND`;
}

/**
 * いま粗い段を見ているのかを画面で断る文。
 *
 * **黙って簡略化したものを見せない。** 引いた表示では統合して簡略化した線が
 * 出ているので、そう書いておかないと区間数が急に減ったように見える。
 * どのズームで原寸に切り替わるかも一緒に言う。
 */
function lodNote(
  source: { coarseLodToleranceM: number | undefined },
  lod: number | undefined,
): string {
  if (source.coarseLodToleranceM === undefined || lod !== COARSE_LOD) return '';
  const until = coarseLodUntilZoom(source.coarseLodToleranceM);
  return ` · 簡略表示 (ズーム${until + 1}から原寸)`;
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

/**
 * 表示量。**上限とズームの閾値だけを動かす** — 何をどう読むかは変えない。
 *
 * どこまで描けるかは端末で違うので、利用者が決められるようにする。
 * 数字を直接触らせず3段にしているのは、上限を3000にするか4000にするかを
 * 決める材料が利用者の側に無いため。**上限に当たったことは各レイヤーが
 * 「表示上限」と断る**ので、そこを見て段を上げればよい。
 */
type DetailLevel = 'low' | 'medium' | 'high';

interface DetailSettings {
  /** 建物が原寸に切り替わるズーム。これより引くと整備範囲を出す。 */
  buildingsMinZoom: number;
  buildingsLimit: number;
  railwayLimit: number;
  roadLimit: number;
  /**
   * 道路の等級ごとの最小ズームから**引く**値。大きいほど引いた表示で
   * 多くの等級が出る。高速は元が0なので動かない。
   */
  roadClassZoomShift: number;
}

/**
 * **標準は従来の値と完全に一致させる。** 転送量や件数を測っている
 * E2Eの基準がこれで決まっているため、既定を動かすとそちらも動く。
 *
 * 多めは上限を2倍、建物を1ズーム早く、道路の等級を2ズーム早く。
 * 控えめはその逆。**建物のズームを1より大きく動かさない** —
 * 14で原寸の1画面は15の4倍の面積で、そこから下げると上限に当たるだけになる。
 */
const DETAIL_LEVELS: Record<DetailLevel, DetailSettings & { label: string }> = {
  low: {
    label: '控えめ',
    buildingsMinZoom: 16,
    buildingsLimit: 1500,
    railwayLimit: 2000,
    roadLimit: 3000,
    roadClassZoomShift: -2,
  },
  medium: {
    label: '標準',
    buildingsMinZoom: 15,
    buildingsLimit: 3000,
    railwayLimit: 4000,
    roadLimit: 6000,
    roadClassZoomShift: 0,
  },
  high: {
    label: '多め',
    buildingsMinZoom: 14,
    buildingsLimit: 6000,
    railwayLimit: 8000,
    roadLimit: 12000,
    roadClassZoomShift: 2,
  },
};

const DETAIL_STORAGE_KEY = 'duck-geocoder:detail';

/** 保存されている段。無い・読めない・知らない値なら標準。 */
function loadDetailLevel(): DetailLevel {
  try {
    const saved = localStorage.getItem(DETAIL_STORAGE_KEY);
    if (saved && saved in DETAIL_LEVELS) return saved as DetailLevel;
  } catch {
    // プライベートブラウズなどで localStorage が使えないことがある。
    // 覚えられないだけで表示はできるので、黙って標準にする。
  }
  return 'medium';
}

function saveDetailLevel(level: DetailLevel): void {
  try {
    localStorage.setItem(DETAIL_STORAGE_KEY, level);
  } catch {
    // 同上。覚えられなくても今の表示には効いている。
  }
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
/**
 * **このパイプラインが読んでいるLOD。**
 *
 * PLATEAUの建物は `bldg:lod0RoofEdge` (屋根の外周線) だけを読み、高さの数値で
 * 押し出している。原典にはもっと細かいものが入っているので、その差を示す。
 */
const SHOWN_LOD = 0;

/**
 * 「表示はLOD0 / 原典はLOD3まで」を作る。無ければ空文字。
 *
 * **表示範囲に入っているファイルから最大を取る。** 都市ごとに違うので、
 * 1つずつ並べると行が伸びる。原典が表示と同じ細かさしか無ければ何も言わない
 * (言っても情報が無い)。
 */
function sourceLodNote(
  source: { files: ItemFile[] },
  bounds: ViewBounds,
): string {
  const lods = source.files
    .filter(({ bbox }) => !bbox || bboxOverlaps(bbox, bounds))
    .flatMap(({ sourceLod }) => sourceLod);
  if (lods.length === 0) return '';
  const max = Math.max(...lods);
  if (max <= SHOWN_LOD) return '';
  return ` · 表示はLOD${SHOWN_LOD} / 原典はLOD${max}まで`;
}

/** 収録範囲が表示範囲と重なるか。 */
function bboxOverlaps([west, south, east, north]: Bbox, bounds: ViewBounds): boolean {
  return (
    west <= bounds.east && east >= bounds.west && south <= bounds.north && north >= bounds.south
  );
}

function filesInView(
  source: { files: ItemFile[] },
  bounds: ViewBounds,
): string[] {
  const overlapping = source.files.filter(
    // 収録範囲が分からないファイルは落とさない (判断材料が無いので読む)。
    ({ bbox }) => !bbox || bboxOverlaps(bbox, bounds),
  );
  return overlapping.map(({ file }) => file);
}

async function initDuckDb(collections: Collection[]): Promise<{
  conn: duckdb.AsyncDuckDBConnection;
  /** 建物データの出所。カタログにあるものだけが並ぶ。 */
  buildingSources: BuildingSource[];
  /** 人口メッシュ。細かさの違うものが並ぶ。空なら地上リスクの表示を出さない。 */
  meshSources: MeshSource[];
  /** 鉄道 (路線と駅)。空なら鉄道の節を出さない。 */
  railwaySources: RailwaySource[];
  /** 事業者種別の語彙。絞り込みの選択肢をここから作る。 */
  railwayInstitutionTypes: string[];
  /** 鉄道がいつ時点のものか。ホバーで出す。 */
  railwayVintage: string | undefined;
  /** 道路 (Overture)。無ければ道路の節を出さない。 */
  roadSource: RoadSource | undefined;
  /** 道路等級の語彙。絞り込みの選択肢をここから作る。 */
  roadClasses: string[];
  /** 道路がいつ時点のものか。ホバーで出す。 */
  roadVintage: string | undefined;
  /** 路線の索引と区間のビューを作る。検索のときだけ呼ぶ。 */
  ensureRoutes: (() => Promise<void>) | undefined;
  /** 空間関数を使う前に呼ぶ。 */
  ensureSpatial: () => Promise<void>;
  /** 地名 (isj_oaza) を引く前に呼ぶ。 */
  ensureOaza: () => Promise<void>;
  /** 駅を引く前に呼ぶ。駅が配信されていなければ undefined。 */
  ensureStations: (() => Promise<void>) | undefined;
  /** 路線の線を引く前に呼ぶ。ハイライトのときだけ使う。 */
  ensureSections: (() => Promise<void>) | undefined;
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
    (a, b) =>
      (b.feature.properties['table:row_count'] ?? 0) -
      (a.feature.properties['table:row_count'] ?? 0),
  )[0];
  if (!adminItem) throw new Error('行政区域のItemがありません。');
  const adminFile = resolveHref(adminItem.feature.assets.data.href, adminItem.base);

  // 検索用の名称を抜き出したものがあれば使う。無い場合は行政区域から作るが、
  // そちらは名称の列がファイル全体に散らばっているため、HTTP越しだと
  // 往復が積み上がって初期化が数十秒かかる。
  const adminNamesCollection = byKind('admin_names')[0];
  const adminNamesItem = adminNamesCollection
    ? (await adminNamesCollection.items())[0]
    : undefined;
  const adminNamesFile = adminNamesItem
    ? resolveHref(adminNamesItem.feature.assets.data.href, adminNamesItem.base)
    : undefined;

  await register(adminNamesFile ? [adminFile, adminNamesFile] : [adminFile]);

  console.info(
    '[catalog] 行政区域:',
    adminItem.feature.id,
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
      .map(itemFile);
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

  /**
   * 駅を検索に載せる。**無ければ検索の候補が増えないだけ。**
   *
   * 地名と同じく、検索するまで読まない。読むのは `station_name` (71KB) と
   * `line_name` (7KB)、位置に使う bbox の4列 (299KB) で、**初回だけ**。
   * 行政区域の名称で起きた「row groupに散らばって往復42回」という問題は、
   * 駅のファイルが **1 row group** なので起きない。
   */
  const stationCollection = byKind('railway_station')[0];
  const ensureStations = stationCollection
    ? once(async () => {
        const files = (await stationCollection.items()).map(itemFile);
        await register(files);
        const list = files.map((file) => `'${file}'`).join(', ');
        await conn.query(`CREATE VIEW station AS SELECT * FROM read_parquet([${list}]);`);
        await conn.query(`SELECT count(station_name || line_name) FROM station;`);
      })
    : undefined;

  /**
   * 路線の線そのもの。**選んだ路線をハイライトするときだけ読む。**
   *
   * 検索と一覧は駅だけで足りる (駅は0.8MB、路線は5.2MBでジオメトリが4.6MB)。
   * 路線を選んだときに初めて、**その路線の範囲で絞って**読む。
   */
  const sectionCollection = byKind('railway')[0];
  const ensureSections = sectionCollection
    ? once(async () => {
        const files = (await sectionCollection.items()).map(itemFile);
        await register(files);
        await ensureSpatial();
        const list = files.map((file) => `'${file}'`).join(', ');
        await conn.query(`CREATE VIEW section AS SELECT * FROM read_parquet([${list}]);`);
      })
    : undefined;

  // 建物は任意。無ければ建物レイヤーを出さないだけで、他の機能は動く。
  // **並びはカタログの順。** 先頭が既定で出て、塗りも青になる。どれを先に
  // 置くかはパイプライン (`SUB_CATALOGS`) が決める — 属性が揃っているPLATEAUが先。
  //
  // **ビューは作らない。** 出所ごとに1つのビューへ束ねると、その時点で
  // ファイルの数だけフッターを読みに行くことになる (1ファイル1往復)。
  // 建物は都市ごとに1ファイルで、PLATEAUを全国に広げると300を超えるので、
  // 引くときに表示範囲と重なるものだけを渡す (`filesInView`)。
  const buildingCollections = collections.filter(
    (c) => c.kind === 'plateau_buildings' || c.kind === 'buildings',
  );
  const buildingSources: BuildingSource[] = buildingCollections.map((collection) => {
    // **整備範囲を結び付ける。** `duck:covers` がこのCollectionを指しているものを
    // 探す。IDの綴りで判断しない (出所が増えたときに書き足す場所が分かれる)。
    const coverageCollection = byKind('building_coverage').find(
      (c) => c.covers === collection.id,
    );
    const coverage: BuildingCoverage | undefined =
      coverageCollection && coverageCollection.meshDigits !== undefined
        ? {
            files: [],
            meshDigits: coverageCollection.meshDigits,
            ensure: once(async () => {
              const items = await coverageCollection.items();
              coverage!.files = itemFiles(items);
              await register(coverage!.files.map(({ file }) => file));
              await ensureSpatial();
            }),
          }
        : undefined;

    // 何で絞れるかは列の有無から決める。高さは列があれば絞れる。
    // 用途で絞れる列は**カタログが語彙を持っている列**。列名 (PLATEAUは usage、
    // Overtureは class) をここに書かないのは、出所が増えたときに書き足す場所が
    // 分かれてしまうため。語彙を出すかどうかはパイプライン側が一箇所で決める。
    const [categoryColumn, usages] = Object.entries(collection.summaries)[0] ?? [null, []];
    const source: BuildingSource = {
      id: collection.id,
      // Itemを読むまで空。寄って実際に引くまで通信しない。
      files: [],
      hasHeight: collection.columns.has('height'),
      categoryColumn,
      usages,
      bbox: collection.bbox,
      coverage,
      ensure: once(async () => {
        const items = await collection.items();
        source.files = itemFiles(items);
        await register(source.files.map(({ file }) => file));
        await ensureSpatial();
      }),
    };
    return source;
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

  // 鉄道。路線と駅で列構成が違うのでCollectionが分かれている。
  // どちらも無ければ鉄道の節を出さないだけで、他の機能は動く。
  const railwaySources: RailwaySource[] = (['railway', 'railway_station'] as const).flatMap(
    (kind) => {
      const collection = byKind(kind)[0];
      if (!collection) return [];
      const source: RailwaySource = {
        id: collection.id,
        kind,
        bbox: collection.bbox,
        files: [],
        coarseLodToleranceM: collection.coarseLodToleranceM,
        ensure: once(async () => {
          const items = await collection.items();
          source.files = itemFiles(items);
          await register(source.files.map(({ file }) => file));
          await ensureSpatial();
        }),
      };
      return [source];
    },
  );

  // 道路。無ければ道路の節を出さないだけで、他の機能は動く。
  const roadCollection = byKind('road')[0];
  const roadSource: RoadSource | undefined = roadCollection
    ? {
        id: roadCollection.id,
        bbox: roadCollection.bbox,
        files: [],
        coarseLodToleranceM: roadCollection.coarseLodToleranceM,
        ensure: once(async () => {
          const items = await roadCollection.items();
          roadSource!.files = itemFiles(items);
          await register(roadSource!.files.map(({ file }) => file));
          await ensureSpatial();
        }),
      }
    : undefined;
  const roadVintage = roadCollection?.vintage;

  // 路線の索引と、区間そのもの。**検索とハイライトのときだけ**読む。
  const routeCollection = byKind('road_route')[0];
  const ensureRoutes =
    routeCollection && roadCollection
      ? once(async () => {
          const routeFile = ((first) => (first ? itemFile(first) : undefined))((await routeCollection.items())[0]);
          if (!routeFile) return;
          await register([routeFile]);
          await conn.query(
            `CREATE VIEW road_route AS SELECT * FROM read_parquet('${routeFile}');`,
          );
          // ハイライトは区間の方から引くので、同じ経路で用意しておく。
          const files = (await roadCollection.items()).map(itemFile);
          await register(files);
          const list = files.map((file) => `'${file}'`).join(', ');
          await conn.query(`CREATE VIEW road AS SELECT * FROM read_parquet([${list}]);`);
          await ensureSpatial();
        })
      : undefined;
  // 等級の語彙もカタログから。鉄道の事業者種別と同じ扱い。
  const roadClasses = (roadCollection?.summaries['class'] ?? []) as string[];

  // 絞り込みの選択肢はカタログの語彙から作る。**事業者種別の列名をここに書かない**のは
  // 建物の用途と同じ理由で、語彙を出すかどうかをパイプライン側の一箇所で決めるため。
  const railwayVintage = railwaySources[0]
    ? byKind(railwaySources[0].kind)[0]?.vintage
    : undefined;

  const railwayInstitutionTypes = railwaySources[0]
    ? ((byKind(railwaySources[0].kind)[0]?.summaries['institution_type'] ?? []) as string[])
    : [];

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

  return {
    conn,
    buildingSources,
    meshSources,
    railwaySources,
    railwayInstitutionTypes,
    railwayVintage,
    roadSource,
    roadClasses,
    roadVintage,
    ensureRoutes,
    ensureSpatial,
    ensureOaza,
    ensureStations,
    ensureSections,
  };
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

/** 鉄道1件分の表示用データ。路線と駅で同じ形にしてある。 */
interface RailwayFeature {
  geojson: GeoJSON.Geometry;
  /** N02_003 (路線名)。 */
  lineName: string;
  /** N02_004 (運営会社)。 */
  operator: string;
  /** 事業者種別を解決した名前。色はこれで決める。 */
  institutionType: string;
  /** 鉄道区分を解決した名前。 */
  railwayClass: string;
  /** 駅名。路線には無い。 */
  stationName: string | null;
}

/**
 * 表示範囲に入る鉄道を取り出す。建物と同じく bbox 列で先に絞り、
 * 画面中心に近い順に上限まで取る (上限に当たっても帯状に欠けないため)。
 *
 * 駅のファイルにしか `station_name` が無いので、SELECT する列を出所で変える。
 * 路線側で `station_name` を書くとスキーマに無い列で落ちる。
 */
async function fetchRailwayInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: RailwaySource,
  bounds: ViewBounds,
  institutionTypes: string[] | null,
  limit: number,
  lod: number | undefined,
): Promise<RailwayFeature[]> {
  const files = filesInView(source, bounds);
  if (files.length === 0) return [];
  const list = files.map((file) => `'${file}'`).join(', ');

  const conditions = [
    `bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}`,
    `bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}`,
  ];
  if (lod !== undefined) conditions.push(`lod = ${lod}`);
  if (institutionTypes) {
    // 建物の用途と同じく、1つも選ばれていなければ1件も出さない。
    const types = institutionTypes.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');
    conditions.push(types.length > 0 ? `institution_type IN (${types})` : 'false');
  }

  const stationSelect = source.kind === 'railway_station' ? 'station_name' : 'NULL';
  const lonScale = Math.cos((bounds.centerLat * Math.PI) / 180);

  const result = await conn.query(`
    SELECT
      ST_AsGeoJSON(geometry) AS geojson,
      line_name, operator, institution_type, railway_class,
      ${stationSelect} AS station_name
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
      line_name: string;
      operator: string;
      institution_type: string;
      railway_class: string;
      station_name: string | null;
    };
    return {
      geojson: JSON.parse(r.geojson) as GeoJSON.Geometry,
      lineName: r.line_name,
      operator: r.operator,
      institutionType: r.institution_type,
      railwayClass: r.railway_class,
      stationName: r.station_name,
    };
  });
}

/**
 * 表示範囲に入る道路を取り出す。鉄道と同じく bbox 列で先に絞り、
 * 画面中心に近い順に上限まで取る。
 *
 * `class` はファイルが分かれているので、**選ばれていない等級のファイルは
 * そもそも読みに行かない** (これが class で分けている理由)。
 */
async function fetchRoadsInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: RoadSource,
  bounds: ViewBounds,
  classes: string[],
  limit: number,
  lod: number | undefined,
): Promise<RoadFeature[]> {
  if (classes.length === 0) return [];
  // ファイル名に class が入っているので、読むファイルの段階で絞れる。
  const files = filesInView(source, bounds).filter((file) =>
    classes.some((cls) => file.endsWith(`_${cls}.parquet`)),
  );
  if (files.length === 0) return [];
  const list = files.map((file) => `'${file}'`).join(', ');
  const lonScale = Math.cos((bounds.centerLat * Math.PI) / 180);

  const result = await conn.query(`
    SELECT
      ST_AsGeoJSON(geometry) AS geojson,
      road_name, class, route_names
    FROM read_parquet([${list}])
    WHERE ${lodFilter(lod)}
      bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}
      AND bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}
    ORDER BY
      pow(((bbox.xmin + bbox.xmax) / 2 - ${bounds.centerLon}) * ${lonScale}, 2)
      + pow((bbox.ymin + bbox.ymax) / 2 - ${bounds.centerLat}, 2)
    LIMIT ${limit};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      geojson: string;
      road_name: string | null;
      class: string;
      route_names: unknown;
    };
    return {
      geojson: JSON.parse(r.geojson) as GeoJSON.Geometry,
      roadName: r.road_name,
      roadClass: r.class,
      // リスト列はArrowのVectorで返るので、素の配列に均す。
      routeNames: Array.from((r.route_names ?? []) as ArrayLike<unknown>, String),
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
/** 整備範囲のセル1つ。 */
interface CoverageCell {
  code: string;
  /** このセルの中にある建物の数。 */
  buildings: number;
  /**
   * **データのある1kmセルの数。** 配られているのは常に8桁 (1km) なので、
   * 束ねたときにいくつ集まったかがそのまま「どれだけ埋まっているか」になる。
   * 8桁で見ているときは必ず1。
   */
  filled: number;
  /**
   * このセルにかかる自治体。**1つに潰さない** — メッシュは境界をまたぐので、
   * 全国35,645セルのうち約10%が複数にかかる (最大4つ)。
   * 束ねて粗くすると当然もっと増える。
   */
  cities: string[];
}

/**
 * 整備範囲を表示範囲のぶんだけ引く。
 *
 * **人口メッシュと同じ作り。** コードを前から切って束ねるので、
 * 1kmで配ったものから10kmも80kmも作れる。
 */
async function fetchCoverageInView(
  conn: duckdb.AsyncDuckDBConnection,
  coverage: BuildingCoverage,
  bounds: ViewBounds,
  digits: number,
): Promise<CoverageCell[]> {
  const files = filesInView(coverage, bounds);
  if (files.length === 0) return [];
  const list = files.map((file) => `'${file}'`).join(', ');

  const result = await conn.query(`
    SELECT
      substr(mesh_code, 1, ${digits}) AS code,
      sum(buildings) AS buildings,
      -- **束ねた1kmセルの数。** 行は1kmセルにつき1つしか無いので、
      -- これが「このセルのうちどれだけ埋まっているか」の分子になる。
      count(*) AS filled,
      -- 束ねると自治体も混ざる。**並べて重複を落とす**ので、
      -- 同じ顔ぶれなら並びも同じになる。
      list_sort(list_distinct(flatten(list(cities)))) AS cities
    FROM read_parquet([${list}])
    WHERE bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}
      AND bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}
    GROUP BY code;
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      code: string;
      buildings: number | bigint;
      filled: number | bigint;
      cities: unknown;
    };
    return {
      code: r.code,
      buildings: Number(r.buildings),
      filled: Number(r.filled),
      // リスト列はArrowのVectorで返るので、素の配列に均す。
      cities: Array.from((r.cities ?? []) as ArrayLike<unknown>, String),
    };
  });
}

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

/**
 * 打った語そのものではない道路を、候補に出す上限。
 *
 * **道路は同じ語を含む路線が桁違いに多い。**「東京」には109路線が当たり、
 * 上限を掛けずに前へ出したときは候補10件をすべて道路が埋めて、
 * 東京駅も東京都も消えた。
 */
const ROUTE_SUGGESTIONS = 3;

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
 * 駅を名前で引く。
 *
 * **路線名も対象にする。**「山手線」でその路線の駅が出る。
 *
 * **駅名・路線名・運営会社の組でユニークにする。** 同じ駅名の行が路線の数だけあり
 * (「東京」は12路線)、そのまま出すと候補が同じ名前で埋まる。
 * 乗り換えでまとめるか県で分けるかは扱いが難しいので、まずは組で分ける。
 *
 * **運営会社まで入れないと壊れる。**「本線」は複数の会社が使う一般名で、
 * 駅名と路線名だけだと住吉駅 (兵庫と福岡) が同じ組になり、平均を取ると
 * **600km離れた中間点**に飛ぶ。実測で3組 (10,134組中) がこれに当たり、
 * 会社を足すと最大の広がりが1kmに収まる。
 *
 * 位置は **bboxの中心**。駅は点ではなく線 (ホームの延長) なので、
 * `bbox.xmin` をそのまま使うと端に寄る。
 */
async function searchStations(
  conn: duckdb.AsyncDuckDBConnection,
  keyword: string,
): Promise<SearchResult[]> {
  // **「駅」を挟む。** 原典の `station_name` は「品川」で「駅」が付かないので、
  // 人がふつうに打つ「品川駅」が1件も当たらなかった。
  // (「〇〇駅」で終わる駅名も8件あるが、二重になっても照合には影響しない)
  const expr = `station_name || '駅' || line_name || operator`;
  const result = await conn.query(`
    SELECT * FROM (
      SELECT
        station_name, line_name, any_value(operator) AS operator,
        avg((bbox.xmin + bbox.xmax) / 2) AS lon,
        avg((bbox.ymin + bbox.ymax) / 2) AS lat
      FROM station
      WHERE ${buildMatchConditions(keyword, expr)}
      GROUP BY station_name, line_name, operator
    )
    ORDER BY length(station_name || line_name)
    LIMIT ${MAX_RESULTS};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      station_name: string;
      line_name: string;
      operator: string;
      lon: number;
      lat: number;
    };
    return {
      kind: 'station' as const,
      label: `${r.station_name}駅`,
      // **会社名は必ず出す。**「品川駅 (本線)」では何線か分からない。
      // 重複しているときだけ出す形にしたが、絞り込んだ結果の中でしか
      // 重複を数えられず、品川駅のように1件だけ返る場合に付かなかった。
      detail: `${r.operator} ${r.line_name}`,
      lon: r.lon,
      lat: r.lat,
    };
  });
}

/**
 * 路線を名前で引く。**路線そのものを候補に出す。**
 *
 * 「山手線」と打ったときに駅ばかり並ぶと、路線を見たい人の役に立たない。
 *
 * 範囲は**その路線の駅から**作る。路線のファイル (5.2MB、ジオメトリだけで4.6MB) を
 * 読まずに済み、駅は検索のために既に読んでいる。実測で596路線のうち
 * 駅が1つしかないのは2つだけで、範囲の中央値は14km。
 */
async function searchLines(
  conn: duckdb.AsyncDuckDBConnection,
  keyword: string,
): Promise<SearchResult[]> {
  const result = await conn.query(`
    SELECT
      line_name, operator,
      min(bbox.xmin) AS west, min(bbox.ymin) AS south,
      max(bbox.xmax) AS east, max(bbox.ymax) AS north
    FROM station
    WHERE ${buildMatchConditions(keyword, 'line_name || operator')}
    GROUP BY line_name, operator
    ORDER BY length(line_name)
    LIMIT ${MAX_RESULTS};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      line_name: string;
      operator: string;
      west: number;
      south: number;
      east: number;
      north: number;
    };
    return {
      kind: 'line' as const,
      label: r.line_name,
      // **会社名は必ず出す。**「本線」は10社が使っている。
      detail: r.operator,
      bbox: [r.west, r.south, r.east, r.north] as Bbox,
      lineName: r.line_name,
      operator: r.operator,
    };
  });
}

/**
 * 道路の路線を引く。「国道13号」「山形県道16号」など。
 *
 * **路線の索引 (211KB) から引く。** 区間そのもの (70MB) を走査すると、
 * bbox列だけで約9MB読むことになる。索引は同じOvertureの道路から作った要約なので、
 * 検索で出たものと地図に出るものは同じデータ。
 */
/**
 * 区間の並びを1つのMultiLineStringにまとめる。ハイライト用。
 *
 * 1件も無ければ `null` を返す。空のMultiLineStringを入れると、
 * MapLibreが空のソースと区別できない。
 */
function toMultiLineString(parts: GeoJSON.Geometry[]): GeoJSON.Geometry | null {
  const coordinates = parts.flatMap((part) =>
    part.type === 'LineString'
      ? [part.coordinates]
      : part.type === 'MultiLineString'
        ? part.coordinates
        : [],
  );
  return coordinates.length > 0 ? { type: 'MultiLineString', coordinates } : null;
}

async function searchRoutes(
  conn: duckdb.AsyncDuckDBConnection,
  keyword: string,
): Promise<SearchResult[]> {
  const result = await conn.query(`
    SELECT route_name, class, segments, bbox
    FROM road_route
    WHERE ${buildMatchConditions(keyword, 'route_name')}
    ORDER BY length(route_name)
    LIMIT ${MAX_RESULTS};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      route_name: string;
      class: string;
      segments: number;
      bbox: { xmin: number; ymin: number; xmax: number; ymax: number };
    };
    return {
      kind: 'route' as const,
      label: r.route_name,
      detail: `${ROAD_STYLES[r.class]?.label ?? r.class} · ${Number(r.segments).toLocaleString()} 区間`,
      bbox: [r.bbox.xmin, r.bbox.ymin, r.bbox.xmax, r.bbox.ymax] as Bbox,
      routeName: r.route_name,
    };
  });
}

/**
 * 選んだ路線の道路を読む。**ハイライトのためだけに、そのときだけ読む。**
 *
 * 範囲で絞るのは鉄道と同じ理由 (row groupの統計で読み飛ばさせる)。
 * **`list_contains` で当てる。** 1区間が複数の路線に属するのでリストになっている。
 */
async function fetchRouteGeometry(
  conn: duckdb.AsyncDuckDBConnection,
  routeName: string,
  [west, south, east, north]: Bbox,
): Promise<GeoJSON.Geometry[]> {
  const quoted = `'${routeName.replace(/'/g, "''")}'`;
  const result = await conn.query(`
    SELECT ST_AsGeoJSON(geometry) AS geojson
    FROM road
    WHERE list_contains(route_names, ${quoted})
      AND bbox.xmin <= ${east} AND bbox.xmax >= ${west}
      AND bbox.ymin <= ${north} AND bbox.ymax >= ${south};
  `);
  return result
    .toArray()
    .map(
      (row) => JSON.parse((row.toJSON() as unknown as { geojson: string }).geojson) as GeoJSON.Geometry,
    );
}

/**
 * 選んだ路線の線を読む。**ハイライトのためだけに、そのときだけ読む。**
 *
 * 範囲 (`bbox`) で絞るのは、row group の統計で読み飛ばさせるため。
 * 路線のファイルは5.2MB (ジオメトリ4.6MB) あるが、
 * 実測では山手線が65区間で8KB、東海道線でも493区間で140KB。
 */
async function fetchLineGeometry(
  conn: duckdb.AsyncDuckDBConnection,
  lineName: string,
  operator: string,
  [west, south, east, north]: Bbox,
): Promise<GeoJSON.Geometry[]> {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const result = await conn.query(`
    SELECT ST_AsGeoJSON(geometry) AS geojson
    FROM section
    WHERE line_name = ${quote(lineName)} AND operator = ${quote(operator)}
      AND bbox.xmin <= ${east} AND bbox.xmax >= ${west}
      AND bbox.ymin <= ${north} AND bbox.ymax >= ${south};
  `);
  return result
    .toArray()
    .map((row) => JSON.parse((row.toJSON() as unknown as { geojson: string }).geojson) as GeoJSON.Geometry);
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
function groupCredits(collections: Collection[]): {
  titles: string[];
  attribution: string;
  url: string;
  via: string[];
  vintages: string[];
}[] {
  const byAttribution = new Map<
    string,
    { url: string; titles: string[]; via: string[]; vintages: string[] }
  >();
  for (const collection of collections) {
    const entry = byAttribution.get(collection.attribution) ?? {
      url: collection.attributionUrl,
      titles: [],
      via: [],
      vintages: [],
    };
    // 同じ出典で細かさ違いのCollectionが並ぶことがある (人口メッシュの125mと1km)。
    if (!entry.titles.includes(collection.title)) entry.titles.push(collection.title);
    // 同じ出典でも配布元のページが分かれることがある (Overtureの区域と建物)。
    if (collection.via && !entry.via.includes(collection.via)) entry.via.push(collection.via);
    // 版。**分からないものは足さない** (「不明」と書くより、出さない方が誤解が少ない)。
    if (collection.vintage && !entry.vintages.includes(collection.vintage)) {
      entry.vintages.push(collection.vintage);
    }
    byAttribution.set(collection.attribution, entry);
  }
  // 並べ替えは表示する文言で行う (組み立てたHTMLで並べると、順序がタグの中身に左右される)。
  return [...byAttribution]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([attribution, { url, titles, via, vintages }]) => ({
      titles,
      attribution,
      url,
      via,
      vintages,
    }));
}

function buildDataCredits(collections: Collection[]): string[] {
  return groupCredits(collections).map(
    ({ titles, attribution, url }) =>
      `<span class="credit"><b>${titles.join('・')}</b> ${creditLink(url, attribution)}</span>`,
  );
}

/** 外部へのリンク。別タブで開き、参照元を渡さない。 */
function externalLink(href: string, label: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = label;
  return link;
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
  for (const { titles, attribution, url, via, vintages } of groupCredits(collections)) {
    const term = document.createElement('dt');
    term.textContent = titles.join('・');
    // **いつ時点のデータか。** 出所だけでは版が分からず、古いものを新しいと
    // 思って使う事故になる。分かっているものだけ添える。
    if (vintages.length > 0) {
      const vintage = document.createElement('span');
      vintage.className = 'vintage';
      vintage.textContent = vintages.join(' / ');
      term.append(' ', vintage);
    }

    const detail = document.createElement('dd');
    detail.append(externalLink(url, attribution));

    // **配布元へ辿れるようにする。** ここにあるのは変換した複製で、原典は向こうにある。
    // 出典表示のリンク先とは別 (Overtureは出典がガイドページを指す)。
    if (via.length > 0) {
      const sources = document.createElement('div');
      sources.className = 'via';
      sources.append('配布元: ');
      for (const [index, href] of via.entries()) {
        if (index > 0) sources.append(' / ');
        sources.append(externalLink(href, new URL(href).hostname));
      }
      detail.append(sources);
    }
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

      // 道路は人口メッシュの上、鉄道の下。**鉄道より下に敷く**のは、
      // 交差点で鉄道の方が見えてほしいため (踏切と立体交差の区別は付かないが、
      // 線路の連続性が切れる方が読みにくい)。
      map.addSource('road', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'road-line',
        type: 'line',
        source: 'road',
        // 色と太さは引くときに決めてしまう (`ROAD_STYLES`)。鉄道と同じ作り。
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['get', 'width'],
          'line-opacity': 0.9,
        },
      });

      // 鉄道は人口メッシュの上、建物の下。メッシュの色が透けて読める濃さにする。
      map.addSource('railway', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'railway-line',
        type: 'line',
        source: 'railway',
        // 色は引くときに決めてしまう (`RAILWAY_COLORS`)。人口メッシュと同じく、
        // スタイル式で分岐を組むより凡例と同じ表から作る方がずれない。
        paint: {
          'line-color': ['get', 'color'],
          // 引いたときに線が潰れないよう、ズームで太さを変える。
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 12, 2, 16, 3.5],
          'line-opacity': 0.9,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });

      // 駅も線 (原典がホームの延長を線で持っている) なので、太さと白い縁取りで
      // 路線と区別する。点に潰すと原典より情報が減る。
      map.addSource('railway-stations', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'railway-station-casing',
        type: 'line',
        source: 'railway-stations',
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 11],
        },
        layout: { 'line-cap': 'round' },
      });
      map.addLayer({
        id: 'railway-station',
        type: 'line',
        source: 'railway-stations',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 7],
        },
        layout: { 'line-cap': 'round' },
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
          //
          // **出所で色相を分ける。** PLATEAUとOvertureは同時に出せるので、
          // 重なったところでどちらの建物かが見分けられないと困る。
          // カタログで先頭の出所 (`palette` 0) が青、それ以外が橙。
          'fill-extrusion-color': [
            'match',
            ['get', 'palette'],
            0,
            [
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
            [
              'case',
              ['==', ['get', 'height'], null],
              '#c77d3a',
              [
                'interpolate',
                ['linear'],
                ['get', 'height'],
                0,
                '#f0cfa8',
                20,
                '#e0a669',
                60,
                '#c77d3a',
                150,
                '#8a4f1c',
              ],
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
        paint: {
          'fill-color': '#4a6785',
          // **充足率で濃淡を付ける。** 建物の数で濃くすると人口密集部が濃くなる
          // だけなので使わない。束ねた1kmセルのうち何割にデータがあるかで塗る。
          //
          // **低い側を広く取り、底を上げる。** 直線の傾斜にすると、80kmメッシュで
          // 数セルしか無いところ (6400分の数) が事実上見えなくなる。実測では
          // 80kmの平均充足率は7.2%しかないので、そこが消えると意味が逆転する。
          // 「少しはある」と「全く無い」は別物なので、**描かれる限り必ず見える**
          // 0.12を下限にする。8桁 (1km) では必ず1なので一様に塗られる。
          'fill-opacity': [
            'case',
            ['has', 'mesh'],
            ['interpolate', ['linear'], ['get', 'ratio'], 0, 0.12, 0.05, 0.18, 0.25, 0.26, 1, 0.36],
            0.08,
          ],
        },
      });
      map.addLayer({
        id: 'buildings-coverage-outline',
        type: 'line',
        source: 'buildings-coverage',
        paint: {
          'line-color': '#4a6785',
          'line-width': 1.5,
          // **メッシュには破線を引かない。** 3万セルの縁を破線にすると
          // 網目が潰れて塗りが読めない。枠 (1つだけ) のときは破線のままにする。
          'line-dasharray': ['case', ['has', 'mesh'], ['literal', [1, 0]], ['literal', [3, 2]]],
          'line-opacity': ['case', ['has', 'mesh'], 0.3, 1],
        },
      });

      map.addSource('highlight', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'highlight-fill',
        type: 'fill',
        source: 'highlight',
        // **ポリゴンのときだけ塗る。** ソースは行政区域 (ポリゴン) と
        // 路線 (線) で使い回していて、MapLibre の fill は**線のジオメトリも
        // 閉じた輪とみなして塗ってしまう**。東海道線のように品川〜武蔵小杉〜鶴見と
        // 品川〜川崎〜鶴見が輪を作る路線では、線の内側が丸ごと橙色になる。
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#ff6600', 'fill-opacity': 0.35 },
      });
      map.addLayer({
        id: 'highlight-casing',
        type: 'line',
        source: 'highlight',
        // **白で縁取ってから橙を載せる。** 路線を選ぶと線そのものがここに入るが、
        // 鉄道レイヤーを出していると同じような太さの色線が並び、橙だけでは
        // どれが選んだ路線か分からない。白の縁があると下地の色から浮く。
        paint: { 'line-color': '#ffffff', 'line-width': 9 },
      });
      map.addLayer({
        id: 'highlight-outline',
        type: 'line',
        source: 'highlight',
        // **破線にする。** 鉄道レイヤーの線と色だけで見分けさせると、
        // 色の見え方によっては区別がつかない。形が違えば色に頼らずに済む。
        paint: { 'line-color': '#ff6600', 'line-width': 5, 'line-dasharray': [1.6, 1.1] },
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
  const coverageToggle = document.querySelector<HTMLInputElement>('#coverage-toggle')!;
  const filtersEl = document.querySelector<HTMLDivElement>('#building-filters')!;
  const heightField = document.querySelector<HTMLDivElement>('#height-field')!;
  const usageField = document.querySelector<HTMLDivElement>('#usage-field')!;
  const minHeightInput = document.querySelector<HTMLInputElement>('#min-height')!;
  const minHeightValue = document.querySelector<HTMLOutputElement>('#min-height-value')!;
  const usageOptionsEl = document.querySelector<HTMLDivElement>('#usage-options')!;
  const usageAllButton = document.querySelector<HTMLButtonElement>('#usage-all')!;
  const usageNoneButton = document.querySelector<HTMLButtonElement>('#usage-none')!;
  const buildingCountEl = document.querySelector<HTMLParagraphElement>('#building-count')!;
  const railwaySectionEl = document.querySelector<HTMLDivElement>('#railway-section')!;
  const railwayTypesEl = document.querySelector<HTMLDivElement>('#railway-types')!;
  const railwayAllButton = document.querySelector<HTMLButtonElement>('#railway-all')!;
  const railwayNoneButton = document.querySelector<HTMLButtonElement>('#railway-none')!;
  const railwaySummaryEl = document.querySelector<HTMLParagraphElement>('#railway-summary')!;
  let railwayTypeInputs: HTMLInputElement[] = [];
  const roadSectionEl = document.querySelector<HTMLDivElement>('#road-section')!;
  const roadClassesEl = document.querySelector<HTMLDivElement>('#road-classes')!;
  const roadAllButton = document.querySelector<HTMLButtonElement>('#road-all')!;
  const roadNoneButton = document.querySelector<HTMLButtonElement>('#road-none')!;
  const roadSummaryEl = document.querySelector<HTMLParagraphElement>('#road-summary')!;
  let roadClassInputs: HTMLInputElement[] = [];

  const meshSectionEl = document.querySelector<HTMLDivElement>('#mesh-section')!;

  // レイヤー一覧まわり。**データは節を積まずに1データ1行で並べる** —
  // 種別ごとに `<details>` を足していくと、オープンデータが増えるだけ縦に伸びる。
  const layerListEl = document.querySelector<HTMLDivElement>('#layer-list')!;
  const layerRowsEl = document.querySelector<HTMLDivElement>('#layer-rows')!;
  const layerAbsentEl = document.querySelector<HTMLDivElement>('#layer-absent')!;
  const layerAbsentRowsEl = document.querySelector<HTMLDivElement>('#layer-absent-rows')!;
  const layerSupportEl = document.querySelector<HTMLDivElement>('#layer-support')!;
  const layerSupportRowsEl = document.querySelector<HTMLDivElement>('#layer-support-rows')!;
  const layerSettingsEl = document.querySelector<HTMLDivElement>('#layer-settings')!;
  const layerSettingsTitleEl = document.querySelector<HTMLParagraphElement>(
    '#layer-settings-title',
  )!;
  const layerSettingsBodyEl = document.querySelector<HTMLDivElement>('#layer-settings-body')!;
  const layerCatalogEl = document.querySelector<HTMLDivElement>('#layer-catalog')!;
  const layerBackButton = document.querySelector<HTMLButtonElement>('#layer-back')!;
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
  let railwaySources: RailwaySource[] = [];
  let railwayInstitutionTypes: string[] = [];
  let railwayVintage: string | undefined;
  let roadSource: RoadSource | undefined;
  let roadClasses: string[] = [];
  let roadVintage: string | undefined;
  let ensureRoutes: (() => Promise<void>) | undefined;
  let ensureSpatial: () => Promise<void>;
  let ensureOaza: () => Promise<void>;
  let ensureStations: (() => Promise<void>) | undefined;
  let ensureSections: (() => Promise<void>) | undefined;
  let collections: Collection[] = [];
  try {
    collections = await fetchCollections();
    const [db, createdMap] = await Promise.all([
      initDuckDb(collections),
      initMap(collections),
    ]);
    conn = db.conn;
    buildingSources = db.buildingSources;
    meshSources = db.meshSources;
    railwaySources = db.railwaySources;
    railwayInstitutionTypes = db.railwayInstitutionTypes;
    railwayVintage = db.railwayVintage;
    roadSource = db.roadSource;
    roadClasses = db.roadClasses;
    roadVintage = db.roadVintage;
    ensureRoutes = db.ensureRoutes;
    ({ ensureSpatial, ensureOaza, ensureStations, ensureSections } = db);
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
  // **判定の結果はホバーと見分けられるようにする。** 2つとも吹き出しなので、
  // クラスが無いと「どちらが押した場所のものか」が中身を読むまで分からない
  // (テストからも区別できない)。
  const popup = new Popup({ closeButton: true, closeOnClick: false, className: 'result-popup' });

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

  /** 路線の端から端まで入るように寄せる。鉄道と道路で同じ。 */
  const fitToBbox = ([west, south, east, north]: Bbox) => {
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      // パネルが左下と右下にあるので、下側を多めに空ける。
      { padding: { top: 60, bottom: 120, left: 60, right: 60 }, duration: 1500 },
    );
  };

  const showResult = async (result: SearchResult) => {
    // 路線は点ではなく**範囲**。端から端まで入るように寄せる。
    //
    // **線そのものをハイライトする。** 範囲へ動かすだけだと、鉄道レイヤーを
    // 出しているときに「どれが選んだ路線か」が分からない。
    if (result.kind === 'line') {
      await setSourceData('selected-point', null);
      if (ensureSections) {
        await busy('路線を読み込み中…', async () => {
          await ensureSections();
          const parts = await fetchLineGeometry(
            conn,
            result.lineName,
            result.operator,
            result.bbox,
          );
          await setSourceData('highlight', toMultiLineString(parts));
        });
      }
      fitToBbox(result.bbox);
      return;
    }

    // 道路の路線も同じ扱い。**出所は違うが見せ方は変わらない** ので、
    // ハイライトも寄せ方も鉄道と揃える。
    if (result.kind === 'route') {
      await setSourceData('selected-point', null);
      if (ensureRoutes) {
        await busy('道路を読み込み中…', async () => {
          await ensureRoutes();
          const parts = await fetchRouteGeometry(conn, result.routeName, result.bbox);
          await setSourceData('highlight', toMultiLineString(parts));
        });
      }
      fitToBbox(result.bbox);
      return;
    }

    // 地名(代表点しか無い)と駅はその地点へ飛ぶ。ポリゴンは消す。
    if (result.kind === 'oaza' || result.kind === 'station') {
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
      badge.textContent = {
        admin: '行政区域',
        oaza: '地名',
        station: '駅',
        line: '路線',
        route: '道路',
      }[
        row.kind
      ];
      li.append(badge, row.label);
      // **会社名と路線名は2段目に置く。**1行に詰めると
      //「東京駅 (東日本旅客鉄道 東北新幹線)」のように長くなって読みにくい。
      if ('detail' in row && row.detail) {
        const detail = document.createElement('span');
        detail.className = 'result-detail';
        detail.textContent = row.detail;
        li.append(detail);
      }
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
        // 駅は配信されていないこともある。無ければ地名と行政区域だけで引く。
        await Promise.all([ensureOaza(), ensureStations?.(), ensureRoutes?.()]);
        const [places, stations, lines, routes] = await Promise.all([
          searchAddress(conn, keyword),
          ensureStations ? searchStations(conn, keyword) : Promise.resolve([]),
          ensureStations ? searchLines(conn, keyword) : Promise.resolve([]),
          ensureRoutes ? searchRoutes(conn, keyword) : Promise.resolve([]),
        ]);
        // **打った語がそのものを指しているものを先に出す。**
        // 「山手線」で駅ばかり並ぶと、路線を見たい人の役に立たない。
        // 「東京」なら東京駅が先に来てほしい。
        const exactLines = lines.filter((l) => l.label.includes(keyword));
        const exactStations = stations.filter((s) => s.label.startsWith(`${keyword}駅`));
        const rest = stations.filter((s) => !exactStations.includes(s));
        // **道路は数が多いので、打った語そのもの以外は後ろに回して上限を掛ける。**
        // 「東京」には109路線が当たり、候補10件を道路が埋めて
        // 東京駅も東京都も消えた。「国道13号」のように語そのものを指すものは先頭。
        const exactRoutes = routes.filter((r) => r.label === keyword);
        const otherRoutes = routes
          .filter((r) => r.label !== keyword)
          .slice(0, ROUTE_SUGGESTIONS);
        return [
          ...exactRoutes,
          ...exactLines,
          ...exactStations,
          ...places,
          ...otherRoutes,
          ...rest,
        ].slice(0, MAX_RESULTS);
      })
        .then(renderResults)
        .catch((e: unknown) => {
          console.error('[searchAddress] failed', e);
          showFailure('検索に失敗しました');
        });
    }, debounceMs);
  };

  /**
   * 「検索に使用」を出すかどうか。**打っている間だけ出す。**
   *
   * 常時出しておくと検索欄が200pxまで伸びて左上の地図を覆い、
   * クリックが届かなくなる (実測156px)。かといってフォーカスだけを条件にすると、
   * **起動時に検索欄へ自動でフォーカスが当たる**ので結局出っぱなしになる。
   */
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

  // ---- 行の状態 --------------------------------------------------------------
  //
  // 件数や「ズーム15まで寄ると出ます」は**一覧の行に出す**。設定の中に置くと、
  // 開かない限り出ない理由が読めない。
  //
  // **行はCollectionなので、状態もCollection IDで持つ。** 以前は設定パネルの
  // 要約を監視して行へ写していたが、建物がPLATEAUとOvertureの2行になると
  // 要約1つでは足りない。
  const layerStatus = new Map<string, string>();
  const setLayerStatus = (id: string, text: string) => {
    layerStatus.set(id, text);
    for (const el of document.querySelectorAll(`[data-layer-status="${id}"]`)) {
      el.textContent = text;
    }
  };

  /**
   * 表示量。建物・鉄道・道路の上限とズームの閾値がここから決まる。
   *
   * 建物は `buildingsMinZoom` から原寸 (都市ごとのファイル・全件) を読む。
   * **これより引いても隠さない** — 整備範囲をメッシュで出す。
   */
  let detail: DetailSettings = DETAIL_LEVELS[loadDetailLevel()];
  // 高さを持つ建物を表示するときの傾き。
  // 60度まで倒せるが、そこまでいくと表示範囲 (getBounds) が真上から見たときの
  // 7.1倍まで広がる。50度なら3.1倍で、立体感は十分に出る。
  const BUILDINGS_PITCH = 50;
  let buildingsToken = 0;

  /**
   * 設定パネルを向けている出所。**描く出所とは別。**
   *
   * 描くのは一覧でONになっているもの全部 (PLATEAUとOvertureを同時に出せる)。
   * ここが決めるのは、共有している設定パネルの中身 (絞り込み・件数・移動ボタン)
   * をどちらに向けるかだけ。どちらかの ⚙ を押すと切り替わる。
   */
  let settingsSource: BuildingSource | undefined = buildingSources[0];
  /**
   * 絞り込み。**出所ごとに持つ。** 用途の語彙が出所ごとに違う
   * (PLATEAUは「商業施設」、Overtureは `commercial`) ので、共有すると意味が変わる。
   */
  const filters = new Map<string, BuildingFilter>(
    buildingSources.map((source) => [source.id, { minHeight: 0, usages: null }]),
  );
  const filterOf = (source: BuildingSource): BuildingFilter => filters.get(source.id)!;

  /** 行の状態に書き、パネルを開いている出所なら件数の欄にも出す。 */
  const showBuildingStatus = (source: BuildingSource, text: string) => {
    setLayerStatus(source.id, text);
    if (source === settingsSource) buildingCountEl.textContent = text;
  };

  /**
   * 一覧でONになっている出所の建物を引き直す。
   *
   * **出所ごとに引いて1つのソースにまとめる。** 地物に `origin` (Collection ID) を
   * 持たせて塗り分けるので、地図のレイヤーは出所が増えても1組のまま。
   * 上限は出所ごとに掛かる (両方ONなら最大で2倍描く)。
   */
  const refreshBuildings = async () => {
    const mapSource = map.getSource('buildings') as GeoJSONSource | undefined;
    const coverage = map.getSource('buildings-coverage') as GeoJSONSource | undefined;
    if (!mapSource || buildingSources.length === 0) return;

    const visible = buildingSources.filter((source) => isLayerVisible(source.id));
    // 取得を始める前に件数表示を空にする。引いていたときの「拡大すると建物が出ます」が
    // 残っていると、すでに寄っている利用者に拡大しろと言い続けることになる。
    for (const source of buildingSources) showBuildingStatus(source, '');

    if (visible.length === 0) {
      await coverage?.setData(EMPTY_FEATURE_COLLECTION);
      await mapSource.setData(EMPTY_FEATURE_COLLECTION);
      return;
    }

    const zoomedOut = map.getZoom() < detail.buildingsMinZoom;
    const token = ++buildingsToken;
    const b = map.getBounds();
    const c = map.getCenter();
    const bounds: ViewBounds = {
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
      centerLon: c.lng,
      centerLat: c.lat,
    };

    // 状態は最後にまとめて出す。途中で打ち切ったとき (地図が動いた) に
    // 片方の出所だけ新しい件数が出る、という食い違いを作らない。
    const statuses: [BuildingSource, string][] = [];

    // **引いた表示では整備範囲を出す。**
    //
    // 建物そのものを出す道は無い — 簡略化はフットプリントが1px未満で効かず、
    // 高さで選ぶのは基準に意味を持たせられなかった。代わりに
    // 「**どこまで整備されているか**」を1kmのメッシュで見せる。
    if (zoomedOut) {
      await mapSource.setData(EMPTY_FEATURE_COLLECTION);
      const features: GeoJSON.Feature[] = [];
      for (const source of visible) {
        if (!source.coverage) {
          if (coverageToggle.checked && source.bbox) {
            features.push(...bboxFeatureCollection(source.bbox).features);
          }
          // **どこまで寄れば出るかを数字で言う。**「拡大すると」だけだと、
          // どれだけ動かせばいいのか分からない。
          statuses.push([source, `ズーム${detail.buildingsMinZoom}まで寄ると出ます`]);
          continue;
        }

        const area = source.coverage;
        // 配られているより細かくはできない。引くほど粗く束ねる。
        const digits = Math.min(meshDigits(map.getZoom()), area.meshDigits);
        const cells = await busy('整備範囲を読み込み中…', async () => {
          await area.ensure();
          return fetchCoverageInView(conn, area, bounds, digits);
        });
        if (token !== buildingsToken) return;

        features.push(...coverageFeatureCollection(cells).features);
        const buildings = cells.reduce((total, cell) => total + cell.buildings, 0);
        statuses.push([
          source,
          `整備範囲 ${cells.length.toLocaleString()} メッシュ` +
            ` (${MESH_SIZE_LABELS[digits] ?? `${digits}桁`}) · ` +
            `建物 ${buildings.toLocaleString()} 棟 · ズーム${detail.buildingsMinZoom}から建物そのもの`,
        ]);
      }
      await coverage?.setData({ type: 'FeatureCollection', features });
      for (const [source, text] of statuses) showBuildingStatus(source, text);
      return;
    }

    // 寄ったら枠もメッシュも消す。実物が出るので要らない。
    await coverage?.setData(EMPTY_FEATURE_COLLECTION);
    const features: GeoJSON.Feature[] = [];
    for (const source of visible) {
      const rows = await busy('建物を読み込み中…', async () => {
        await source.ensure();
        return fetchBuildingsInView(conn, source, bounds, filterOf(source), detail.buildingsLimit);
      });
      if (token !== buildingsToken) return;

      for (const row of rows) {
        features.push({
          type: 'Feature',
          properties: {
            name: row.name,
            category: row.category,
            height: row.height,
            // **どの出所の建物か。** ホバーの「出所」に使う。
            origin: source.id,
            // 塗り分けの番号。IDを塗りの式に書くと出所が増えたときに直す場所が
            // 分かれるので、カタログに並んだ順番で渡す。
            palette: buildingSources.indexOf(source),
          },
          geometry: row.geojson,
        });
      }
      const count =
        rows.length >= detail.buildingsLimit
          ? `${detail.buildingsLimit}件以上 (表示上限)`
          : `${rows.length}件`;
      statuses.push([source, count + sourceLodNote(source, bounds)]);
    }
    await mapSource.setData({ type: 'FeatureCollection', features });
    for (const [source, text] of statuses) showBuildingStatus(source, text);
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

    // 行は細かさ違いのCollectionを束ねた1つで、IDは先頭のもの (一覧側と同じ規則)。
    if (!isLayerVisible(meshSources[0]?.id ?? '')) {
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

  /**
   * 鉄道を引き直す。
   *
   * **ズームで隠さない。** 路線のジオメトリ列は原寸で4.5MBあって全国を一度に
   * 読むと起動時の転送量 (1.5MB) を超えるが、**引いたときは粗い段 (`lod = 0`) を
   * 引く**ので全国597本・329KBで足りる。
   *
   * **駅には段が無い。** 点に近い短い線なので簡略化しても縮まない。
   * 表示範囲で絞るだけで足りる (全国で2.2万件・821KB)。
   */
  // 1回に描く上限は `detail.railwayLimit`。路線と駅の合計ではなく、それぞれに掛かる。
  let railwayToken = 0;
  let railwayShown = false;

  const refreshRailway = async () => {
    const lineSource = map.getSource('railway') as GeoJSONSource | undefined;
    const stationSource = map.getSource('railway-stations') as GeoJSONSource | undefined;
    if (!lineSource || !stationSource) return;

    // メッシュと同じく、既に空なら何もしない。`moveend` ごとに空データを
    // ワーカーへ往復させると、建物の描画と同じワーカーを取り合うことになる。
    const clear = async (message: string) => {
      if (railwayShown) {
        await lineSource.setData(EMPTY_FEATURE_COLLECTION);
        await stationSource.setData(EMPTY_FEATURE_COLLECTION);
        railwayShown = false;
      }
      railwaySummaryEl.textContent = message;
      for (const source of railwaySources) setLayerStatus(source.id, '');
    };

    // **路線と駅は別のCollectionなので、一覧でも別の行。** ONの方だけを引く。
    // 絞り込み (事業者種別) と設定パネルは両方で共有する。
    const visibleSources = railwaySources.filter((source) => isLayerVisible(source.id));
    if (visibleSources.length === 0) {
      await clear('');
      return;
    }

    const selectedTypes = [...railwayTypeInputs]
      .filter((input) => input.checked)
      .map((input) => input.value);

    const token = ++railwayToken;
    const results = await busy('鉄道を読み込み中…', async () => {
      const b = map.getBounds();
      const c = map.getCenter();
      const bounds: ViewBounds = {
        west: b.getWest(),
        south: b.getSouth(),
        east: b.getEast(),
        north: b.getNorth(),
        centerLon: c.lng,
        centerLat: c.lat,
      };
      return Promise.all(
        visibleSources.map(async (source) => {
          await source.ensure();
          return {
            kind: source.kind,
            features: await fetchRailwayInView(
              conn,
              source,
              bounds,
              railwayInstitutionTypes.length > 0 ? selectedTypes : null,
              detail.railwayLimit,
              // 駅には段が無いので、そちらは undefined が返って条件が付かない。
              lodForZoom(source, map.getZoom()),
            ),
          };
        }),
      );
    });
    if (token !== railwayToken) return;

    const toGeoJson = (features: RailwayFeature[]): GeoJSON.FeatureCollection => ({
      type: 'FeatureCollection',
      features: features.map((feature) => ({
        type: 'Feature',
        properties: {
          // 色は引くときに決める (凡例と同じ表から作る)。
          color: RAILWAY_COLORS[feature.institutionType] ?? RAILWAY_FALLBACK_COLOR,
          lineName: feature.lineName,
          operator: feature.operator,
          institutionType: feature.institutionType,
          railwayClass: feature.railwayClass,
          stationName: feature.stationName,
        },
        geometry: feature.geojson,
      })),
    });

    const lines = results.find((r) => r.kind === 'railway')?.features ?? [];
    const stations = results.find((r) => r.kind === 'railway_station')?.features ?? [];

    railwayShown = true;
    await lineSource.setData(toGeoJson(lines));
    await stationSource.setData(toGeoJson(stations));

    // 行ごとの状態。**出していない方は空にする** (前の件数が残らないように)。
    for (const source of railwaySources) {
      if (!visibleSources.includes(source)) {
        setLayerStatus(source.id, '');
        continue;
      }
      const features = source.kind === 'railway' ? lines : stations;
      setLayerStatus(
        source.id,
        features.length === 0
          ? 'この範囲にありません'
          : `${features.length.toLocaleString()} ${source.kind === 'railway' ? '本' : '駅'}` +
              lodNote(source, lodForZoom(source, map.getZoom())) +
              (features.length >= detail.railwayLimit ? ' (表示上限)' : ''),
      );
    }

    if (lines.length === 0 && stations.length === 0) {
      railwaySummaryEl.textContent = 'この範囲に鉄道がありません';
      return;
    }
    const capped = lines.length >= detail.railwayLimit || stations.length >= detail.railwayLimit;
    const lineSourceInfo = visibleSources.find((source) => source.kind === 'railway');
    railwaySummaryEl.textContent =
      `路線 ${lines.length.toLocaleString()} / 駅 ${stations.length.toLocaleString()}` +
      (lineSourceInfo ? lodNote(lineSourceInfo, lodForZoom(lineSourceInfo, map.getZoom())) : '') +
      (capped ? ' (上限に達しました。拡大すると全部出ます)' : '');
  };

  /**
   * 道路を引き直す。
   *
   * **ズームで隠さない。** 幹線だけで65.6万区間あり、原寸を引いた画面に出すと
   * 9.4MB転送になって線で埋まるが、**引いたときは粗い段 (`lod = 0`) を引く**ので
   * 全国でも高速1,360本・483KBで足りる。どのズームでどちらを引くかは
   * [`lodForZoom`] がデータの許容誤差から決める。
   */
  // 1回に描く上限は `detail.roadLimit`。
  let roadToken = 0;
  let roadShown = false;

  /**
   * 等級ごとに、**どのズームから出すか**。
   *
   * **簡略化だけでは足りない。** 粗い段で転送量は収まるが、全国の都道府県道
   * 4,609本を一度に描くと画面が線で埋まって何も読めず、細い線が重なるので
   * ツールチップも拾うたびに移り変わる。**引いたら幹線だけにする。**
   *
   * 高速はズーム0から出す (全国の骨格として読めるし、1,360本しかない)。
   * これは標準の値で、表示量の設定 (`detail.roadClassZoomShift`) でずらす。
   */
  const ROAD_CLASS_MIN_ZOOM: Record<string, number> = {
    motorway: 0,
    trunk: 8,
    primary: 10,
  };

  /** 表示量の設定を反映した、その等級が出るズーム。0より下げない。 */
  const roadClassMinZoom = (cls: string): number =>
    Math.max(0, (ROAD_CLASS_MIN_ZOOM[cls] ?? 0) - detail.roadClassZoomShift);

  /** このズームで出す等級。選ばれているもののうち、出してよいものだけ。 */
  const roadClassesForZoom = (selected: string[], zoom: number): string[] =>
    selected.filter((cls) => zoom >= roadClassMinZoom(cls));

  const refreshRoads = async () => {
    const source = map.getSource('road') as GeoJSONSource | undefined;
    if (!source || !roadSource) return;

    const clear = async (message: string) => {
      if (roadShown) {
        await source.setData(EMPTY_FEATURE_COLLECTION);
        roadShown = false;
      }
      roadSummaryEl.textContent = message;
    };

    if (!isLayerVisible(roadSource.id)) {
      await clear('');
      return;
    }

    const selectedClasses = [...roadClassInputs]
      .filter((input) => input.checked)
      .map((input) => input.value);

    const zoom = map.getZoom();
    // **引いたら幹線だけにする。** 選んであっても、そのズームで読めない等級は出さない。
    const shownClasses = roadClassesForZoom(selectedClasses, zoom);
    const heldBack = selectedClasses.length - shownClasses.length;

    const lod = lodForZoom(roadSource, zoom);
    const token = ++roadToken;
    const features = await busy('道路を読み込み中…', async () => {
      await roadSource.ensure();
      const b = map.getBounds();
      const c = map.getCenter();
      return fetchRoadsInView(
        conn,
        roadSource,
        {
          west: b.getWest(),
          south: b.getSouth(),
          east: b.getEast(),
          north: b.getNorth(),
          centerLon: c.lng,
          centerLat: c.lat,
        },
        shownClasses,
        detail.roadLimit,
        lod,
      );
    });
    if (token !== roadToken) return;

    roadShown = true;
    await source.setData({
      type: 'FeatureCollection',
      features: features.map((feature) => {
        const style = ROAD_STYLES[feature.roadClass];
        return {
          type: 'Feature',
          properties: {
            color: style?.color ?? '#777777',
            width: style?.width ?? 1.5,
            roadName: feature.roadName,
            roadClass: style?.label ?? feature.roadClass,
            // ホバーで出すので、ここで読める形にしておく。
            routeNames: feature.routeNames.join(' / '),
          },
          geometry: feature.geojson,
        };
      }),
    });

    // **出していない等級があることを言う。** 黙って外すと「チェックしたのに
    // 出ない」ように見える。どのズームで出るかも数字で言う。
    const heldBackNote = () => {
      if (heldBack === 0) return '';
      const next = Math.min(
        ...selectedClasses
          .filter((cls) => !shownClasses.includes(cls))
          .map(roadClassMinZoom),
      );
      return ` · ${heldBack}種別はズーム${next}から`;
    };

    if (features.length === 0) {
      roadSummaryEl.textContent =
        (shownClasses.length === 0 ? '選んだ等級はこのズームでは出しません' : 'この範囲に道路がありません') +
        heldBackNote();
      return;
    }
    const capped = features.length >= detail.roadLimit;
    roadSummaryEl.textContent =
      `${features.length.toLocaleString()} ${lod === COARSE_LOD ? '本' : '区間'}` +
      lodNote(roadSource, lod) +
      heldBackNote() +
      (capped ? ' (上限に達しました。拡大すると全部出ます)' : '');
  };

  const requestRoadRefresh = () => {
    refreshRoads().catch((e: unknown) => {
      console.error('[road] failed', e);
      showFailure('道路の読み込みに失敗しました');
    });
  };

  const requestRailwayRefresh = () => {
    refreshRailway().catch((e: unknown) => {
      console.error('[railway] failed', e);
      showFailure('鉄道の読み込みに失敗しました');
    });
  };

  if (railwaySources.length > 0) {

    // 選択肢はカタログの語彙から作る。色見本を添えて、地図の色と対応付ける。
    for (const type of railwayInstitutionTypes) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = type;
      input.checked = true;
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = RAILWAY_COLORS[type] ?? RAILWAY_FALLBACK_COLOR;
      label.append(input, swatch, document.createTextNode(type));
      railwayTypesEl.append(label);
    }
    railwayTypeInputs = [...railwayTypesEl.querySelectorAll<HTMLInputElement>('input')];
    for (const input of railwayTypeInputs) {
      input.addEventListener('change', requestRailwayRefresh);
    }
    const setAll = (checked: boolean) => {
      for (const input of railwayTypeInputs) input.checked = checked;
      requestRailwayRefresh();
    };
    railwayAllButton.addEventListener('click', () => setAll(true));
    railwayNoneButton.addEventListener('click', () => setAll(false));

    map.on('moveend', requestRailwayRefresh);
  }

  if (roadSource) {
    // 鉄道と同じ作り。**等級はカタログの語彙から**来るので、順番だけ
    // ROAD_STYLES に沿わせる (高速 → 国道 → 都道府県道)。
    const ordered = Object.keys(ROAD_STYLES).filter((cls) => roadClasses.includes(cls));
    const rest = roadClasses.filter((cls) => !(cls in ROAD_STYLES));
    for (const cls of [...ordered, ...rest]) {
      const style = ROAD_STYLES[cls];
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = cls;
      input.checked = true;
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = style?.color ?? '#777777';
      label.append(input, swatch, document.createTextNode(style?.label ?? cls));
      roadClassesEl.append(label);
    }
    roadClassInputs = [...roadClassesEl.querySelectorAll<HTMLInputElement>('input')];
    for (const input of roadClassInputs) {
      input.addEventListener('change', requestRoadRefresh);
    }
    const setAllRoads = (checked: boolean) => {
      for (const input of roadClassInputs) input.checked = checked;
      requestRoadRefresh();
    };
    roadAllButton.addEventListener('click', () => setAllRoads(true));
    roadNoneButton.addEventListener('click', () => setAllRoads(false));

    map.on('moveend', requestRoadRefresh);
  }

  if (meshSources.length > 0) {
    for (const [index, { label }] of AIRCRAFT_CLASSES.entries()) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = label;
      aircraftSelect.append(option);
    }
    renderLegend();

    // 機体を変えても地図の色は変わらない (色は密度の帯で決まる)。
    // 変わるのは凡例と要約に出る iGRC の値だけなので、引き直さない。
    aircraftSelect.addEventListener('change', () => {
      aircraftIndex = Number(aircraftSelect.value);
      renderLegend();
      requestMeshRefresh();
    });
    map.on('moveend', requestMeshRefresh);
  }

  // ---- レイヤー一覧 -------------------------------------------------------
  //
  // **カタログの階層をそのまま一覧にする。** サブカタログ (PLATEAU / Overture Maps …)
  // が見出し、Collectionが行。以前は「建物」「道路」のように使う側から見た
  // まとまりで組んでいて、画面からカタログが見えなかった。
  //
  // 行とCollectionは**ほぼ1対1**。例外は2つだけ。
  // - 人口メッシュは細かさ違いのCollection (125m / 1km) をズームで選ぶので1行に束ねる
  // - 整備範囲は建物の「引いた姿」なので行にせず、建物の ⚙ の中に出す
  //   (`duck:covers` で結ばれている)
  interface Layer {
    /** 先頭のCollectionのID。**行とCollectionを同じ名前で呼ぶ。** */
    id: string;
    title: string;
    /** どのサブカタログの下か。一覧の見出しになる。 */
    group: CatalogGroup | undefined;
    /** この行を作っているCollection。⚙ で中身を見せる。 */
    collections: Collection[];
    vintage?: string;
    /** 収録範囲。**この場所にあるか**の判定に使う。複数Collectionなら和。 */
    bbox: Bbox | null;
    visible: boolean;
    /** 出るのに要るズーム。**無ければどの縮尺でも出る。** */
    minZoom?: number;
    /** 設定の中身。一覧から開いたときに出す。**複数の行で共有することがある。** */
    settings: HTMLElement;
    /** 共有している設定パネルを、この行に向ける。 */
    onOpen?: () => void;
    refresh: () => void;
  }

  const byKind = (kind: DatasetKind) => collections.filter((c) => c.kind === kind);
  const bboxOf = (members: Collection[]) =>
    unionBbox(members.map((c) => c.bbox).filter((b): b is Bbox => b !== null));

  /** 建物の設定パネルをその出所に向ける。中身は建物の節 (下) で埋める。 */
  let pointBuildingSettings: (source: BuildingSource) => void = () => {};

  // **カタログに書かれた順に並べる。** 並びはパイプライン側 (`SUB_CATALOGS`) が決める。
  const layers: Layer[] = [];
  for (const collection of collections) {
    const base = {
      id: collection.id,
      title: collection.title,
      group: collection.group,
      collections: [collection],
      vintage: collection.vintage,
      bbox: collection.bbox,
      visible: false,
    };
    switch (collection.kind) {
      case 'plateau_buildings':
      case 'buildings': {
        const source = buildingSources.find((s) => s.id === collection.id);
        if (!source) break;
        const coverage = collections.find(
          (c) => c.kind === 'building_coverage' && c.covers === collection.id,
        );
        layers.push({
          ...base,
          collections: coverage ? [collection, coverage] : [collection],
          // **カタログで先頭の建物だけ既定で出す。** このアプリの出発点なので
          // 何か出ていてほしいが、両方出すと重なって描かれる。
          visible: source === buildingSources[0],
          minZoom: detail.buildingsMinZoom,
          settings: buildingsSection,
          onOpen: () => pointBuildingSettings(source),
          refresh: requestRefresh,
        });
        break;
      }
      case 'population_mesh': {
        // 細かさ違いを1行に束ねる。**描画側と同じく先頭のメッシュをIDにする。**
        const first = meshSources[0];
        if (!first || first.id !== collection.id) break;
        const members = byKind('population_mesh');
        layers.push({
          ...base,
          collections: members,
          bbox: bboxOf(members),
          settings: meshSectionEl,
          refresh: requestMeshRefresh,
        });
        break;
      }
      case 'railway':
      case 'railway_station':
        if (!railwaySources.some((s) => s.id === collection.id)) break;
        layers.push({
          ...base,
          // **「寄る」ボタンを出さない。** 引いた表示でも粗い段が出るので、
          // 寄らないと見えないものが無い。設定 (事業者種別) は路線と駅で共有する。
          settings: railwaySectionEl,
          refresh: requestRailwayRefresh,
        });
        break;
      case 'road':
        if (roadSource?.id !== collection.id) break;
        // 鉄道と同じく「寄る」ボタンは出さない。
        layers.push({ ...base, settings: roadSectionEl, refresh: requestRoadRefresh });
        break;
      default:
        // 検索の裏方と整備範囲は行にしない (「検索できるもの」と建物の ⚙ に出る)。
        break;
    }
  }

  const isLayerVisible = (id: string) => layers.find((l) => l.id === id)?.visible ?? false;

  // 設定はパネルの中身を入れ替えて出す。**取り外さない** — 外すと
  // 参照は生きていてもDOMから消え、CSSもテストのセレクタも当たらなくなる。
  for (const layer of layers) {
    layer.settings.hidden = true;
    layerSettingsBodyEl.append(layer.settings);
  }

  const showLayerList = () => {
    layerSettingsEl.hidden = true;
    layerListEl.hidden = false;
  };

  /** 配信しているJSONそのものへのリンク。**カタログが実在することを見せる。** */
  const jsonLink = (path: string | undefined, label: string): HTMLElement => {
    const link = document.createElement('a');
    link.className = 'json-link';
    link.textContent = `${label} ↗`;
    if (path) {
      link.href = dataUrl(path);
      link.target = '_blank';
      link.rel = 'noopener';
    }
    return link;
  };

  const formatBbox = ([west, south, east, north]: Bbox) =>
    `${west.toFixed(2)}, ${south.toFixed(2)} – ${east.toFixed(2)}, ${north.toFixed(2)}`;

  /**
   * Collection 1つぶんの中身。**カタログに書いてあることだけを出す。**
   *
   * 絞り込みだけでは、行の裏にあるのがどのCollectionで、何ファイルあって、
   * 元のJSONはどこか、が画面から辿れない。
   */
  const collectionCard = (collection: Collection): HTMLElement => {
    const card = document.createElement('div');
    card.className = 'collection-card';
    card.dataset.collection = collection.id;

    const head = document.createElement('div');
    head.className = 'collection-head';
    const id = document.createElement('code');
    id.textContent = collection.id;
    head.append(id, jsonLink(collection.path, 'Collection'));

    const description = document.createElement('p');
    description.className = 'collection-description';
    description.textContent = collection.description;

    const facts = document.createElement('dl');
    facts.className = 'collection-facts';
    const fact = (term: string, ...value: (string | Node)[]) => {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.append(...value);
      facts.append(dt, dd);
      return dd;
    };
    // `other` は「SPDXに当てはまるものが無い」。中身は利用規約にあるので、そこへ飛ばす。
    fact(
      'ライセンス',
      collection.license === 'other'
        ? externalLink(collection.attributionUrl, '利用規約')
        : collection.license,
    );
    if (collection.provider) fact('提供', collection.provider);
    if (collection.vintage) fact('版', collection.vintage);
    // **ファイル数はItemCollectionを読まないと分からない。** 起動時には読まない
    // 約束なので、開いたときに読む (1回だけ。建物を引くときもこれを使い回す)。
    const count = document.createElement('span');
    count.className = 'collection-item-count';
    count.textContent = '…';
    fact('ファイル', count, ' ', jsonLink(collection.itemsPath, 'Items'));
    collection
      .items()
      .then((items) => (count.textContent = `${items.length.toLocaleString()} 件`))
      .catch(() => (count.textContent = '読めません'));
    if (collection.bbox) fact('範囲', formatBbox(collection.bbox));

    // 列は多い (PLATEAUは十数列) ので、たたんでおく。
    const columns = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `列 (${collection.columns.size})`;
    const list = document.createElement('p');
    list.textContent = [...collection.columns].join(', ');
    columns.append(summary, list);

    card.append(head, description, facts, columns);
    return card;
  };

  const openLayerSettings = (layer: Layer) => {
    // **要素で比べる。** 建物のPLATEAUとOvertureは同じパネルを共有しているので、
    // 行で比べると並び順によっては自分のパネルをもう一方の行が隠してしまう。
    for (const other of layers) other.settings.hidden = other.settings !== layer.settings;
    layerSettingsTitleEl.textContent = layer.group ? `${layer.group.title} › ${layer.title}` : layer.title;
    layerCatalogEl.replaceChildren(...layer.collections.map(collectionCard));
    layer.onOpen?.();
    layerListEl.hidden = true;
    layerSettingsEl.hidden = false;
  };

  layerBackButton.addEventListener('click', showLayerList);

  /** 表示範囲と収録範囲が重なるか。**通信しない** (起動時に読んだbboxだけを見る)。 */
  const coversView = (bbox: Bbox | null): boolean => {
    if (!bbox) return true; // 分からないものは落とさない
    const b = map.getBounds();
    const [west, south, east, north] = bbox;
    return (
      west <= b.getEast() && east >= b.getWest() && south <= b.getNorth() && north >= b.getSouth()
    );
  };

  const layerRow = (layer: Layer, present: boolean): HTMLElement => {
    const row = document.createElement('div');
    row.className = present ? 'layer-row' : 'layer-row absent';
    row.dataset.layer = layer.id;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = layer.visible;
    toggle.id = `layer-toggle-${layer.id}`;
    toggle.addEventListener('change', () => {
      layer.visible = toggle.checked;
      layer.refresh();
    });

    const name = document.createElement('label');
    name.className = 'layer-name';
    name.htmlFor = toggle.id;
    name.textContent = layer.title;

    // 状態 (件数や「拡大すると出ます」) は**行に出す**。設定の中に置くと、
    // 開かない限り読めない。出ない理由が分からないのがいちばん困る。
    const status = document.createElement('span');
    status.className = 'layer-status';
    status.dataset.layerStatus = layer.id;
    status.textContent = layerStatus.get(layer.id) ?? '';

    // 出所は見出し (サブカタログ) が言うので、行には版だけを添える。
    const source = document.createElement('span');
    source.className = 'layer-source';
    source.textContent = layer.vintage ?? '';

    // **いまの位置のまま寄る。** 「建物のある範囲へ移動」は場所ごと動かすが、
    // 見たい場所は既に画面にあることが多く、足りないのはズームだけ。
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'layer-zoom-button';
    zoomIn.textContent = '🔍';
    zoomIn.title = `ズーム${layer.minZoom ?? 0}まで寄る`;
    zoomIn.hidden = layer.minZoom === undefined;
    zoomIn.addEventListener('click', () => {
      if (layer.minZoom === undefined) return;
      // 出していなければ一緒に出す。寄っただけで何も出ないのは分かりにくい。
      if (!layer.visible) {
        layer.visible = true;
        toggle.checked = true;
      }
      map.easeTo({ zoom: layer.minZoom, duration: 600 });
      layer.refresh();
    });

    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'layer-settings-button';
    settings.textContent = '⚙';
    settings.title = `${layer.title}の設定`;
    settings.addEventListener('click', () => openLayerSettings(layer));

    // **2段にする。** 名前・状態・出所・ボタンを1行に詰めると、幅の取り合いで
    // 出所が幅0まで潰れた (17.5remのパネルで実際に起きた)。
    // 段が増えても**データ1つにつき1行**なので、増え方は変わらない。
    const head = document.createElement('div');
    head.className = 'layer-head';
    head.append(toggle, name, zoomIn, settings);

    const sub = document.createElement('div');
    sub.className = 'layer-sub';
    sub.append(source, status);

    row.append(head, sub);
    return row;
  };

  /**
   * 設定の中にある要約を、一覧の行へ写す。**行とパネルが1対1のものだけ**に使う。
   *
   * 建物 (PLATEAUとOverture) と鉄道 (路線と駅) は1つのパネルを2行で共有するので、
   * 要約1つを写すと両方の行に同じことが出る。そちらは描く側が行ごとに直接書く。
   */
  const mirrorStatus = (layerId: string, from: HTMLElement) => {
    const apply = () => setLayerStatus(layerId, from.textContent ?? '');
    new MutationObserver(apply).observe(from, { childList: true, characterData: true, subtree: true });
    apply();
  };

  /** サブカタログの見出し。その文書のJSONへのリンクを添える。 */
  const groupHeading = (group: CatalogGroup): HTMLElement => {
    const heading = document.createElement('div');
    heading.className = 'layer-group';
    heading.dataset.group = group.id;
    heading.title = group.description;
    const title = document.createElement('span');
    title.className = 'layer-group-title';
    title.textContent = group.title;
    heading.append(title, jsonLink(group.path, 'Catalog'));
    return heading;
  };

  /** 行を並べ、サブカタログが変わるところに見出しを挟む。 */
  const withHeadings = (rows: Layer[], present: boolean): HTMLElement[] => {
    const nodes: HTMLElement[] = [];
    let previous: CatalogGroup | undefined;
    for (const layer of rows) {
      if (layer.group && layer.group.id !== previous?.id) nodes.push(groupHeading(layer.group));
      previous = layer.group;
      nodes.push(layerRow(layer, present));
    }
    return nodes;
  };

  /** 裏方 (検索・逆ジオコーディングが使うもの)。**切れてはいけない**ので出すだけ。 */
  const supportRow = (title: string, source: string): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'layer-row support';
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = title;
    const sourceEl = document.createElement('span');
    sourceEl.className = 'layer-source';
    sourceEl.textContent = source;
    row.append(name, sourceEl);
    return row;
  };

  const renderLayerList = () => {
    const present = layers.filter((layer) => coversView(layer.bbox));
    const absent = layers.filter((layer) => !coversView(layer.bbox));
    layerRowsEl.replaceChildren(...withHeadings(present, true));
    layerAbsentRowsEl.replaceChildren(...withHeadings(absent, false));
    layerAbsentEl.hidden = absent.length === 0;
  };

  // 人口メッシュと道路はパネルと行が1対1なので、パネルの要約をそのまま写す。
  if (meshSources[0]) mirrorStatus(meshSources[0].id, meshSummaryEl);
  if (roadSource) mirrorStatus(roadSource.id, roadSummaryEl);

  if (layers.length > 0) {
    renderLayerList();
    // 収録範囲はCollectionのbbox (=ファイルの和) なので**粗い**。PLATEAUを全国に
    // 広げると「日本全体」になり、306都市の外でも「ある」と出る。正確な範囲は
    // Itemが持っていて、レイヤーをONにすると `ensure()` が読んで `filesInView` が絞る。
    map.on('moveend', renderLayerList);
  }

  // ---- 表示量 ---------------------------------------------------------------
  //
  // **全レイヤーに一度に効く。** 建物だけ上げて道路はそのまま、という使い方は
  // 想定しない — 重いかどうかは端末で決まり、レイヤーごとには決まらないため。
  const detailSelect = document.querySelector<HTMLSelectElement>('#detail-level')!;
  for (const [level, { label }] of Object.entries(DETAIL_LEVELS)) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = label;
    detailSelect.append(option);
  }
  detailSelect.value = loadDetailLevel();
  detailSelect.addEventListener('change', () => {
    const level = detailSelect.value as DetailLevel;
    detail = DETAIL_LEVELS[level];
    saveDetailLevel(level);

    // 「寄る」ボタンの行き先は建物のズームで決まる。行は作り直すので値だけ差し替える。
    // 寄るボタンを持つのは建物の行だけ (出所の数だけある)。
    for (const layer of layers) {
      if (layer.minZoom !== undefined) layer.minZoom = detail.buildingsMinZoom;
    }
    if (layers.length > 0) renderLayerList();

    requestRefresh();
    requestRailwayRefresh();
    requestRoadRefresh();
  });

  // 裏方は種別から引く。**一覧に出すが切らせない** (外すと検索が壊れる)。
  const supportKinds: [DatasetKind, string][] = [
    // **打つ言葉で書く。** データセット名 (「位置参照情報」) では、
    // 何を打てば当たるのかが分からない。出所は2段目に小さく出る。
    ['admin', '市区町村名'],
    ['oaza', '町名・丁目'],
    ['block', '街区 (〜丁目〜番)'],
    ['railway_station', '駅名・路線名'],
    ['road_route', '道路名 (国道13号など)'],
  ];
  const supportRows = supportKinds.flatMap(([kind, title]) => {
    const collection = byKind(kind)[0];
    return collection ? [supportRow(title, collection.attribution.split('（')[0])] : [];
  });
  if (supportRows.length > 0) {
    layerSupportRowsEl.replaceChildren(...supportRows);
    layerSupportEl.hidden = false;
  }

  if (settingsSource) {
    map.on('moveend', requestRefresh);

    /** チェック状態を条件に反映する。全部入っていれば「絞っていない」= null。 */
    const syncUsageFilter = (all: string[]) => {
      if (!settingsSource) return;
      const checked = [...usageOptionsEl.querySelectorAll<HTMLInputElement>('input:checked')];
      filterOf(settingsSource).usages =
        checked.length === all.length ? null : checked.map((c) => c.value);
      requestRefresh();
    };

    // 選択肢はカタログに入っているので、**ここでデータを読まない**。
    // 以前はここで全ファイルの用途の列を走査していて、起動のたびに
    // ファイルの数だけ往復していた。
    const showFilters = (source: BuildingSource) => {
      const filter = filterOf(source);
      heightField.hidden = !source.hasHeight;
      usageField.hidden = source.categoryColumn === null;
      filtersEl.hidden = !source.hasHeight && source.categoryColumn === null;

      // **その出所の絞り込みを戻す。** パネルは共有なので、開き直すたびに
      // 前に開いていた出所の値が残っている。
      minHeightInput.value = String(filter.minHeight);
      minHeightValue.textContent = `${filter.minHeight} m`;

      if (source.categoryColumn === null) return;
      const usages = source.usages;

      // 出所ごとに語彙が違うので、切り替えのたびに作り直す。
      usageOptionsEl.replaceChildren();
      for (const usage of usages) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = usage;
        checkbox.checked = filter.usages === null || filter.usages.includes(usage);
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

    coverageToggle.addEventListener('change', requestRefresh);

    // **どちらかの ⚙ を押したら、共有しているパネルをその出所に向ける。**
    // 描く出所は変えない (それは一覧のチェックが決める)。
    pointBuildingSettings = (source) => {
      settingsSource = source;
      showFilters(source);
      buildingCountEl.textContent = layerStatus.get(source.id) ?? '';
    };
    showFilters(settingsSource);
    // 収録範囲の枠は refreshBuildings が出すが、その呼び出しは moveend でしか
    // 起きない。起動直後にも一度呼んでおかないと、地図を動かすまで枠が出ない。
    requestRefresh();

    // スライダーは動かすたびにイベントが飛ぶので、少し待ってからクエリする。
    let heightTimer: ReturnType<typeof setTimeout> | undefined;
    minHeightInput.addEventListener('input', () => {
      if (!settingsSource) return;
      const filter = filterOf(settingsSource);
      filter.minHeight = Number(minHeightInput.value);
      minHeightValue.textContent = `${filter.minHeight} m`;
      clearTimeout(heightTimer);
      heightTimer = setTimeout(requestRefresh, 200);
    });

    // 建物は一部の範囲しか収録していないうえ、寄らないと出てこない。
    // 偶然そこへ行かないと機能に気づけないので、移動する手段を出しておく。
    //
    // **パネルを向けている出所の範囲へ飛ぶ。** 出所全部の和にすると、収録範囲の
    // 広さが違うときに外れる — PLATEAUを306都市に広げたら和は日本全体になり、
    // その中心 (岡山付近) にはOvertureの建物が1棟も無かった。
    if (buildingSources.some((source) => source.bbox)) {
      gotoBuildingsButton.hidden = false;
      gotoBuildingsButton.addEventListener('click', () => {
        const source = settingsSource;
        const bbox = source?.bbox;
        if (!source || !bbox) return;
        // 出していなければ一緒に出す。飛んだ先で何も出ないのは分かりにくい。
        const layer = layers.find((l) => l.id === source.id);
        if (layer && !layer.visible) {
          layer.visible = true;
          renderLayerList();
        }
        const [west, south, east, north] = bbox;
        // flyTo に1.5秒かかり、その後の moveend まで refreshBuildings は始まらない。
        // 押した感触が無いと二度押しされるので、移動そのものを合図の対象にする。
        // 続けて refreshBuildings 側の合図が立つので、表示は途切れない。
        void busy(
          '建物のある範囲へ移動中…',
          () => new Promise<void>((resolve) => map.once('moveend', () => resolve())),
        );
        // 収録範囲の全体を映すのではなく、その中心に寄る。
        // fitBounds だと範囲が広いときに detail.buildingsMinZoom を下回り、
        // 移動した先で建物が出ないという逆の結果になる。
        map.flyTo({
          center: [(west + east) / 2, (south + north) / 2],
          zoom: detail.buildingsMinZoom + 1,
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
    className: 'hover-popup',
  });

  /**
   * ホバーの中身を組み立てる。
   *
   * **`setText` に改行を渡しても効かない。** テキストノードになるので `\n` は
   * 空白に潰れ、項目が横一列に並んで読めなくなる。かといって `setHTML` は
   * データ由来の文字列 (駅名や事業者名) をそのままHTMLとして解釈するので使わない。
   * 要素を組んで `setDOMContent` に渡す。
   *
   * `rows` は [項目名, 値]。**項目名が空なら見出し**として大きく出す。
   */
  const hoverContent = (rows: [string, string | null][]): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'hover-info';
    for (const [label, value] of rows) {
      if (value === null) continue;
      const line = document.createElement('div');
      if (label) {
        const name = document.createElement('span');
        name.className = 'label';
        name.textContent = label;
        line.append(name, document.createTextNode(value));
      } else {
        line.className = 'title';
        line.textContent = value;
      }
      box.append(line);
    }
    return box;
  };

  if (buildingSources.length > 0) {
    map.on('mousemove', 'buildings-3d', (e) => {
      const building = e.features?.[0];
      if (!building) return;
      hoveringBuilding = true;
      updateCursor();

      const props = building.properties;
      // **どちらの出所の建物か。** PLATEAUとOvertureは同時に出せるので、
      // 重なっているところでは色だけでは見分けにくい。見出しと同じ名前で言う。
      const origin = collections.find((c) => c.id === props.origin);
      hoverPopup
        .setLngLat(e.lngLat)
        .setDOMContent(
          hoverContent([
            ['', (props.name as string | null) ?? '(名称なし)'],
            ['用途', (props.category as string | null) ?? null],
            ['高さ', props.height ? `${props.height as number} m` : null],
            ['出所', origin?.group?.title ?? origin?.title ?? null],
          ]),
        )
        .addTo(map);
    });

    map.on('mouseleave', 'buildings-3d', () => {
      hoveringBuilding = false;
      updateCursor();
      hoverPopup.remove();
    });

    // 整備範囲のメッシュ。**どのメッシュか、どの自治体かが読めること。**
    // 塗りの濃さは埋まり具合しか表さないので、中身はここでしか分からない。
    //
    // 道路と同じく、**同じセルの上を動いている間は作り直さない**
    // (セルは1km四方あるので滅多に変わらないが、境目でちらつく)。
    let hoveredCell = '';

    map.on('mousemove', 'buildings-coverage-fill', (e) => {
      // **判定中はホバーを出さない。** 判定の結果も吹き出しで出すので、
      // 2つ並ぶとどちらが押した場所のものか分からなくなる。
      if (picking) return;
      const cell = e.features?.[0];
      // 収録範囲の枠 (メッシュではない) には何も出さない。中身が無いため。
      if (!cell?.properties.mesh) return;
      hoveringBuilding = true;
      updateCursor();

      hoverPopup.setLngLat(e.lngLat).addTo(map);

      const code = cell.properties.code as string;
      if (code === hoveredCell) return;
      hoveredCell = code;

      const cities = (cell.properties.cities as string) || '(不明)';
      const filled = cell.properties.filled as number;
      const total = cell.properties.total as number;
      hoverPopup.setDOMContent(
        hoverContent([
          ['', `${MESH_SIZE_LABELS[code.length] ?? `${code.length}桁`}メッシュ`],
          ['メッシュコード', code],
          // **束ねると自治体が増える。** 80kmまで引くと何十も並ぶので、
          // 多いときは数だけにする (全部出すとポップアップが画面を覆う)。
          ['自治体', cities.split('、').length > 6 ? `${cities.split('、').length} 市区町村` : cities],
          // **濃淡を数で裏付ける。** 色だけだと「薄い」が読み取れない。
          // 1kmで見ているときは必ず1/1なので出さない。
          ...(total > 1
            ? ([
                [
                  'データのある1kmセル',
                  `${filled.toLocaleString()} / ${total.toLocaleString()} (${Math.round((filled / total) * 100)}%)`,
                ],
              ] as [string, string][])
            : []),
          ['建物', `${(cell.properties.buildings as number).toLocaleString()} 棟`],
        ]),
      );
    });

    map.on('mouseleave', 'buildings-coverage-fill', () => {
      hoveringBuilding = false;
      hoveredCell = '';
      updateCursor();
      hoverPopup.remove();
    });
  }

  if (railwaySources.length > 0) {
    // 駅を先に置く。路線と重なっている場所では駅の方が知りたいことが多い。
    // (MapLibreは先に登録したレイヤーのイベントが先に来るわけではないので、
    //  重なりは `queryRenderedFeatures` の順ではなくレイヤーごとに拾う)
    for (const layer of ['railway-station', 'railway-line']) {
      map.on('mousemove', layer, (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        hoveringBuilding = true;
        updateCursor();

        const props = feature.properties;
        const station = props.stationName as string | null;
        hoverPopup
          .setLngLat(e.lngLat)
          .setDOMContent(
            hoverContent([
              // 駅なら駅名を見出しにする。路線には駅名が入っていない。
              ['', station ? `${station}駅` : (props.lineName as string)],
              ['路線', station ? (props.lineName as string) : null],
              ['事業者', props.operator as string],
              ['種別', props.institutionType as string],
              ['区分', props.railwayClass as string],
              ['時点', railwayVintage ?? null],
            ]),
          )
          .addTo(map);
      });

      map.on('mouseleave', layer, () => {
        hoveringBuilding = false;
        updateCursor();
        hoverPopup.remove();
      });
    }
  }

  if (roadSource) {
    // **同じ道路の上を動いている間は作り直さない。**
    //
    // 道路は交差点ごとに区間が切れているので、1本の道をなぞるだけで別の地物へ
    // 次々に移る。毎回中身を組み直すと、**同じ道を見ているのに表示がちらつく**。
    // 名前と路線と等級が同じなら同じ道として扱い、位置だけ追わせる。
    let hoveredRoad = '';

    map.on('mousemove', 'road-line', (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      hoveringBuilding = true;
      updateCursor();

      const props = feature.properties;
      const routes = (props.routeNames as string) || '';
      const name = props.roadName as string | null;
      const roadClass = props.roadClass as string;

      hoverPopup.setLngLat(e.lngLat).addTo(map);

      const identity = `${name ?? ''}|${routes}|${roadClass}`;
      if (identity === hoveredRoad) return;
      hoveredRoad = identity;

      hoverPopup.setDOMContent(
        hoverContent([
          // 名前が無い区間もある。その場合は路線名を見出しに繰り上げる。
          ['', name || routes || '(名前なし)'],
          // **路線は複数あることがある。** 見出しに使ったものと同じなら繰り返さない。
          ['路線', routes && routes !== name ? routes : null],
          ['種別', roadClass],
          ['時点', roadVintage ?? null],
        ]),
      );
    });

    map.on('mouseleave', 'road-line', () => {
      hoveringBuilding = false;
      hoveredRoad = '';
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
    // **ホバーの吹き出しを先に片付ける。** 判定の結果も吹き出しで出すので、
    // 残っていると2つ並んでどちらが押した場所のものか分からない。
    // 整備範囲のメッシュは引いた表示で常に出ているぶん、ここに必ず当たる。
    hoverPopup.remove();
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
