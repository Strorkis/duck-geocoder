import './style.css';
import * as duckdb from '@duckdb/duckdb-wasm';
import {
  MapLibreMap,
  GeoJSONSource,
  Popup,
  AttributionControl,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * カタログ (data/output/catalog.json)。
 * Rust側の build_catalog がGeoParquetのメタデータから生成するので、
 * 変換したファイルが増えればUIは自動で追随する。
 */
interface CatalogEntry {
  id: string;
  file: string;
  kind: 'admin' | 'oaza' | 'block' | 'buildings';
  title: string;
  source: string;
  geometry_types: string[];
  bbox: [number, number, number, number] | null;
  row_count: number;
  columns: { name: string; data_type: string }[];
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

async function initDuckDb(
  datasets: CatalogEntry[],
): Promise<{ conn: duckdb.AsyncDuckDBConnection; hasBuildings: boolean }> {
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
  // duckdb-wasmはCRSメタデータ付きのGeoParquetをread_parquetすると
  // "stoi: no conversion" でクラッシュすることがある (PROJ初期化のタイミング問題、
  // duckdb/duckdb-wasm#2199)。spatial拡張を明示ロードする"前"に
  // duckdb_coordinate_systems() を一度呼んでおくと回避できる
  // (逆に LOAD spatial の後に呼ぶとクラッシュを再現してしまうので順序に注意)。
  // https://github.com/duckdb/duckdb-wasm/issues/2199#issuecomment-4205882097
  await conn.query(`SELECT * FROM duckdb_coordinate_systems();`);
  await conn.query(`INSTALL spatial; LOAD spatial;`);

  const oazaFiles = datasets.filter((d) => d.kind === 'oaza').map((d) => d.file);
  // 行政区域は全国版と都道府県版が同居しうる。範囲の広いもの (=件数が最多) を採用する。
  const adminDataset = datasets
    .filter((d) => d.kind === 'admin')
    .sort((a, b) => b.row_count - a.row_count)[0];

  if (oazaFiles.length === 0 || !adminDataset) {
    throw new Error('カタログに必要なデータセット (oaza / admin) がありません。');
  }
  // 建物は任意。無ければ建物レイヤーを出さないだけで、他の機能は動く。
  const buildingFiles = datasets.filter((d) => d.kind === 'buildings').map((d) => d.file);
  console.info(
    '[catalog] 行政区域:',
    adminDataset.id,
    '/ 地名:',
    oazaFiles.join(', '),
    '/ 建物:',
    buildingFiles.join(', ') || 'なし',
  );

  for (const file of [...oazaFiles, ...buildingFiles, adminDataset.file]) {
    await db.registerFileURL(
      file,
      dataUrl(file),
      duckdb.DuckDBDataProtocol.HTTP,
      false,
    );
  }

  const oazaList = oazaFiles.map((f) => `'${f}'`).join(', ');
  await conn.query(`CREATE VIEW isj_oaza AS SELECT * FROM read_parquet([${oazaList}]);`);
  await conn.query(`CREATE VIEW admin AS SELECT * FROM read_parquet('${adminDataset.file}');`);

  if (buildingFiles.length > 0) {
    const buildingList = buildingFiles.map((f) => `'${f}'`).join(', ');
    await conn.query(`CREATE VIEW buildings AS SELECT * FROM read_parquet([${buildingList}]);`);
  }

  // 行政区域は1つの自治体が複数のポリゴン行に分かれることがある (飛び地や島など) ので、
  // 検索用に名前と識別子だけを重複排除した小さなテーブルを作っておく。
  // 名前の列だけを読むので、ファイル全体を読み込むわけではない。
  await conn.query(`
    CREATE TABLE admin_names AS
    SELECT DISTINCT
      admin_id,
      pref_name,
      coalesce(county_name, '') AS county_name,
      coalesce(city_name, '') AS city_name,
      coalesce(ward_name, '') AS ward_name
    FROM admin;
  `);

  return { conn, hasBuildings: buildingFiles.length > 0 };
}

/** 建物1件分の表示用データ。 */
interface BuildingFeature {
  geojson: GeoJSON.Geometry;
  name: string | null;
  class: string | null;
  height: number | null;
}

/**
 * 表示範囲に入る建物を取り出す。
 *
 * 逆ジオコーディングと同じく、ジオメトリ本体を評価する前に bbox 列で絞る。
 *
 * 件数が多いと描画が重くなるので上限を設けるが、単に LIMIT で切ると
 * まずい。Overtureのデータは空間的にソートされているため、先頭から N 件を
 * 取ると地図の一部分にだけ固まって「帯状に消える」ように見える。
 * bboxの面積が大きい順に取ることで、間引かれても全体に散らばるようにする。
 */
async function fetchBuildingsInView(
  conn: duckdb.AsyncDuckDBConnection,
  bounds: { west: number; south: number; east: number; north: number },
  limit: number,
): Promise<BuildingFeature[]> {
  const result = await conn.query(`
    SELECT ST_AsGeoJSON(geometry) AS geojson, name, class, height
    FROM buildings
    WHERE bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}
      AND bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}
    ORDER BY (bbox.xmax - bbox.xmin) * (bbox.ymax - bbox.ymin) DESC
    LIMIT ${limit};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      geojson: string;
      name: string | null;
      class: string | null;
      height: number | null;
    };
    return {
      geojson: JSON.parse(r.geojson) as GeoJSON.Geometry,
      name: r.name,
      class: r.class,
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
    SELECT ${oazaExpr} AS label, ST_X(geometry) AS lon, ST_Y(geometry) AS lat
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

// 国土地理院タイル (淡色地図)。利用規約により出典表示 (attribution) が必須。
// https://maps.gsi.go.jp/development/ichiran.html
const GSI_PALE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    gsi: {
      type: 'raster',
      tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 18,
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
    },
  },
  layers: [
    {
      id: 'gsi-pale',
      type: 'raster',
      source: 'gsi',
    },
  ],
};

const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

/**
 * 地図を生成し、スタイルのロードとハイライト用レイヤーの追加が終わるまで待つ。
 *
 * 出典表示はカタログの `source` から組み立てる。どのデータセットを配信するかは
 * カタログ次第なので、ここに書き並べると実際に使っているものとずれる。
 * 表示義務のある出典が抜けるのはライセンス違反になるため、データ側に追随させる。
 */
function initMap(datasets: CatalogEntry[]): Promise<MapLibreMap> {
  const dataCredits = [...new Set(datasets.map((dataset) => dataset.source))].sort();

  const map = new MapLibreMap({
    container: 'map',
    style: GSI_PALE_STYLE,
    center: [139.767, 35.681],
    zoom: 9,
    // 既定の出典表示を止め、カタログ由来の出典を足したものに差し替える。
    attributionControl: false,
  });
  map.addControl(new AttributionControl({ customAttribution: dataCredits }));

  map.on('error', (e) => console.error('[map] error', e.error ?? e));

  return new Promise((resolve) => {
    map.on('load', () => {
      // 建物はハイライトより先に追加して、下に敷く。
      // OvertureのbuildingsはODbL 1.0で、OpenStreetMap由来を含むため
      // 帰属表示が必須。https://docs.overturemaps.org/attribution/
      map.addSource('buildings', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>, ' +
          '<a href="https://overturemaps.org" target="_blank">Overture Maps Foundation</a>',
      });
      map.addLayer({
        id: 'buildings-fill',
        type: 'fill',
        source: 'buildings',
        paint: { 'fill-color': '#4a6785', 'fill-opacity': 0.5 },
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
      resolve(map);
    });
  });
}

async function main() {
  const input = document.querySelector<HTMLInputElement>('#search-input')!;
  const resultsEl = document.querySelector<HTMLUListElement>('#results')!;
  const clearButton = document.querySelector<HTMLButtonElement>('#clear-button')!;
  const loadingEl = document.querySelector<HTMLDivElement>('#loading')!;
  const loadingMessageEl = document.querySelector<HTMLParagraphElement>('#loading-message')!;

  // DuckDB-WASMの初期化とParquetの読み込みには数秒かかるので、
  // 準備が終わるまでは操作できないことが分かるようにしておく。
  loadingMessageEl.textContent = '地図とデータベースを準備中…';
  let conn: duckdb.AsyncDuckDBConnection;
  let map: MapLibreMap;
  let hasBuildings = false;
  try {
    const datasets = await fetchCatalog();
    const [db, createdMap] = await Promise.all([initDuckDb(datasets), initMap(datasets)]);
    conn = db.conn;
    hasBuildings = db.hasBuildings;
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
  input.disabled = false;
  input.focus();

  // MapLibre v6 の setData は Promise を返す (v5までは同期)。await しないと
  // データ適用の完了を待てず、エラーも握り潰されるので必ず待つ。
  const setSourceData = async (sourceId: string, geometry: GeoJSON.Geometry | null) => {
    const source = map.getSource(sourceId) as GeoJSONSource | undefined;
    if (!source) return;
    await source.setData(
      geometry ? { type: 'Feature', properties: {}, geometry } : EMPTY_FEATURE_COLLECTION,
    );
  };

  const clearSearch = () => {
    input.value = '';
    resultsEl.innerHTML = '';
    clearButton.hidden = true;
    Promise.all([setSourceData('highlight', null), setSourceData('selected-point', null)]).catch(
      (e: unknown) => console.error('[clearSearch] failed', e),
    );
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
    const polygon = await fetchAdminPolygon(conn, result.adminId);
    if (!polygon) {
      console.warn('admin polygon not found for admin_id', result.adminId);
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
      searchAddress(conn, keyword)
        .then(renderResults)
        .catch((e: unknown) => console.error('[searchAddress] failed', e));
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

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearSearch();
  });
  clearButton.addEventListener('click', clearSearch);

  // 建物は件数が多いので、ある程度寄ったときだけ表示範囲の分を読み込む。
  const BUILDINGS_MIN_ZOOM = 15;
  const BUILDINGS_LIMIT = 3000;
  let buildingsToken = 0;

  const refreshBuildings = async () => {
    const source = map.getSource('buildings') as GeoJSONSource | undefined;
    if (!source) return;

    if (map.getZoom() < BUILDINGS_MIN_ZOOM) {
      await source.setData(EMPTY_FEATURE_COLLECTION);
      return;
    }

    // 連続して地図を動かすと古い結果が後から届くことがあるので、
    // 最新の要求以外は捨てる。
    const token = ++buildingsToken;
    const b = map.getBounds();
    const rows = await fetchBuildingsInView(
      conn,
      { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
      BUILDINGS_LIMIT,
    );
    if (token !== buildingsToken) return;

    await source.setData({
      type: 'FeatureCollection',
      features: rows.map((row) => ({
        type: 'Feature',
        properties: { name: row.name, class: row.class, height: row.height },
        geometry: row.geojson,
      })),
    });
  };

  if (hasBuildings) {
    map.on('moveend', () => {
      refreshBuildings().catch((e: unknown) => console.error('[buildings] failed', e));
    });
  }

  // 操作の役割分担:
  //   ホバー = 調べる (建物の情報を見るだけ。地図は動かさない)
  //   クリック = 選ぶ (逆ジオコーディングして行政区域をハイライトする)
  // 建物名を見るためにクリックすると行政区域までズームしてしまう、という
  // ちぐはぐさを避けるため分けている。

  // ホバー用。マウスを追うだけなので閉じるボタンは出さない。
  const hoverPopup = new Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 12,
  });

  if (hasBuildings) {
    map.on('mousemove', 'buildings-fill', (e) => {
      const building = e.features?.[0];
      if (!building) return;
      map.getCanvas().style.cursor = 'pointer';

      const props = building.properties;
      const text = [
        (props.name as string | null) ?? '(名称なし)',
        props.class ? `用途: ${props.class as string}` : null,
        props.height ? `高さ: ${props.height as number}m` : null,
      ]
        .filter(Boolean)
        .join('\n');
      hoverPopup.setLngLat(e.lngLat).setText(text).addTo(map);
    });

    map.on('mouseleave', 'buildings-fill', () => {
      map.getCanvas().style.cursor = '';
      hoverPopup.remove();
    });
  }

  // 逆ジオコーディング: クリックした地点がどの行政区域かを引き、
  // その区域をハイライトしてポップアップで名前を出す。
  // ポップアップは1つを使い回す (クリックのたびに増やさない)。
  const popup = new Popup({ closeButton: false });
  map.on('click', (e) => {
    const { lng, lat } = e.lngLat;
    popup.setLngLat(e.lngLat).setText('判定中…').addTo(map);

    reverseGeocode(conn, lng, lat)
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
