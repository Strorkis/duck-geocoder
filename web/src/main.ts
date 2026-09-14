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
 * カタログ (data/output/catalog.json)。
 * Rust側の build_catalog がGeoParquetのメタデータから生成するので、
 * 変換したファイルが増えればUIは自動で追随する。
 *
 * 列と語彙の項目名はSTACに合わせてある (`table:columns` / `table:row_count` は
 * STACのTable拡張、`summaries` はSTAC Collectionの同名フィールド)。
 */
interface CatalogEntry {
  id: string;
  file: string;
  kind: 'admin' | 'admin_names' | 'oaza' | 'block' | 'buildings' | 'plateau_buildings';
  title: string;
  source: string;
  source_url: string;
  geometry_types: string[];
  bbox: [number, number, number, number] | null;
  'table:row_count': number;
  'table:columns': { name: string; type: string }[];
  /**
   * 列がとりうる値。列名 → 値 (件数の多い順)。語彙を持たない列は入っていない。
   *
   * **絞り込みの選択肢はここから作る。** データを走査して作ると、
   * 表示範囲で絞れない (範囲外にしか無い用途を落とすと、その建物が
   * 絞り込みから消える) ため、ファイルの数だけ往復することになる。
   */
  summaries?: Record<string, string[]>;
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

async function fetchCatalog(): Promise<CatalogEntry[]> {
  const response = await fetch(dataUrl('catalog.json'));
  if (!response.ok) {
    throw new Error(
      'catalog.json が読めません。`cargo run --bin build_catalog -- data/output data/output/catalog.json` を実行してください。',
    );
  }
  const catalog = (await response.json()) as { datasets: CatalogEntry[] };
  return catalog.datasets;
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
  /** カタログ上の識別子。 */
  id: string;
  /** UIに出す名前。 */
  label: string;
  /** このデータセットを構成するファイルと、それぞれの収録範囲。 */
  files: { file: string; bbox: Bbox | null }[];
  /** 収録範囲 (ファイル全部の和)。 */
  bbox: Bbox | null;
  /** 高さの列があるか。あれば高さで絞れるし、立体の高さにも使える。 */
  hasHeight: boolean;
  /** 用途・種別を表す列。無ければ null。出所によって列名が違う。 */
  categoryColumn: string | null;
  /** 用途の選択肢 (件数の多い順)。カタログの語彙をそのまま使う。 */
  usages: string[];
  /** 引く前に呼ぶ (空間関数の読み込み)。 */
  ensure: () => Promise<void>;
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
 */
function filesInView(source: BuildingSource, bounds: ViewBounds): string[] {
  const overlapping = source.files.filter(({ bbox }) => {
    // 収録範囲が分からないファイルは落とさない (判断材料が無いので読む)。
    if (!bbox) return true;
    const [west, south, east, north] = bbox;
    return west <= bounds.east && east >= bounds.west && south <= bounds.north && north >= bounds.south;
  });
  return overlapping.map(({ file }) => file);
}

async function initDuckDb(datasets: CatalogEntry[]): Promise<{
  conn: duckdb.AsyncDuckDBConnection;
  /** 建物データの出所。カタログにあるものだけが並ぶ。 */
  buildingSources: BuildingSource[];
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

  const oazaFiles = datasets.filter((d) => d.kind === 'oaza').map((d) => d.file);
  // 行政区域は全国版と都道府県版が同居しうる。範囲の広いもの (=件数が最多) を採用する。
  const adminDataset = datasets
    .filter((d) => d.kind === 'admin')
    .sort((a, b) => b['table:row_count'] - a['table:row_count'])[0];

  if (oazaFiles.length === 0 || !adminDataset) {
    throw new Error('カタログに必要なデータセット (oaza / admin) がありません。');
  }
  // 建物は任意。無ければ建物レイヤーを出さないだけで、他の機能は動く。
  // 出所ごとに列構成が違うので、束ねずに別々のビューにする。
  // 並び順がそのまま選択肢の順になり、先頭が既定になる。
  // 属性が揃っているPLATEAUを先に置く。
  const buildingKinds = [
    { kind: 'plateau_buildings' as const, label: 'PLATEAU' },
    { kind: 'buildings' as const, label: 'Overture' },
  ];
  const buildingFiles = datasets
    .filter((d) => d.kind === 'buildings' || d.kind === 'plateau_buildings')
    .map((d) => d.file);
  // 検索用の名称を抜き出したものがあれば使う。無ければ行政区域から作るが、
  // そちらは名称の列がファイル全体に散らばっているため、HTTP越しだと
  // 往復が積み上がって初期化が数十秒かかる。
  const adminNamesDataset = datasets.find((d) => d.kind === 'admin_names');
  console.info(
    '[catalog] 行政区域:',
    adminDataset.id,
    '/ 名称:',
    adminNamesDataset?.id ?? '(行政区域から都度作成)',
    '/ 地名:',
    oazaFiles.join(', '),
    '/ 建物:',
    buildingFiles.join(', ') || 'なし',
  );

  const registered = [...oazaFiles, ...buildingFiles, adminDataset.file];
  if (adminNamesDataset) registered.push(adminNamesDataset.file);
  for (const file of registered) {
    await db.registerFileURL(
      file,
      dataUrl(file),
      duckdb.DuckDBDataProtocol.HTTP,
      false,
    );
  }

  // ビューを作るだけでもDuckDBはスキーマ検証のためにフッターを読むので、
  // 1ファイルあたり数回の往復が発生する。起動時に要るのは行政区域と名称だけで、
  // 地名は検索時、建物はズームしたときにしか使わないので、そのときまで作らない。
  await conn.query(`CREATE VIEW admin AS SELECT * FROM read_parquet('${adminDataset.file}');`);

  const oazaList = oazaFiles.map((f) => `'${f}'`).join(', ');
  const ensureOaza = once(async () => {
    await conn.query(`CREATE VIEW isj_oaza AS SELECT * FROM read_parquet([${oazaList}]);`);
    // ビューを作るだけではデータを読まないので、検索に使う列に一度触れておく。
    // ここを省くと、読み込みの待ち時間が最初の検索にそのまま乗る。
    await conn.query(`
      SELECT count(pref_name || city_name || oaza_name) FROM isj_oaza;
      SELECT count(pref_name || county_name || city_name || ward_name) FROM admin_names;
    `);
  });

  // **ビューは作らない。** 出所ごとに1つのビューへ束ねると、その時点で
  // ファイルの数だけフッターを読みに行くことになる (1ファイル1往復)。
  // 建物は都市ごとに1ファイルで、PLATEAUを全国に広げると300を超えるので、
  // 引くときに表示範囲と重なるものだけを渡す (`filesInView`)。
  const buildingSources: BuildingSource[] = buildingKinds.flatMap(({ kind, label }) => {
    const entries = datasets.filter((d) => d.kind === kind);
    if (entries.length === 0) return [];
    // 何で絞れるかは列の有無から決める。高さは列があれば絞れる。
    const columns = new Set(entries[0]['table:columns'].map((c) => c.name));
    // 用途で絞れる列は**カタログが語彙を持っている列**。列名 (PLATEAUは usage、
    // Overtureは class) をここに書かないのは、出所が増えたときに書き足す場所が
    // 分かれてしまうため。語彙を出すかどうかはパイプライン側が一箇所で決める。
    //
    // 語彙はファイルごとに入っているので、都市をまたいで束ねる。
    // 先に出た順を保つので、件数の多い用途が上に来る並びのまま残る。
    const vocabularies = new Map<string, Set<string>>();
    for (const entry of entries) {
      for (const [column, values] of Object.entries(entry.summaries ?? {})) {
        const merged = vocabularies.get(column) ?? new Set<string>();
        for (const value of values) merged.add(value);
        vocabularies.set(column, merged);
      }
    }
    const [categoryColumn, usages] = [...vocabularies][0] ?? [null, new Set<string>()];
    return [
      {
        id: entries.map((d) => d.id).join('+'),
        label,
        files: entries.map((d) => ({ file: d.file, bbox: d.bbox })),
        hasHeight: columns.has('height'),
        categoryColumn,
        usages: [...usages],
        bbox: unionBbox(entries.map((d) => d.bbox).filter((b): b is Bbox => b !== null)),
        ensure: ensureSpatial,
      },
    ];
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
    adminNamesDataset
      ? `CREATE VIEW admin_names AS SELECT * FROM read_parquet('${adminNamesDataset.file}');`
      : `CREATE TABLE admin_names AS
           SELECT DISTINCT
             admin_id,
             pref_name,
             coalesce(county_name, '') AS county_name,
             coalesce(city_name, '') AS city_name,
             coalesce(ward_name, '') AS ward_name
           FROM admin;`,
  );

  return { conn, buildingSources, ensureSpatial, ensureOaza };
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
 * 出典表示の高さを測って CSS 変数 `--attribution-height` に入れる。
 *
 * **出典は出所が増えるほど行が増える。** 人口メッシュ (47都道府県) を足したときに
 * 1行から2行になり、全幅40pxに広がって左下の「建物のある範囲へ移動」を覆った
 * (押せなくなった)。パネルの位置を固定値で避けると、出所を足すたびに破れる。
 *
 * 出典そのものは縮めない。表示義務があるので、避けるのはこちらの役目。
 */
function watchAttributionHeight(map: MapLibreMap): void {
  const attribution = map.getContainer().querySelector<HTMLElement>('.maplibregl-ctrl-attrib');
  if (!attribution) return;
  const apply = () => {
    const { height } = attribution.getBoundingClientRect();
    document.documentElement.style.setProperty(
      '--attribution-height',
      `${Math.ceil(height)}px`,
    );
  };
  new ResizeObserver(apply).observe(attribution);
  apply();
}

function initMap(datasets: CatalogEntry[]): Promise<MapLibreMap> {
  // 出典が同じデータセット (位置参照情報の大字・町丁目と街区など) は1つにまとめる。
  // 並べ替えは表示する文言で行う (組み立てたHTMLで並べると、順序がタグの中身に左右される)。
  const credits = new Map(datasets.map((dataset) => [dataset.source, dataset.source_url]));
  const dataCredits = [...credits]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, url]) => creditLink(url, source));

  const map = new MapLibreMap({
    container: 'map',
    style: GSI_STYLE,
    center: [139.767, 35.681],
    zoom: 9,
    // 既定の出典表示を止め、カタログ由来の出典を足したものに差し替える。
    attributionControl: false,
  });
  map.addControl(new AttributionControl({ customAttribution: dataCredits }));
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

  // DuckDB-WASMの初期化とParquetの読み込みには数秒かかるので、
  // 準備が終わるまでは操作できないことが分かるようにしておく。
  loadingMessageEl.textContent = '地図とデータベースを準備中…';
  let conn: duckdb.AsyncDuckDBConnection;
  let map: MapLibreMap;
  let buildingSources: BuildingSource[] = [];
  let ensureSpatial: () => Promise<void>;
  let ensureOaza: () => Promise<void>;
  try {
    const datasets = await fetchCatalog();
    const [db, createdMap] = await Promise.all([initDuckDb(datasets), initMap(datasets)]);
    conn = db.conn;
    buildingSources = db.buildingSources;
    ({ ensureSpatial, ensureOaza } = db);
    map = createdMap;
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
