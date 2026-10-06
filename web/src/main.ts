import './style.css';
import type * as duckdb from '@duckdb/duckdb-wasm';
import { MapLibreMap, GeoJSONSource, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// 地図タイル (背景地図・地形・外部のベクタータイル) を載せる部品は lib/tiles.ts。
import { basemapLayerId, createVectorOverlay, defaultOf, type VectorOverlay } from './lib/tiles';
// データの出所 (GeoParquet のファイル群) と、表示範囲から読むファイルを選ぶ部品は lib/sources.ts。
import {
  unionBbox,
  type BuildingSource,
  type LineSource,
  type MeshSource,
  type RailwaySource,
  type RoadSource,
  type ViewBounds,
} from './lib/sources';
// DuckDB-WASM の初期化とデータの出所の組み立ては lib/duckdb.ts、
// 表示範囲の問い合わせは lib/queries.ts、検索は lib/search.ts (検索欄は ui/search-box.ts)。
import { initDuckDb } from './lib/duckdb';
import { coverageInView } from './lib/queries';
import { DETAIL_LEVELS, loadDetailLevel, saveDetailLevel, type DetailLevel, type DetailSettings } from './lib/detail';
// 画面の部品は ui/。地図の初期化と描き方は map.ts、左下の一覧とカタログのダイアログは layer-list.ts。
import { EMPTY_FEATURE_COLLECTION, initMap } from './ui/map';
// データの描き方 (建物・人口メッシュ・鉄道・道路・送電線と川) は ui/layers/。
import type { DrawContext } from './ui/layers/context';
import { createBuildingLayers } from './ui/layers/buildings';
import { createMeshLayer } from './ui/layers/mesh';
import { createRailwayLayer } from './ui/layers/railway';
import { createRoadLayer } from './ui/layers/roads';
import { createLineLayers } from './ui/layers/lines';
import { LAYER_ANCHORS, createLayerList, sliderSettings, type Layer, type LayerList } from './ui/layer-list';
import { renderCredits, renderTechCredits, renderTermsSummary } from './ui/credits';
import { createStacViewer } from './ui/stac-viewer';
import { createHover } from './ui/hover';
// 周辺検索のパネルは ui/nearby-panel.ts (問い合わせは lib/nearby.ts)。
import { createNearbyPanel } from './ui/nearby-panel';
import { createCollectionCards } from './ui/collection-card';
import { createSearchBox } from './ui/search-box';
import { createTerrainRow } from './ui/terrain-row';
// MapLibreは既定では new URL(`./${名前}`, import.meta.url) でワーカーを探すが、
// 名前が変数なのでバンドラが静的に検出できず、ビルド成果物に出力されない。
// 結果、本番だけGeoJSONソースが一切描画されなくなる (地図タイルもポップアップも
// 動くので気付きにくい)。?worker&url で Vite にワーカーとしてバンドルさせ、
// 解決済みのURLを setWorkerUrl で明示する。
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(maplibreWorkerUrl);

// カタログ (STAC) を読む部分は lib/stac.ts。画面にも地図にも依存しない。
import {
  dataUrl,
  fetchCollections,
  type Bbox,
  type Collection,
  type DatasetKind,
} from './lib/stac';

/** E2Eテストのために公開するもの。アプリ本体はこれを参照しない。 */
interface TestHooks {
  __map?: MapLibreMap;
  __dataUrl?: (file: string) => string;
}

// データの実際のURLは、テストがデータの有無を確かめるのに要る。
// 初期化に失敗した場合でも参照できるよう、ここで公開しておく
// (データが無くて初期化できないこと自体が、判定したい状態のひとつなので)。
(window as unknown as TestHooks).__dataUrl = dataUrl;

async function main() {
  const input = document.querySelector<HTMLInputElement>('#search-input')!;
  const pickButton = document.querySelector<HTMLButtonElement>('#pick-location')!;
  const nearbyButton = document.querySelector<HTMLButtonElement>('#nearby-button')!;
  const loadingEl = document.querySelector<HTMLDivElement>('#loading')!;
  const loadingMessageEl = document.querySelector<HTMLParagraphElement>('#loading-message')!;
  const busyEl = document.querySelector<HTMLDivElement>('#busy')!;
  const busyLabelEl = document.querySelector<HTMLSpanElement>('#busy-label')!;
  // 絞り込みのパネル。一覧の行の ⚙ で、その行の下へ移す。中身は ui/layers/ が作る。
  const buildingsSection = document.querySelector<HTMLDivElement>('#buildings-section')!;
  const railwaySectionEl = document.querySelector<HTMLDivElement>('#railway-section')!;
  const roadSectionEl = document.querySelector<HTMLDivElement>('#road-section')!;
  const meshSectionEl = document.querySelector<HTMLDivElement>('#mesh-section')!;

  // レイヤーの一覧そのもの (行・カタログから足すダイアログ) は ui/layer-list.ts が持つ。
  /** 「検索できるもの」を開くボタン。裏方が揃ってから出す。中身はダイアログにある。 */
  const layerSupportEl = document.querySelector<HTMLButtonElement>('#layer-support')!;
  const layerSupportRowsEl = document.querySelector<HTMLDivElement>('#layer-support-rows')!;
  /** 「このデータについて」(カタログ・使う条件・取得)。読むものなのでダイアログ。 */
  const layerDetailDialog = document.querySelector<HTMLDialogElement>('#layer-detail-dialog')!;
  const layerDetailTitleEl = document.querySelector<HTMLElement>('#layer-detail-title')!;
  const layerCatalogEl = document.querySelector<HTMLDivElement>('#layer-catalog')!;
  const openStac = createStacViewer(document.querySelector<HTMLDialogElement>('#stac-viewer')!);
  const creditsEl = document.querySelector<HTMLDListElement>('#credits')!;
  // 技術の謝辞はカタログに依らないので、初期化を待たずに出す (失敗しても読める)。
  renderTechCredits(document.querySelector<HTMLDivElement>('#tech-credits')!);

  // ---- 小さい画面 (スマホ) ----------------------------------------------------
  //
  // **一覧は見出しを押すと畳める。** スマホ幅では畳んだ状態で始める (地図を広く見せる)。
  // 右下の「使い方・出典…」は、スマホ幅では検索欄の横の ☰ から開く (画面の下は一覧が使う)。
  const narrowScreen = window.matchMedia('(max-width: 640px)');
  const dataPanelToggle = document.querySelector<HTMLButtonElement>('#data-panel-toggle')!;
  const layerBodyEl = document.querySelector<HTMLDivElement>('#layer-body')!;
  const setDataPanelOpen = (open: boolean) => {
    layerBodyEl.hidden = !open;
    dataPanelToggle.setAttribute('aria-expanded', String(open));
  };
  setDataPanelOpen(!narrowScreen.matches);
  dataPanelToggle.addEventListener('click', () => setDataPanelOpen(layerBodyEl.hidden === true));

  const infoMenuButton = document.querySelector<HTMLButtonElement>('#info-menu-button')!;
  const infoPanelEl = document.querySelector<HTMLDivElement>('#info-panel')!;
  const setInfoMenuOpen = (open: boolean) => {
    infoPanelEl.classList.toggle('open', open);
    infoMenuButton.setAttribute('aria-expanded', String(open));
  };
  infoMenuButton.addEventListener('click', () => setInfoMenuOpen(!infoPanelEl.classList.contains('open')));

  // 出典・使っている技術のダイアログ。右下のパネルは幅が狭く、長い文言が細切れに
  // 折り返して読めないので、押したらダイアログで広く出す。
  for (const button of document.querySelectorAll<HTMLButtonElement>('.info-open')) {
    const dialog = document.getElementById(button.dataset.dialog!) as HTMLDialogElement;
    button.addEventListener('click', () => {
      setInfoMenuOpen(false);
      dialog.showModal();
    });
  }
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('.info-dialog')) {
    dialog.querySelector('.info-dialog-close')!.addEventListener('click', () => dialog.close());
    // 背景を押したら閉じる (中身は内側の要素にあるので、dialog自身が的になるのは背景だけ)。
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  // DuckDB-WASMの初期化とParquetの読み込みには数秒かかるので、
  // 準備が終わるまでは操作できないことが分かるようにしておく。
  loadingMessageEl.textContent = '地図とデータベースを準備中…';
  let conn: duckdb.AsyncDuckDBConnection;
  let exportParquet: (select: string, kv: Record<string, string>) => Promise<Uint8Array>;
  let registerFiles: (files: string[]) => Promise<void>;
  let map: MapLibreMap;
  let buildingSources: BuildingSource[] = [];
  let meshSources: MeshSource[] = [];
  let railwaySources: RailwaySource[] = [];
  let railwayInstitutionTypes: string[] = [];
  let railwayVintage: string | undefined;
  let roadSource: RoadSource | undefined;
  let lineSources: LineSource[] = [];
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
    exportParquet = db.exportParquet;
    registerFiles = db.registerFiles;
    buildingSources = db.buildingSources;
    meshSources = db.meshSources;
    railwaySources = db.railwaySources;
    railwayInstitutionTypes = db.railwayInstitutionTypes;
    railwayVintage = db.railwayVintage;
    roadSource = db.roadSource;
    lineSources = db.lineSources;
    roadClasses = db.roadClasses;
    roadVintage = db.roadVintage;
    ensureRoutes = db.ensureRoutes;
    ({ ensureSpatial, ensureOaza, ensureStations, ensureSections } = db);
    map = createdMap;
    renderCredits(creditsEl, collections);
    renderTermsSummary(document.querySelector<HTMLDivElement>('#terms-summary')!, collections);
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
  nearbyButton.disabled = false;
  input.focus();

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

  // ---- 行の状態 --------------------------------------------------------------
  //
  // 件数や「ズーム15まで寄ると出ます」は**一覧の行に出す**。設定の中に置くと、
  // 開かない限り出ない理由が読めない。
  //
  // **行はCollectionなので、状態もCollection IDで持つ。** 以前は設定パネルの
  // 要約を監視して行へ写していたが、建物がPLATEAUとOvertureの2行になると
  // 要約1つでは足りない。
  /** いまの表示範囲。傾けたときの中心は bounds の中心とずれるので、地図から直接もらう。 */
  const currentBounds = (): ViewBounds => {
    const b = map.getBounds();
    const c = map.getCenter();
    return {
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
      centerLon: c.lng,
      centerLat: c.lat,
    };
  };

  const layerStatus = new Map<string, string>();
  const setLayerStatus = (id: string, text: string) => {
    layerStatus.set(id, text);
    for (const el of document.querySelectorAll<HTMLElement>(`[data-layer-status="${id}"]`)) {
      el.textContent = text;
      // 一覧では1行で切るので、全文は吹き出しで読めるようにする。
      el.title = text;
    }
  };

  /**
   * 表示量。建物・鉄道・道路の上限とズームの閾値がここから決まる。
   *
   * 建物は `buildingsMinZoom` から原寸 (都市ごとのファイル・全件) を読む。
   * **これより引いても隠さない** — 整備範囲をメッシュで出す。
   */
  let detail: DetailSettings = DETAIL_LEVELS[loadDetailLevel()];

  // ---- データの描き方 (ui/layers/) ---------------------------------------------
  //
  // 建物・人口メッシュ・鉄道・道路・送電線と川。どれも「世代を進める → 出していなければ
  // 空に → 表示範囲で引く → 描いて行に状態を書く」の形で、地図を動かすたびに描き直す。
  const drawContext: DrawContext = {
    map,
    conn,
    busy,
    showFailure,
    setStatus: setLayerStatus,
    statusOf: (id) => layerStatus.get(id) ?? '',
    // 一覧の行は下で作る。呼ばれるのは地図を動かしたときや行を出し入れしたとき。
    isVisible: (id) => isLayerVisible(id),
    currentBounds,
    detail: () => detail,
  };
  const buildingLayers = createBuildingLayers(drawContext, buildingSources);
  const requestRefresh = buildingLayers.request;
  const meshLayer = meshSources.length > 0 ? createMeshLayer(drawContext, meshSources) : undefined;
  const requestMeshRefresh = meshLayer?.request ?? (() => {});
  const requestRailwayRefresh =
    railwaySources.length > 0
      ? createRailwayLayer(drawContext, railwaySources, railwayInstitutionTypes)
      : () => {};
  const roadLayer = roadSource ? createRoadLayer(drawContext, roadSource, roadClasses) : undefined;
  const requestRoadRefresh = roadLayer?.request ?? (() => {});
  const lineRequests = createLineLayers(drawContext, lineSources);
  const requestLineRefresh = (source: LineSource) => lineRequests.get(source.id) ?? (() => {});

  // ---- レイヤー一覧 -------------------------------------------------------
  //
  // **カタログの中身を行にする。** 一覧には使うものだけを置き、カタログ全体は
  // 「＋ 追加」のダイアログでサブカタログ (PLATEAU / Overture Maps …) ごとに見せる
  // (並べ方と出し入れは ui/layer-list.ts)。
  //
  // 行とCollectionは**ほぼ1対1**。例外は2つだけ。
  // - 人口メッシュは細かさ違いのCollection (125m / 1km) をズームで選ぶので1行に束ねる
  // - 整備範囲は建物の「引いた姿」なので行にせず、建物の ⚙ の中に出す
  //   (`duck:covers` で結ばれている)

  /**
   * データの既定の重なり (小さいほど上)。足したときにこの順で入る。地図を作るときの
   * 重ね方 (initMap) と同じ — 建物がいちばん上、人口メッシュがいちばん下。
   */
  const DATA_RANKS: Partial<Record<DatasetKind, number>> = {
    plateau_buildings: 0,
    buildings: 0,
    railway_station: 1,
    railway: 2,
    road: 3,
    power_line: 4,
    waterway: 5,
    population_mesh: 6,
  };
  /** 行を描く地図の層。**データの層は地図を作るときに全部ある** (中身が空なだけ)。 */
  const DATA_MAP_LAYERS: Partial<Record<DatasetKind, string[]>> = {
    plateau_buildings: ['buildings-3d', 'buildings-coverage-fill', 'buildings-coverage-outline'],
    buildings: ['buildings-3d', 'buildings-coverage-fill', 'buildings-coverage-outline'],
    railway_station: ['railway-station-casing', 'railway-station'],
    railway: ['railway-line'],
    road: ['road-line'],
    power_line: ['line-power_line'],
    waterway: ['line-waterway'],
    population_mesh: ['population-mesh-fill'],
  };

  /** 一覧。行を全部作ってから作る (下)。それまでの重ね直しは何もしない。 */
  let layerList: LayerList | undefined;
  const applyLayerOrder = () => layerList?.applyOrder();

  const byKind = (kind: DatasetKind) => collections.filter((c) => c.kind === kind);
  const bboxOf = (members: Collection[]) =>
    unionBbox(members.map((c) => c.bbox).filter((b): b is Bbox => b !== null));

  /** 建物の設定パネル (PLATEAU と Overture で共有) をその出所に向ける。 */
  const pointBuildingSettings = buildingLayers.pointSettings;

  /** 外部のベクトルタイル。ホバーで引き当てるために持っておく。 */
  const vectorOverlays: VectorOverlay[] = [];

  // ---- 地図タイル (背景地図・ベクタータイル) と地形 ---------------------------------
  //
  // **QGISと同じく、背景地図も重ねられるレイヤーの1つ。** 一覧に重ね順で並べる
  // (上の行ほど上)。以前は「後から入れたものが上」という規則で重ねていたが、
  // 一覧から順番が見えないので、何が上にあるかが分からなかった。

  /** 地形に使える標高 (Mapterhorn・Re:Earth・地理院…)。**1つだけ**選ぶ。 */
  const terrainCollections: Collection[] = [];

  // **カタログに書かれた順に並べる。** 並びはパイプライン側 (`SUB_CATALOGS`) が決める。
  const layers: Layer[] = [];
  for (const collection of collections) {
    // 既定はデータの行。地図タイルの行は下で区分と描く層を上書きする。
    const dataMapLayers = DATA_MAP_LAYERS[collection.kind] ?? [];
    const base = {
      id: collection.id,
      title: collection.title,
      group: collection.group,
      collections: [collection],
      vintage: collection.vintage,
      bbox: collection.bbox,
      visible: false,
      section: 'data' as const,
      rank: DATA_RANKS[collection.kind] ?? 0,
      mapLayerIds: () => dataMapLayers,
    };
    const tileBase = { ...base, section: 'tile' as const, rank: 0 };
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
          coverage: source.coverage,
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
      case 'power_line':
      case 'waterway': {
        const source = lineSources.find((s) => s.id === collection.id);
        if (!source) break;
        // 絞り込みが無いので、設定の中身は空 (⚙ ではCollectionの中身だけが出る)。
        const settings = document.createElement('div');
        layers.push({ ...base, settings, refresh: requestLineRefresh(source) });
        break;
      }
      case 'raster_tiles': {
        if (!collection.tileLink) break;
        const id = basemapLayerId(collection);
        const first = defaultOf(collections, 'raster_tiles');
        layers.push({
          ...tileBase,
          // **先頭の背景地図 (淡色地図) だけ既定で出す** (スタイルを組むときと同じ規則)。
          visible: collection === first,
          // 何のソースかを行で言う (出所の名前は一覧が前に足す)。
          vintage: `地図タイル (XYZ) · ズーム${collection.zoom?.join('〜') ?? ''}`,
          settings: sliderSettings('不透明度', 0, 100, 5, 100, (v) => `${v}%`, (v) =>
            map.setPaintProperty(id, 'raster-opacity', v / 100),
          ),
          refresh: () => {
            map.setLayoutProperty(id, 'visibility', isLayerVisible(collection.id) ? 'visible' : 'none');
          },
          mapLayerIds: () => [id],
        });
        break;
      }
      case 'terrain':
        // 地形は**1つだけ**選ぶ (MapLibre は地形を1つしか持てない)。行ではなく、
        // 地図タイルの区分の「地形」の欄で、出すかとどの標高かを選ぶ。
        if (collection.tileLink) terrainCollections.push(collection);
        break;
      case '3d_tiles':
        // **この地図では描けない** (MapLibre は 3D Tiles を描かない)。それでも、カタログに
        // 何があるかは見せる — 足すダイアログに出して足せなくし、ⓘ からビューアへ案内する。
        layers.push({
          ...tileBase,
          vintage: '3D Tiles',
          settings: document.createElement('div'),
          refresh: () => {},
          mapLayerIds: () => [],
          viewOnly: 'この地図では描けません (3D Tiles)。ⓘ から公式のビューアで見られます',
        });
        break;
      case 'reference':
        // **配っていない元データ** (公開元を指すだけ)。3D Tiles と同じく、カタログにあることは
        // 見せて足せなくする。ⓘ から配布元 (と公開元の STAC) へ辿れる。
        layers.push({
          ...tileBase,
          vintage: '元データ',
          settings: document.createElement('div'),
          refresh: () => {},
          mapLayerIds: () => [],
          viewOnly: 'このカタログからは配っていません。ⓘ から公開元へ辿れます',
        });
        break;
      case 'vector_tiles': {
        // **テーマごとに1行。** 層はテーマの中に入れ、行を開くと出てくる。
        // うちのデータより下 (地図タイルの目印の直下) に敷く。
        const overlay = createVectorOverlay(map, collection, LAYER_ANCHORS.tile);
        vectorOverlays.push(overlay);
        const settings = document.createElement('div');
        for (const theme of collection.themes ?? []) {
          // 行ID。`:` を使わない (CSSのセレクタで要素IDとして引けなくなる)。
          const rowId = `${collection.id}--${theme.id}`;
          layers.push({
            ...tileBase,
            id: rowId,
            title: theme.title,
            // 出所が同じでも、どのタイルセットの層かを版と一緒に添える。
            vintage: [collection.title, collection.vintage].filter(Boolean).join(' · '),
            settings,
            refresh: () => {
              overlay
                .apply()
                // 層は初めて出すときに作るので、作ったら重ね順を当て直す。
                .then(applyLayerOrder)
                .catch((e: unknown) => {
                  console.error('[vector] apply failed', e);
                  setLayerStatus(rowId, '読めませんでした');
                });
            },
            parts: { overlay, layers: theme.layers },
            mapLayerIds: () => overlay.layerIds(theme.layers.map((l) => l.id)),
          });
        }
        break;
      }
      default:
        // 検索の裏方と整備範囲は行にしない (「検索できるもの」と建物の ⚙ に出る)。
        break;
    }
  }

  const isLayerVisible = (id: string) => layers.find((l) => l.id === id)?.visible ?? false;

  /** 「このデータについて」を開く。中身は開くたびにカタログから作る。 */
  const openLayerDetails = (layer: Layer) => {
    layerDetailTitleEl.textContent = layer.group ? `${layer.group.title} › ${layer.title}` : layer.title;
    layerCatalogEl.replaceChildren(...layer.collections.map(collectionCard));
    layerDetailDialog.showModal();
  };

  // ⓘ のカード (このデータについて・この範囲を取得) は ui/collection-card.ts。
  const cards = createCollectionCards({
    collections,
    conn,
    ensureSpatial,
    registerFiles,
    exportParquet,
    currentBounds,
    openStac,
    showCollection: (target) => {
      layerDetailTitleEl.textContent = `${target.group?.title ?? ''} › ${target.title}`;
      layerCatalogEl.replaceChildren(cards.card(target));
    },
  });
  const collectionCard = cards.card;
  const jsonLink = cards.jsonLink;

  /** 表示範囲と収録範囲が重なるか。**通信しない** (起動時に読んだbboxだけを見る)。 */
  const coversView = (bbox: Bbox | null): boolean => {
    if (!bbox) return true; // 分からないものは落とさない
    const b = map.getBounds();
    const [west, south, east, north] = bbox;
    return (
      west <= b.getEast() && east >= b.getWest() && south <= b.getNorth() && north >= b.getSouth()
    );
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

  // 地形の行 (ui/terrain-row.ts)。標高を1つ選び、地図右上の地形ボタンと追随する。
  createTerrainRow({
    map,
    collections: terrainCollections,
    openDetails: (collection) => {
      layerDetailTitleEl.textContent = `地形 › ${collection.group?.title ?? ''} › ${collection.title}`;
      layerCatalogEl.replaceChildren(collectionCard(collection));
      layerDetailDialog.showModal();
    },
  });

  /**
   * 「検索できるもの」の1行。**何を打てばよいか** (項目名と例) を主にし、
   * どのデータから引いているか (出所の名前) は小さく添えるだけにする。
   * 検索の裏方は**切れてはいけない**ので、チェックは出さない。
   */
  const searchItem = (title: string, example: string, source: string): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'search-item';
    const name = document.createElement('span');
    name.className = 'search-item-name';
    name.textContent = title;
    const exampleEl = document.createElement('span');
    exampleEl.className = 'search-item-example';
    exampleEl.textContent = `例: ${example}`;
    const sourceEl = document.createElement('span');
    sourceEl.className = 'search-item-source';
    sourceEl.textContent = source;
    row.append(name, exampleEl, sourceEl);
    return row;
  };

  /**
   * 整備範囲で確かめた「この範囲にあるか」。行ID → 答え。
   *
   * **表示範囲が変わっても消さず、新しい答えが来たら上書きする。** 消すと
   * 答えが来るまでの間は箱で判定することになり、山の中でPLATEAUが
   * 「ある」→「無い」と動かすたびにちらつく。少し動かしただけなら、
   * 前の答えはたいてい正しい。
   */
  const presence = new Map<string, boolean>();
  let presenceToken = 0;

  /**
   * 箱 (Collectionの収録範囲) の外なら確実に無い。箱の内側なら、整備範囲の
   * 答えがあればそれに従う。**箱だけだと粗い** — PLATEAUは306都市の和が
   * 日本をほぼ覆うので、箱だけでは山の中でも「ある」と出る。
   */
  const isPresent = (layer: Layer) => coversView(layer.bbox) && (presence.get(layer.id) ?? true);

  // **一覧を作る。** 覚えている一覧があればそれを戻す (その行の描き直しもここで走る)。
  layerList = createLayerList({
    map,
    layers,
    statusOf: (id) => layerStatus.get(id) ?? '',
    isPresent,
    openDetails: openLayerDetails,
    catalogLink: jsonLink,
  });
  const renderLayerList = () => layerList?.render();

  /** 整備範囲を持つ行について、表示範囲にセルがあるかを聞き直す。 */
  const refreshPresence = async () => {
    const token = ++presenceToken;
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
    for (const layer of layers) {
      // 箱の外なら聞くまでもない。**読みに行かない。**
      if (!layer.coverage || !coversView(layer.bbox)) continue;
      await layer.coverage.ensure();
      const inView = await coverageInView(conn, layer.coverage, bounds);
      // 答えを待つ間に地図が動いていたら捨てる (次の問い合わせが上書きする)。
      if (token !== presenceToken) return;
      presence.set(layer.id, inView);
    }
    renderLayerList();
  };

  const requestPresence = () => {
    refreshPresence().catch((e: unknown) => {
      // 判定が失敗しても一覧は箱で出ている。**描画は止めない。**
      console.error('[layers] presence failed', e);
    });
  };

  // 人口メッシュと道路はパネルと行が1対1なので、パネルの要約をそのまま写す。
  if (meshSources[0] && meshLayer) mirrorStatus(meshSources[0].id, meshLayer.summary);
  if (roadSource && roadLayer) mirrorStatus(roadSource.id, roadLayer.summary);

  if (layers.length > 0) {
    // **まず箱で描き、整備範囲の答えが来たら描き直す。** `moveend` ごとに走るので、
    // 答えを待たせて一覧が空になる時間を作らない。
    renderLayerList();
    requestPresence();
    map.on('moveend', () => {
      renderLayerList();
      requestPresence();
    });
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

  // 「検索できるもの」は種別から引く (そのデータが配信されていれば出す)。
  // **打つ言葉で書く。** データセット名 (「位置参照情報」) では、何を打てば当たるのかが分からない。
  // 街区 (〜番) は検索には使っていないので載せない (以前は載せていた)。
  const searchKinds: [DatasetKind, string, string][] = [
    ['admin', '市区町村', '港区、札幌市'],
    ['oaza', '町名・丁目', '六本木、銀座四丁目'],
    ['railway_station', '駅', '東京駅、新宿'],
    ['railway_station', '鉄道の路線', '山手線'],
    ['road_route', '道路の路線', '国道13号'],
  ];
  const supportRows = searchKinds.flatMap(([kind, title, example]) => {
    const collection = byKind(kind)[0];
    return collection ? [searchItem(title, example, collection.group?.title ?? collection.provider ?? '')] : [];
  });
  if (supportRows.length > 0) {
    layerSupportRowsEl.replaceChildren(...supportRows);
    layerSupportEl.hidden = false;
  }

  // 整備範囲は建物の描き直しが出すが、その呼び出しは moveend でしか起きない。
  // 起動直後にも一度呼んでおかないと、地図を動かすまで出ない。
  if (buildingSources.length > 0) requestRefresh();

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
  /** 吹き出しの出る地物の上にいるか (ポインタの形を変える)。 */
  let hoveringFeature = false;
  const updateCursor = () => {
    map.getCanvas().style.cursor =
      picking || nearby.choosing() ? 'crosshair' : hoveringFeature ? 'pointer' : '';
  };

  // 📍と◎は**どちらか一方だけ**。両方が待ち受けていると、1回のクリックで
  // 判定と周辺検索が同時に走って、どちらの結果か分からなくなる。
  const setPicking = (on: boolean) => {
    picking = on;
    pickButton.setAttribute('aria-pressed', String(on));
    if (on && nearby.choosing()) nearby.setChoosing(false);
    updateCursor();
  };
  pickButton.addEventListener('click', () => setPicking(!picking));

  // ---- 周辺検索 (ui/nearby-panel.ts) ---------------------------------------------
  //
  // **吹き出し (下の createHover) より先に作る。** 起点を選ぶクリックは周辺検索の側が
  // 先に受け取って印を付ける (`preventDefault`) ので、吹き出しは出さない。
  const nearby = createNearbyPanel({
    map,
    conn,
    collections,
    sources: {
      buildings: buildingSources,
      railways: railwaySources,
      road: roadSource,
      lines: lineSources,
      meshes: meshSources,
    },
    busy,
    ensureSpatial,
    setSourceData,
    currentBounds,
    onChoosingChange: (on) => {
      if (on && picking) setPicking(false);
      updateCursor();
    },
  });

  // 検索欄 (ui/search-box.ts)。選んだものは周辺検索の起点として覚える。
  const search = createSearchBox({
    map,
    conn,
    busy,
    showFailure,
    setSourceData,
    ensureOaza,
    ensureSpatial,
    ensureStations,
    ensureSections,
    ensureRoutes,
    onSelect: nearby.remember,
  });

  // Escの出口を1本にまとめる。押している最中なら解除が先、そうでなければ
  // 出ている結果を消す。window で拾うのは、判定した直後はフォーカスが地図側にあり、
  // 検索欄に付けていると効かないため。
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // ダイアログを開いているなら、Esc はダイアログを閉じるだけ (地図の結果は消さない)。
    if (document.querySelector('dialog[open]')) return;
    if (picking) {
      setPicking(false);
      return;
    }
    if (nearby.choosing()) {
      nearby.setChoosing(false);
      return;
    }
    // 周辺検索の結果を出していれば、それを先に閉じる (× を探させない)。
    if (nearby.isOpen()) {
      nearby.clear();
      return;
    }
    search.clear();
  });

  // 吹き出し (ホバーと、指で押したとき) は ui/hover.ts。**周辺検索の click より後に作る**
  // (起点を選んだクリックは、周辺検索の側が先に受け取って印を付ける)。
  const hover = createHover({
    map,
    collections,
    vectorOverlays,
    railwayVintage,
    roadVintage,
    nearbyDistance: nearby.distance,
    picking: () => picking,
    choosingOrigin: nearby.choosing,
    onHovering: (on) => {
      hoveringFeature = on;
      updateCursor();
    },
  });

  // 📍のあとのクリック: その地点がどの行政区域かを引いて、検索の結果と同じく出す。
  map.on('click', (e) => {
    if (!picking) return;
    // 1クリックで解除する。押しっぱなしのモードにすると、今どちらの状態かを
    // 覚えていないと次のクリックの結果が読めなくなる。
    setPicking(false);
    // **ホバーの吹き出しを先に片付ける。** 判定の結果も吹き出しで出すので、
    // 残っていると2つ並んでどちらが押した場所のものか分からない。
    // 整備範囲のメッシュは引いた表示で常に出ているぶん、ここに必ず当たる。
    hover.hide();
    search.pickAt(e.lngLat);
  });
}

void main();
