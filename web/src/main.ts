import './style.css';
import type * as duckdb from '@duckdb/duckdb-wasm';
import {
  MapLibreMap,
  GeoJSONSource,
  Popup,
  AttributionControl,
  NavigationControl,
  TerrainControl,
  setWorkerUrl,
  type ExpressionSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// 地図タイル (背景地図・地形・外部のベクタータイル) を載せる部品は lib/tiles.ts。
import {
  DEM_ENCODING_LABELS,
  DEM_VERTICAL_LABELS,
  GEOMETRY_LABELS,
  TERRAIN_SOURCE,
  baseStyle,
  basemapLayerId,
  createVectorOverlay,
  defaultOf,
  terrainSource,
  type VectorOverlay,
} from './lib/tiles';
// データの出所 (GeoParquet のファイル群) と、表示範囲から読むファイルを選ぶ部品は lib/sources.ts。
import {
  COARSE_LOD,
  EXACT_LOD,
  LINE_KINDS,
  bboxOverlaps,
  geometryBbox,
  lodForZoom,
  lodNote,
  meshSourceFor,
  sourceLodNote,
  unionBbox,
  type BuildingSource,
  type LineKind,
  type LineSource,
  type MeshSource,
  type RailwaySource,
  type RoadSource,
  type ViewBounds,
} from './lib/sources';
// 周辺検索の問い合わせは lib/nearby.ts。
import {
  NEARBY_DRAW_LIMIT,
  fetchNearbyBuildings,
  fetchNearbyNames,
  fetchNearbyPopulation,
  fromMeters,
  nearbyFrame,
  type NearbyBuildings,
  type NearbyFrame,
  type NearbyOrigin,
} from './lib/nearby';
// DuckDB-WASM の初期化とデータの出所の組み立ては lib/duckdb.ts、
// 表示範囲の問い合わせは lib/queries.ts、検索は lib/search.ts、地域メッシュは lib/mesh.ts。
import { initDuckDb } from './lib/duckdb';
import {
  coverageFeatureCollection,
  coverageInView,
  fetchBuildingsInView,
  fetchCoverageInView,
  fetchLinesInView,
  fetchMeshInView,
  fetchRailwayInView,
  fetchRoadsInView,
  type BuildingFilter,
  type RailwayFeature,
} from './lib/queries';
import {
  MAX_RESULTS,
  ROUTE_SUGGESTIONS,
  fetchAdminPolygon,
  fetchLineGeometry,
  fetchRouteGeometry,
  reverseGeocode,
  searchAddress,
  searchLines,
  searchRoutes,
  searchStations,
  toMultiLineString,
  type SearchResult,
} from './lib/search';
import { MESH_SIZE_LABELS, meshBounds, meshCodesInView, meshDigits } from './lib/mesh';
import { CITYGML_TYPES, fetchCityGmlFiles, packCityGml, type CityGmlFile } from './lib/plateau-api';
// 画面の部品は ui/。左下の一覧 (使うものだけを置く) と、カタログから足すダイアログは layer-list.ts。
import { LAYER_ANCHORS, createLayerList, type Layer, type LayerList } from './ui/layer-list';
import {
  buildDataCredits,
  collapseAttribution,
  externalLink,
  renderCredits,
  renderTechCredits,
  renderTermsSummary,
  termsBadges,
  watchAttributionHeight,
} from './ui/credits';
import { createStacViewer } from './ui/stac-viewer';
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
  itemFile,
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

/** 線の見せ方。川は水色の実線、送電線は紫の破線 (道路・鉄道と見分けるため)。 */
const LINE_STYLES: Record<LineKind, { color: string; width: number; dash: number[] | null }> = {
  power_line: { color: '#7b4fa0', width: 1.6, dash: [2, 1.5] },
  waterway: { color: '#3a8fd6', width: 1.8, dash: null },
};

/** 線の種別 (`class`) の呼び名。Overture の値はOSM由来の英語なので言い直す。 */
const LINE_CLASS_LABELS: Record<string, string> = {
  power_line: '送電線',
  cable: '地中・海底線',
  river: '川',
  canal: '運河',
};

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
 * 多めは建物を1ズーム早く、道路の等級を2ズーム早く、鉄道と道路の上限を2倍。
 * 控えめはその逆。**建物のズームを1より大きく動かさない** —
 * 14で原寸の1画面は15の4倍の面積で、ズーム13の東京駅は21万棟 (実測) ある。
 *
 * **多めの建物の上限は4万。** ズーム14の東京駅は1280×720の画面で3.7万棟あり、
 * 6,000では中心の2割弱しか出なかった。上限は**転送量を減らさない** —
 * 中心から近い順に並べてから切るので、並べるために画面内を全部読む
 * (実測: 上限6,000でも6万でも37.5MB)。6万で37,178棟を描いても5.6秒で、
 * 6,000件のとき (7.0秒) と変わらなかった。1920×1080だと11.9万棟あるが、
 * そこまで描くのは測っていないので上げない。
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
    buildingsLimit: 40000,
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

/** バイト列をファイルとして保存させる。 */
function saveBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.apache.parquet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** バイト数を読みやすく。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 建物の塗り (既定)。**高さで塗り分ける。** 傾けずに見るときも高さが分かるようにするため。
 * 高さを持たないデータ (Overtureはほぼ全件がそう) では既定色のままになる。
 *
 * **出所で色相を分ける。** PLATEAUとOvertureは同時に出せるので、
 * 重なったところでどちらの建物かが見分けられないと困る。
 * カタログで先頭の出所 (`palette` 0) が青、それ以外が橙。
 */
const BUILDING_COLOR_BY_HEIGHT: ExpressionSpecification = [
  'match',
  ['get', 'palette'],
  0,
  [
    'case',
    ['==', ['get', 'height'], null],
    '#4a6785',
    ['interpolate', ['linear'], ['get', 'height'], 0, '#c6d4e4', 20, '#8fabc9', 60, '#4a6785', 150, '#2d3f52'],
  ],
  [
    'case',
    ['==', ['get', 'height'], null],
    '#c77d3a',
    ['interpolate', ['linear'], ['get', 'height'], 0, '#f0cfa8', 20, '#e0a669', 60, '#c77d3a', 150, '#8a4f1c'],
  ],
];

/**
 * 建物の塗り (重要度で色分けするとき)。**重要な段ほど目立たせ、住宅・その他は退かせる。**
 *
 * 出所の色相 (青・橙) より段を優先する。重要なものを探すときは、どちらの出所かより
 * どの段かが知りたい (出所はホバーで分かる)。段の無い出所 (`tierRank` -1) は
 * 高さの塗りに落とす。
 */
const BUILDING_COLOR_BY_TIER: ExpressionSpecification = [
  'match',
  ['get', 'tierRank'],
  0,
  '#c0392b',
  1,
  '#e09a3e',
  2,
  '#d5d9de',
  BUILDING_COLOR_BY_HEIGHT,
];

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
function initMap(collections: Collection[]): Promise<MapLibreMap> {
  const map = new MapLibreMap({
    container: 'map',
    style: baseStyle(collections),
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
  // 一覧の「標高 (地形)」の行と同じもの (どちらで切っても、もう一方が追随する)。
  // 地図の上ですぐ切れるので残す。地形がカタログに無ければ出さない。
  const hasTerrain = collections.some((c) => c.kind === 'terrain' && c.tileLink);
  if (hasTerrain) map.addControl(new TerrainControl({ source: TERRAIN_SOURCE }), 'top-right');

  map.on('error', (e) => console.error('[map] error', e.error ?? e));

  return new Promise((resolve) => {
    map.on('load', () => {
      // **重ね順の目印** (描かない)。地図タイルは `anchor/tiles` の直下、データは
      // `anchor/data` の直下に、一覧の順で積む (ui/layer-list.ts の applyOrder)。
      // 目印の間に置くので、データは地図タイルより常に上、周辺検索とハイライトより下。
      const anchor = (id: string) =>
        map.addLayer({ id, type: 'background', layout: { visibility: 'none' } });
      anchor(LAYER_ANCHORS.tile);

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
      // 送電線・川。道路の下に敷く (道路の方が細かく読まれるため)。
      // 種別ごとに1組。見せ方は `LINE_STYLES` (川は実線、送電線は破線)。
      for (const kind of LINE_KINDS) {
        const style = LINE_STYLES[kind];
        map.addSource(`line-${kind}`, { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
        map.addLayer({
          id: `line-${kind}`,
          type: 'line',
          source: `line-${kind}`,
          paint: {
            'line-color': style.color,
            'line-width': ['interpolate', ['linear'], ['zoom'], 6, style.width * 0.6, 14, style.width * 1.6],
            'line-opacity': 0.85,
            ...(style.dash ? { 'line-dasharray': style.dash } : {}),
          },
          layout: { 'line-cap': 'round', 'line-join': 'round' },
        });
      }

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
          // 既定は高さで塗る。「重要度で色分けする」を入れると段で塗る
          // (`BUILDING_COLOR_BY_TIER` に差し替える)。
          'fill-extrusion-color': BUILDING_COLOR_BY_HEIGHT,
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

      // 建物の整備範囲。引くと建物そのものは消えるので、どこにデータがあるかを
      // 1kmのメッシュで示す。偶然その場所へ行かないと機能に気づけない、という状態を避ける。
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
            'interpolate',
            ['linear'],
            ['get', 'ratio'],
            0,
            0.12,
            0.05,
            0.18,
            0.25,
            0.26,
            1,
            0.36,
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
          // 縁は薄く。3万セルの縁を濃く引くと網目が潰れて塗りが読めない。
          'line-opacity': 0.3,
        },
      });
      anchor(LAYER_ANCHORS.data);

      // 周辺検索の範囲 (起点から○m) と、範囲に入った建物。ハイライトの下に敷く。
      map.addSource('nearby-zone', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
      map.addLayer({
        id: 'nearby-zone-fill',
        type: 'fill',
        source: 'nearby-zone',
        // 範囲は**はっきり見える**ように。結果を目立たせるときは周りを薄くするので、
        // 範囲の縁が「どこまで調べたか」の唯一の手がかりになる。
        paint: { 'fill-color': '#ff6600', 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'nearby-zone-line',
        type: 'line',
        source: 'nearby-zone',
        paint: { 'line-color': '#ff6600', 'line-width': 3, 'line-dasharray': [4, 1] },
      });
      map.addSource('nearby-hits', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
      map.addLayer({
        id: 'nearby-hits',
        // **立体で描く。** 地面に塗るだけだと、立体の建物 (薄くしても) の中に埋もれて
        // 見えなかった。元の建物より少しだけ高くして、重なった面がちらつかないようにする。
        type: 'fill-extrusion',
        source: 'nearby-hits',
        // 重要度で色分けと同じ色。段の無い出所は橙。
        paint: {
          'fill-extrusion-color': [
            'match',
            ['get', 'tierRank'],
            0,
            '#c0392b',
            1,
            '#e09a3e',
            2,
            '#8a94a0',
            '#ff6600',
          ],
          'fill-extrusion-height': ['+', ['coalesce', ['get', 'height'], 3], 0.5],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.95,
        },
      });
      // 範囲に入った線 (駅・鉄道・道路・送電線・川)。種類ごとの色は一覧の線と揃える。
      map.addSource('nearby-hit-lines', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
      map.addLayer({
        id: 'nearby-hit-lines',
        type: 'line',
        source: 'nearby-hit-lines',
        paint: {
          'line-color': [
            'match',
            ['get', 'kind'],
            '駅',
            '#8e1b1b',
            '鉄道',
            '#444444',
            '道路',
            '#d9822b',
            '送電線',
            '#d19a00',
            '川',
            '#2f6fd1',
            '#ff6600',
          ],
          'line-width': ['match', ['get', 'kind'], '駅', 6, 3],
          'line-opacity': 0.9,
        },
      });
      // **起点** (押したもの)。結果より上に、太く縁取って描く。何を起点にしたかが一目で分かるように。
      map.addSource('nearby-origin', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
      // 起点が建物 (面) なら**青い立体**で。地面に枠を引くと、立体表示では建物の足元に
      // 線が出るだけで、どの建物かが分かりにくかった。
      map.addLayer({
        id: 'nearby-origin-fill',
        type: 'fill-extrusion',
        source: 'nearby-origin',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-extrusion-color': '#1f3a93',
          'fill-extrusion-height': ['+', ['coalesce', ['get', 'height'], 3], 1],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.95,
        },
      });
      // 線 (鉄道・川など) は白い縁取りの太線で。面には引かない (上の立体で示す)。
      map.addLayer({
        id: 'nearby-origin-casing',
        type: 'line',
        source: 'nearby-origin',
        filter: ['!=', ['geometry-type'], 'Polygon'],
        paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'nearby-origin-line',
        type: 'line',
        source: 'nearby-origin',
        filter: ['!=', ['geometry-type'], 'Polygon'],
        paint: { 'line-color': '#1f3a93', 'line-width': 4 },
      });
      map.addLayer({
        id: 'nearby-origin-point',
        type: 'circle',
        source: 'nearby-origin',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 8,
          'circle-color': '#1f3a93',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3,
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
      if (hasTerrain) map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: 1 });
      resolve(map);
    });
  });
}

async function main() {
  const input = document.querySelector<HTMLInputElement>('#search-input')!;
  const resultsEl = document.querySelector<HTMLUListElement>('#results')!;
  const clearButton = document.querySelector<HTMLButtonElement>('#clear-button')!;
  const pickButton = document.querySelector<HTMLButtonElement>('#pick-location')!;
  const nearbyButton = document.querySelector<HTMLButtonElement>('#nearby-button')!;
  const nearbyPanel = document.querySelector<HTMLDivElement>('#nearby-panel')!;
  const nearbyDistance = document.querySelector<HTMLSelectElement>('#nearby-distance')!;
  const nearbyOriginEl = document.querySelector<HTMLParagraphElement>('#nearby-origin')!;
  const nearbyResultsEl = document.querySelector<HTMLDivElement>('#nearby-results')!;
  const nearbyFromSearch = document.querySelector<HTMLButtonElement>('#nearby-from-search')!;
  const loadingEl = document.querySelector<HTMLDivElement>('#loading')!;
  const loadingMessageEl = document.querySelector<HTMLParagraphElement>('#loading-message')!;
  const busyEl = document.querySelector<HTMLDivElement>('#busy')!;
  const busyLabelEl = document.querySelector<HTMLSpanElement>('#busy-label')!;
  const buildingsSection = document.querySelector<HTMLDivElement>('#buildings-section')!;
  const filtersEl = document.querySelector<HTMLDivElement>('#building-filters')!;
  const heightField = document.querySelector<HTMLDivElement>('#height-field')!;
  const usageField = document.querySelector<HTMLDivElement>('#usage-field')!;
  const minHeightInput = document.querySelector<HTMLInputElement>('#min-height')!;
  const minHeightValue = document.querySelector<HTMLOutputElement>('#min-height-value')!;
  const usageOptionsEl = document.querySelector<HTMLDivElement>('#usage-options')!;
  const tierField = document.querySelector<HTMLDivElement>('#tier-field')!;
  const tierOptionsEl = document.querySelector<HTMLDivElement>('#tier-options')!;
  const tierColorToggle = document.querySelector<HTMLInputElement>('#tier-color')!;
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

  // レイヤーの一覧そのもの (行・カタログから足すダイアログ) は ui/layer-list.ts が持つ。
  /** 「検索できるもの」を開くボタン。裏方が揃ってから出す。中身はダイアログにある。 */
  const layerSupportEl = document.querySelector<HTMLButtonElement>('#layer-support')!;
  const layerSupportRowsEl = document.querySelector<HTMLDivElement>('#layer-support-rows')!;
  /** 「このデータについて」(カタログ・使う条件・取得)。読むものなのでダイアログ。 */
  const layerDetailDialog = document.querySelector<HTMLDialogElement>('#layer-detail-dialog')!;
  const layerDetailTitleEl = document.querySelector<HTMLElement>('#layer-detail-title')!;
  const layerCatalogEl = document.querySelector<HTMLDivElement>('#layer-catalog')!;
  const openStac = createStacViewer(document.querySelector<HTMLDialogElement>('#stac-viewer')!);
  const aircraftSelect = document.querySelector<HTMLSelectElement>('#aircraft-class')!;
  const meshLegendBody = document.querySelector<HTMLTableSectionElement>('#mesh-legend tbody')!;
  const meshSummaryEl = document.querySelector<HTMLParagraphElement>('#mesh-summary')!;
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
          const geometry = toMultiLineString(parts);
          await setSourceData('highlight', geometry);
          if (geometry) rememberSelection(result.label, geometry);
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
          const geometry = toMultiLineString(parts);
          await setSourceData('highlight', geometry);
          if (geometry) rememberSelection(result.label, geometry);
        });
      }
      fitToBbox(result.bbox);
      return;
    }

    // 地名(代表点しか無い)と駅はその地点へ飛ぶ。ポリゴンは消す。
    if (result.kind === 'oaza' || result.kind === 'station') {
      const point: GeoJSON.Point = { type: 'Point', coordinates: [result.lon, result.lat] };
      await Promise.all([setSourceData('highlight', null), setSourceData('selected-point', point)]);
      rememberSelection(result.label, point);
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
    rememberSelection(result.label, polygon.geojson);
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
          ensureRoutes
            ? searchRoutes(conn, keyword, (cls) => ROAD_STYLES[cls]?.label ?? cls)
            : Promise.resolve([]),
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
    buildingSources.map((source) => [source.id, { minHeight: 0, usages: null, tiers: null }]),
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
    // **世代は最初に進める。** 全部外したときの早期 return の前でないと、読み込み中だった
    // 前の要求が「まだ最新」のまま終わり、外したあとに建物を描いてしまう (実際に起きた)。
    const token = ++buildingsToken;

    const visible = buildingSources.filter((source) => isLayerVisible(source.id));
    // 取得を始める前に件数表示を空にする。引いていたときの「拡大すると建物が出ます」が
    // 残っていると、すでに寄っている利用者に拡大しろと言い続けることになる。
    for (const source of buildingSources) showBuildingStatus(source, '');

    if (visible.length === 0) {
      await coverage?.setData(EMPTY_FEATURE_COLLECTION);
      await mapSource.setData(EMPTY_FEATURE_COLLECTION);
      return;
    }

    const zoom = map.getZoom();
    const bounds = currentBounds();

    // 状態は最後にまとめて出す。途中で打ち切ったとき (地図が動いた) に
    // 片方の出所だけ新しい件数が出る、という食い違いを作らない。
    const statuses: [BuildingSource, string][] = [];

    // **出所ごとに、このズームでどこまで出すかを決める** ([`buildingDepth`])。
    // 全部 / 重要な段だけ (間引き) / 整備範囲のメッシュ、の3通り。
    const depths = new Map(visible.map((source) => [source, buildingDepth(source, zoom)]));

    // **引いた表示では整備範囲を出す** (段で間引いても出せないほど引いたとき)。
    // 建物そのものは、簡略化はフットプリントが1px未満で効かず、高さで選ぶのは
    // 基準に意味を持たせられなかった。代わりに「どこまで整備されているか」を出す。
    const coverageFeatures: GeoJSON.Feature[] = [];
    for (const source of visible) {
      if (depths.get(source) !== null) continue;
      if (!source.coverage) {
        // 整備範囲を持たない出所は、引いた表示では何も描かない。
        // **どこまで寄れば出るかを数字で言う。**
        statuses.push([source, `ズーム${firstVisibleZoom(source)}まで寄ると出ます`]);
        continue;
      }
      const area = source.coverage;
      // 配られているより細かくはできない。引くほど粗く束ねる。
      const digits = Math.min(meshDigits(zoom), area.meshDigits);
      const cells = await busy('整備範囲を読み込み中…', async () => {
        await area.ensure();
        return fetchCoverageInView(conn, area, bounds, digits);
      });
      if (token !== buildingsToken) return;
      coverageFeatures.push(...coverageFeatureCollection(cells).features);
      const buildings = cells.reduce((total, cell) => total + cell.buildings, 0);
      statuses.push([
        source,
        `整備範囲 ${cells.length.toLocaleString()} メッシュ` +
          ` (${MESH_SIZE_LABELS[digits] ?? `${digits}桁`}) · ` +
          `建物 ${buildings.toLocaleString()} 棟 · ズーム${firstVisibleZoom(source)}から建物そのもの`,
      ]);
    }
    await coverage?.setData({ type: 'FeatureCollection', features: coverageFeatures });

    const features: GeoJSON.Feature[] = [];
    for (const source of visible) {
      const depth = depths.get(source);
      if (depth === null || depth === undefined) continue;
      const rows = await busy('建物を読み込み中…', async () => {
        await source.ensure();
        return fetchBuildingsInView(
          conn,
          source,
          bounds,
          filterOf(source),
          detail.buildingsLimit,
          depth === 'all' ? undefined : depth,
        );
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
            // **重要度の段。** 名前はホバー用、順位は色分け用 (0がいちばん重要)。
            // 段の無い出所では -1 にして、色分けでも既定の塗りに落とす。
            tier: source.tiers?.tiers.find((t) => t.id === row.tier)?.title ?? null,
            tierRank: source.tiers?.tiers.findIndex((t) => t.id === row.tier) ?? -1,
          },
          geometry: row.geojson,
        });
      }
      const count =
        rows.length >= detail.buildingsLimit
          ? `${detail.buildingsLimit}件以上 (表示上限)`
          : `${rows.length}件`;
      // **間引いているときは、どこまで出しているかを言う。** 黙って減らすと
      // 「住宅が無い」と読まれてしまう。
      const thinned =
        depth === 'all'
          ? ''
          : ` · ${source
              .tiers!.tiers.slice(0, depth + 1)
              .map((t) => t.title)
              .join('・')}のみ (ズーム${detail.buildingsMinZoom}ですべて)`;
      statuses.push([source, count + thinned + sourceLodNote(source, bounds)]);
    }
    await mapSource.setData({ type: 'FeatureCollection', features });
    for (const [source, text] of statuses) showBuildingStatus(source, text);
  };

  /**
   * このズームで建物をどこまで出すか。`'all'` = 全部、数字 = その順位の段まで (間引き)、
   * `null` = 建物は出さない (整備範囲を出すか、寄れと言う)。
   *
   * **1ズーム引くごとに1段減らす。** 画面の面積は1ズームで4倍になるので、
   * 段を1つ落とすことで読む量を抑える。実測 (東京駅・1280×720):
   * z13 で公共施設だけなら1.0万棟・1.9MB (全部なら22万棟・31MB)、
   * z14 で商業・業務までなら1.7万棟・2.5MB。
   * 段の列 (`lod_column`) を持たない出所は間引けないので、全部か無しか。
   */
  const buildingDepth = (source: BuildingSource, zoom: number): 'all' | number | null => {
    const steps = Math.ceil(detail.buildingsMinZoom - zoom);
    if (steps <= 0) return 'all';
    const tiers = source.tiers;
    if (!tiers?.lod_column) return null;
    const rank = tiers.tiers.length - 1 - steps;
    return rank >= 0 ? rank : null;
  };

  /** その出所の建物が出始めるズーム (間引いた段を含む)。 */
  const firstVisibleZoom = (source: BuildingSource): number =>
    source.tiers?.lod_column
      ? detail.buildingsMinZoom - (source.tiers.tiers.length - 1)
      : detail.buildingsMinZoom;

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

    // 世代は最初に進める (外したあとに読み込み中の結果が描かれないように。建物と同じ)。
    const token = ++meshToken;
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
    // 世代は最初に進める (外したあとに読み込み中の結果が描かれないように。建物と同じ)。
    const token = ++railwayToken;
    const visibleSources = railwaySources.filter((source) => isLayerVisible(source.id));
    if (visibleSources.length === 0) {
      await clear('');
      return;
    }

    const selectedTypes = [...railwayTypeInputs]
      .filter((input) => input.checked)
      .map((input) => input.value);

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

    // 世代は最初に進める (外したあとに読み込み中の結果が描かれないように。建物と同じ)。
    const token = ++roadToken;
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

  // ---- 送電線・川 (名前と種別だけの線) -----------------------------------------
  //
  // 道路と同じく**ズームで隠さない**。引いた表示では粗い段 (名前・種別・タイルで
  // 束ねて簡略化したもの) を引く。上限は道路と共有する (同じ太さの線なので)。
  const lineTokens = new Map<string, number>();
  const lineShown = new Set<string>();

  const refreshLine = async (source: LineSource) => {
    const mapSource = map.getSource(`line-${source.kind}`) as GeoJSONSource | undefined;
    if (!mapSource) return;
    // 世代は最初に進める (外したあとに読み込み中の結果が描かれないように。建物と同じ)。
    const token = (lineTokens.get(source.id) ?? 0) + 1;
    lineTokens.set(source.id, token);
    if (!isLayerVisible(source.id)) {
      if (lineShown.has(source.id)) {
        await mapSource.setData(EMPTY_FEATURE_COLLECTION);
        lineShown.delete(source.id);
      }
      setLayerStatus(source.id, '');
      return;
    }
    const zoom = map.getZoom();
    const lod = lodForZoom(source, zoom);
    const features = await busy(`${source.title}を読み込み中…`, async () => {
      await source.ensure();
      return fetchLinesInView(conn, source, currentBounds(), detail.roadLimit, lod);
    });
    if (lineTokens.get(source.id) !== token) return;

    lineShown.add(source.id);
    await mapSource.setData({
      type: 'FeatureCollection',
      features: features.map((feature) => ({
        type: 'Feature',
        properties: {
          name: feature.name,
          lineClass: LINE_CLASS_LABELS[feature.lineClass] ?? feature.lineClass,
          origin: source.id,
        },
        geometry: feature.geojson,
      })),
    });
    const capped = features.length >= detail.roadLimit;
    setLayerStatus(
      source.id,
      features.length === 0
        ? 'この範囲にありません'
        : `${features.length.toLocaleString()} ${lod === COARSE_LOD ? '本' : '区間'}` +
            lodNote(source, lod) +
            (capped ? ' (表示上限)' : ''),
    );
  };

  const requestLineRefresh = (source: LineSource) => () => {
    refreshLine(source).catch((e: unknown) => {
      console.error('[line] failed', source.id, e);
      showFailure(`${source.title}の読み込みに失敗しました`);
    });
  };
  for (const source of lineSources) map.on('moveend', requestLineRefresh(source));

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

  /** 建物の設定パネルをその出所に向ける。中身は建物の節 (下) で埋める。 */
  let pointBuildingSettings: (source: BuildingSource) => void = () => {};

  /** 外部のベクトルタイル。ホバーで引き当てるために持っておく。 */
  const vectorOverlays: VectorOverlay[] = [];

  // ---- 地図タイル (背景地図・ベクタータイル) と地形 ---------------------------------
  //
  // **QGISと同じく、背景地図も重ねられるレイヤーの1つ。** 一覧に重ね順で並べる
  // (上の行ほど上)。以前は「後から入れたものが上」という規則で重ねていたが、
  // 一覧から順番が見えないので、何が上にあるかが分からなかった。

  /** 地形に使える標高 (Mapterhorn・Re:Earth・地理院…)。**1つだけ**選ぶ。 */
  const terrainCollections: Collection[] = [];

  /** 範囲つきのスライダー1つ (不透明度・起伏の強調)。地図を見ながら動かすので行の下に開く。 */
  const sliderSettings = (
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    format: (value: number) => string,
    onInput: (value: number) => void,
  ): HTMLElement => {
    const wrap = document.createElement('label');
    wrap.className = 'layer-slider';
    const text = document.createElement('span');
    text.textContent = `${label} ${format(value)}`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => {
      text.textContent = `${label} ${format(Number(input.value))}`;
      onInput(Number(input.value));
    });
    wrap.append(text, input);
    const settings = document.createElement('div');
    settings.append(wrap);
    return settings;
  };

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

  /** 配信しているJSONそのものへのリンク。**カタログが実在することを見せる。** */
  const jsonLink = (path: string | undefined, label: string): HTMLElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'json-link';
    button.textContent = label;
    button.title = 'STACの文書を見る';
    button.disabled = !path;
    // **ページの中で開く** (`openStac`)。生のJSONへ飛ばすと地図から離れる。
    if (path) button.addEventListener('click', () => openStac(path));
    return button;
  };

  const formatBbox = ([west, south, east, north]: Bbox) =>
    `${west.toFixed(2)}, ${south.toFixed(2)} – ${east.toFixed(2)}, ${north.toFixed(2)}`;

  /**
   * Collection 1つぶんの中身。**カタログに書いてあることだけを出す。**
   *
   * 絞り込みだけでは、行の裏にあるのがどのCollectionで、何ファイルあって、
   * 元のJSONはどこか、が画面から辿れない。
   */
  /** 切り出しで書き出す行の上限。DuckDB-WASM のメモリの中にファイルを作るため。 */
  const MAX_EXPORT_ROWS = 300_000;

  /**
   * **この範囲を取得** — 3通り。
   *
   * 1. **この範囲の GeoParquet**: 表示範囲で切り出して保存する (ブラウザの中で書く)。
   *    出典と規約を KV メタデータに入れて、切り出したファイルにも条件が付いて回るようにする
   * 2. **ファイルごと**: 範囲に重なるファイル (配信している GeoParquet) と、その配布元
   * 3. **CityGML** (PLATEAUだけ): 公式の配信サービスで、表示範囲のメッシュ単位のGMLを
   *    直接リンクし、付属ファイル込みのZIPにもまとめられる (pack)
   *
   * 開いたときの表示範囲で作る (開くまで何も読まない)。
   */
  const downloadSection = (collection: Collection): HTMLElement => {
    const section = document.createElement('details');
    section.className = 'download-section';
    const summary = document.createElement('summary');
    summary.textContent = 'この範囲を取得';
    const body = document.createElement('div');
    section.append(summary, body);
    section.addEventListener('toggle', () => {
      if (section.open) void fillDownloads(collection, body);
    });
    return section;
  };

  const fillDownloads = async (collection: Collection, body: HTMLElement) => {
    body.replaceChildren(document.createTextNode('範囲のファイルを調べています…'));
    const bounds = currentBounds();
    const items = (await collection.items()).filter(({ feature }) => {
      const bbox = feature.bbox?.length === 4 ? (feature.bbox as Bbox) : null;
      return !bbox || bboxOverlaps(bbox, bounds);
    });
    const files = items.map(itemFile);
    body.replaceChildren();
    if (files.length === 0) {
      body.append('この範囲にはファイルがありません');
      return;
    }

    // 1. この範囲の GeoParquet。
    const status = document.createElement('p');
    status.className = 'download-status';
    const clip = document.createElement('button');
    clip.type = 'button';
    clip.className = 'download-clip';
    clip.textContent = 'この範囲を GeoParquet で保存';
    clip.addEventListener('click', () => {
      void (async () => {
        clip.disabled = true;
        try {
          status.textContent = '数えています…';
          await ensureSpatial();
          // 表示で使っていないファイルもあるので登録する (済んでいるものは何もしない)。
          await registerFiles(files);
          const list = files.map((file) => `'${file}'`).join(', ');
          // 線の粗い段 (統合・簡略化した行) は**原寸と重なる複製**なので書き出さない。
          // 建物の段 (lod) は行の振り分けで重複は無いが、配信の都合の列なので外す。
          const exact = collection.coarseLodToleranceM !== undefined ? `lod = ${EXACT_LOD} AND` : '';
          const exclude = collection.columns.has('lod') ? ' EXCLUDE (lod)' : '';
          const where = `${exact} bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}
            AND bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}`;
          const counted = await conn.query(`SELECT count(*) AS n FROM read_parquet([${list}]) WHERE ${where};`);
          const rows = Number((counted.toArray()[0].toJSON() as { n: number | bigint }).n);
          if (rows === 0) {
            status.textContent = 'この範囲にはありません';
            return;
          }
          if (rows > MAX_EXPORT_ROWS) {
            status.textContent = `${rows.toLocaleString()} 件あり、多すぎます (上限 ${MAX_EXPORT_ROWS.toLocaleString()} 件)。寄ってから保存してください`;
            return;
          }
          status.textContent = `${rows.toLocaleString()} 件を書き出しています…`;
          const bytes = await exportParquet(`SELECT *${exclude} FROM read_parquet([${list}]) WHERE ${where}`, {
            'duck:attribution': collection.attribution,
            'duck:terms': collection.terms ? `${collection.terms.name} ${collection.terms.url}` : collection.license,
            'duck:source': `${collection.id} (${dataUrl(collection.path)})`,
            'duck:clip_bbox': `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`,
            ...(collection.vintage ? { 'duck:vintage': collection.vintage } : {}),
          });
          saveBytes(bytes, `${collection.id}_${new Date().toISOString().slice(0, 10)}.parquet`);
          status.textContent = `${rows.toLocaleString()} 件・${formatBytes(bytes.length)} を保存しました (出典と規約をファイルのメタデータに入れています)`;
        } catch (e) {
          console.error('[download] failed', e);
          status.textContent = '書き出せませんでした';
        } finally {
          clip.disabled = false;
        }
      })();
    });
    body.append(clip, status);

    // 2. ファイルごと (配信している GeoParquet と配布元)。
    const fileList = document.createElement('ul');
    fileList.className = 'download-files';
    const shown = items.slice(0, 12);
    for (const item of shown) {
      const li = document.createElement('li');
      const ours = document.createElement('a');
      ours.href = dataUrl(itemFile(item));
      ours.textContent = item.feature.id;
      ours.download = '';
      li.append(ours);
      const via = item.feature.links?.find((link) => link.rel === 'via')?.href ?? collection.via;
      if (via) li.append(' · ', externalLink(via, '配布元'));
      fileList.append(li);
    }
    const fileHead = document.createElement('p');
    fileHead.className = 'download-head';
    fileHead.textContent =
      `ファイルごと (${items.length.toLocaleString()} 件` +
      (items.length > shown.length ? `、先頭 ${shown.length} 件を表示` : '') +
      ')';
    body.append(fileHead, fileList);

    // 3. CityGML (PLATEAU だけ)。
    if (collection.kind === 'plateau_buildings') body.append(cityGmlSection(bounds));
  };

  /** CityGML の取得。メッシュ単位の直リンクと、公式 pack の ZIP。 */
  const cityGmlSection = (bounds: ViewBounds): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'citygml-section';
    const head = document.createElement('p');
    head.className = 'download-head';
    head.textContent = 'CityGML (PLATEAU配信サービス)';
    const find = document.createElement('button');
    find.type = 'button';
    find.className = 'citygml-find';
    find.textContent = 'この範囲の CityGML を探す';
    const result = document.createElement('div');
    box.append(head, find, result);

    find.addEventListener('click', () => {
      void (async () => {
        const codes = meshCodesInView(bounds);
        if (!codes) {
          result.textContent = '範囲が広すぎます。寄ってから探してください';
          return;
        }
        find.disabled = true;
        result.textContent = '探しています…';
        try {
          const files = await fetchCityGmlFiles(codes);
          renderCityGml(result, files);
        } catch (e) {
          console.error('[citygml] failed', e);
          result.textContent = 'PLATEAU配信サービスから取れませんでした';
        } finally {
          find.disabled = false;
        }
      })();
    });
    return box;
  };

  const renderCityGml = (container: HTMLElement, files: CityGmlFile[]) => {
    container.replaceChildren();
    if (files.length === 0) {
      container.textContent = 'この範囲にはありません';
      return;
    }
    const types = [...new Set(files.map((f) => f.type))].sort(
      (a, b) => (a === 'bldg' ? -1 : b === 'bldg' ? 1 : a.localeCompare(b)),
    );
    const select = document.createElement('select');
    select.className = 'citygml-type';
    for (const type of types) {
      const option = document.createElement('option');
      option.value = type;
      const count = files.filter((f) => f.type === type).length;
      option.textContent = `${CITYGML_TYPES[type] ?? type} (${type}) · ${count} ファイル`;
      select.append(option);
    }
    const list = document.createElement('ul');
    list.className = 'citygml-files';
    const pack = document.createElement('button');
    pack.type = 'button';
    pack.className = 'citygml-pack';
    const packStatus = document.createElement('p');
    packStatus.className = 'download-status';

    const show = () => {
      const chosen = files.filter((f) => f.type === select.value);
      const total = chosen.reduce((sum, f) => sum + (f.fileSize ?? 0), 0);
      list.replaceChildren(
        ...chosen.map((file) => {
          const li = document.createElement('li');
          const link = externalLink(file.url, `${file.code}`);
          li.append(
            link,
            ` · LOD${file.maxLod}` +
              (file.features ? ` · ${file.features.toLocaleString()} 件` : '') +
              (file.fileSize ? ` · ${formatBytes(file.fileSize)}` : ''),
          );
          return li;
        }),
      );
      pack.textContent = `ZIPにまとめる (コードリスト・テクスチャ込み${total ? `、約 ${formatBytes(total)}` : ''})`;
      packStatus.textContent = '';
    };
    select.addEventListener('change', show);
    pack.addEventListener('click', () => {
      void (async () => {
        const urls = files.filter((f) => f.type === select.value).map((f) => f.url);
        pack.disabled = true;
        packStatus.textContent = 'PLATEAU配信サービスにまとめてもらっています…';
        try {
          const zip = await packCityGml(urls, (progress) => {
            packStatus.textContent = `まとめています… ${Math.round(progress * 100)}%`;
          });
          packStatus.replaceChildren(externalLink(zip, 'ZIPをダウンロード'));
        } catch (e) {
          console.error('[citygml pack] failed', e);
          packStatus.textContent = 'まとめられませんでした';
        } finally {
          pack.disabled = false;
        }
      })();
    });
    show();
    const note = document.createElement('p');
    note.className = 'download-note';
    note.textContent =
      'GMLはメッシュ単位の原典そのもの。用途などのコードを読むにはコードリストが要るので、変換ツールに渡すならZIPにまとめたものを使ってください。';
    container.append(select, list, pack, packStatus, note);
  };

  /**
   * 外部のタイルセットのカード。**ファイルも列も無い** (Itemを持たず、SQLでは引けない)。
   * 代わりに形式・大きさ・ズーム・層と、どう作ったか (簡略化の度合い) を出す。
   */
  const vectorTilesFacts = (
    collection: Collection,
    fact: (term: string, ...value: (string | Node)[]) => HTMLElement,
  ): HTMLElement[] => {
    const data = collection.assets.data;
    if (data) {
      const size = data['file:size'];
      fact('形式', 'PMTiles', size ? ` (${formatBytes(size)})` : '', ' ', externalLink(data.href, 'タイル'));
      const zoom = data['duck:zoom'];
      if (zoom) fact('ズーム', `${zoom[0]}〜${zoom[1]} (それより寄ると拡大して描く)`);
    }
    fact('引き方', '重ねて見るだけ。SQL では引けない (表示用に簡略化されている)');
    // **配布元の描き方は使っていない。** 形の種類 (カタログに載っている) から描いている。
    fact('描き方', 'データだけを読み、形 (面・線・点) ごとにこのアプリが描く');
    if (collection.bbox) fact('範囲', formatBbox(collection.bbox));

    // 層は24あるので、テーマごとにたたんでおく。属性も添える (ホバーで読めるもの)。
    const themes = collection.themes ?? [];
    const layersEl = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `層 (${themes.reduce((sum, theme) => sum + theme.layers.length, 0)})`;
    const list = document.createElement('ul');
    list.className = 'vector-layer-list';
    for (const theme of themes) {
      for (const layer of theme.layers) {
        const item = document.createElement('li');
        const fields = layer.fields.length > 0 ? ` — ${layer.fields.join(', ')}` : '';
        const shape = layer.geometry ? `${GEOMETRY_LABELS[layer.geometry] ?? layer.geometry}・` : '';
        item.textContent = `${theme.title} › ${layer.title} (${layer.id}、${shape}ズーム${layer.minzoom}〜)${fields}`;
        list.append(item);
      }
    }
    layersEl.append(summary, list);

    const nodes: HTMLElement[] = [layersEl];
    // **どう作ったか。** tippecanoe の `-S` (簡略化) などが読める。判定に使えない根拠。
    if (collection.generatorOptions) {
      const generator = document.createElement('details');
      const generatorSummary = document.createElement('summary');
      generatorSummary.textContent = '作り方 (配布元のメタデータ)';
      const code = document.createElement('pre');
      code.className = 'generator-options';
      code.textContent = collection.generatorOptions.replace(/; /g, ';\n');
      generator.append(generatorSummary, code);
      nodes.push(generator);
    }
    return nodes;
  };

  /**
   * 外部の地図タイル・標高のカード。**ファイルも列も無い** (タイルは1ファイルではない)。
   * どこから読んでいるか (タイルのURL・TileJSON) と、タイルがあるズームを出す。
   */
  const tileFacts = (
    collection: Collection,
    fact: (term: string, ...value: (string | Node)[]) => HTMLElement,
  ) => {
    const link = collection.tileLink;
    if (link?.rel === '3d-tiles') {
      fact('形式', '3D Tiles ', externalLink(link.href, 'tileset.json'));
    } else if (link) {
      const tileJson = link.rel === 'tilejson';
      // XYZ のテンプレートはそのままでは開けないので、文字で見せる (TileJSON はリンク)。
      const where = tileJson ? externalLink(link.href, 'TileJSON') : document.createElement('code');
      if (!tileJson) where.textContent = link.href;
      const kind = collection.kind === 'terrain' ? '標高タイル' : '地図タイル';
      fact('形式', `${kind} (${tileJson ? 'TileJSON' : 'XYZ'}) `, where);
    }
    // **標高の中身の約束** (エンコード・高さの基準・値なしの扱い)。同じ「標高タイル」でも違う。
    if (collection.dem) {
      fact('標高の形式', DEM_ENCODING_LABELS[collection.dem.encoding] ?? collection.dem.encoding);
      fact('高さの基準', DEM_VERTICAL_LABELS[collection.dem.vertical] ?? collection.dem.vertical);
      if (collection.dem.description) fact('読み方', collection.dem.description);
    }
    if (collection.zoom && collection.kind !== 'reference') {
      fact('ズーム', `${collection.zoom[0]}〜${collection.zoom[1]} (それより寄ると拡大して描く)`);
    }
    const use: Partial<Record<DatasetKind, string>> = {
      terrain: '地図を立体にするだけ。SQL では引けない',
      raster_tiles: '下に敷いて見るだけ。SQL では引けない',
      '3d_tiles': 'この地図 (MapLibre) では描けない。公式のビューアで見る',
      reference: 'このカタログからは配っていない (作られた元として載せている)',
    };
    if (use[collection.kind]) fact('引き方', use[collection.kind]!);
    if (collection.viewer) fact('ビューア', externalLink(collection.viewer, '公式のビューアで開く'));
    if (collection.bbox) fact('範囲', formatBbox(collection.bbox));
  };

  /**
   * **作られた元** (`derived_from`)。押すとその Collection のカードに移る (カタログを辿れる)。
   * 「Mapterhorn の日本は基盤地図情報」のような関係を、画面から追えるようにする。
   */
  const derivedFromFact = (
    collection: Collection,
    fact: (term: string, ...value: (string | Node)[]) => HTMLElement,
  ) => {
    if (collection.derivedFrom.length === 0) return;
    const buttons = collection.derivedFrom.map((path) => {
      const target = collections.find((c) => c.path === path);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'json-link derived-from';
      button.textContent = target ? `${target.group?.title ?? ''} › ${target.title}` : path;
      button.addEventListener('click', () => {
        if (!target) {
          openStac(path);
          return;
        }
        layerDetailTitleEl.textContent = `${target.group?.title ?? ''} › ${target.title}`;
        layerCatalogEl.replaceChildren(collectionCard(target));
      });
      return button;
    });
    fact('作られた元', ...buttons.flatMap((button, i) => (i === 0 ? [button] : [' · ', button])));
  };

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
    // **使うときの条件はバッジで出す。** 識別子 (`other` を含む) だけでは何ができるか
    // 分からない。規約の本文へのリンクを必ず添える (バッジは要約)。
    if (collection.terms) {
      fact('使う条件', termsBadges(collection.terms), ' ', externalLink(collection.terms.url, collection.terms.name));
    } else {
      // 古いカタログ (duck:terms の無いもの) では識別子だけ出す。
      fact(
        'ライセンス',
        collection.license === 'other'
          ? externalLink(collection.attributionUrl, '利用規約')
          : collection.license,
      );
    }
    if (collection.provider) fact('提供', collection.provider);
    if (collection.vintage) fact('版', collection.vintage);
    if (collection.kind === 'vector_tiles') {
      card.append(head, description, facts, ...vectorTilesFacts(collection, fact));
      return card;
    }
    derivedFromFact(collection, fact);
    if (
      collection.kind === 'raster_tiles' ||
      collection.kind === 'terrain' ||
      collection.kind === '3d_tiles' ||
      collection.kind === 'reference'
    ) {
      tileFacts(collection, fact);
      card.append(head, description, facts);
      return card;
    }
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
    if (collection.itemsPath && collection.columns.has('geometry')) {
      card.append(downloadSection(collection));
    }
    return card;
  };


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

  // ---- 地形 ---------------------------------------------------------------------
  //
  // **1つだけ選ぶ。** 出すか (チェック) と、どの標高か (選択) を1行で。地図右上の
  // 地形ボタン (TerrainControl) と同じものを切るので、どちらで切っても追随する。
  const terrainRowEl = document.querySelector<HTMLDivElement>('#terrain-row')!;
  const terrainToggle = document.querySelector<HTMLInputElement>('#terrain-toggle')!;
  const terrainSelect = document.querySelector<HTMLSelectElement>('#terrain-source')!;
  const terrainSettingsButton = document.querySelector<HTMLButtonElement>('#terrain-settings')!;
  const terrainDetailButton = document.querySelector<HTMLButtonElement>('#terrain-detail')!;
  const terrainSlotEl = document.querySelector<HTMLDivElement>('#terrain-slot')!;
  let terrainExaggeration = 1;
  let terrainChoice = defaultOf(terrainCollections, 'terrain');
  /** 標高を差し替えている最中 (その間の「地形が外れた」通知は、チェックに写さない)。 */
  let switchingTerrain = false;
  terrainRowEl.hidden = terrainCollections.length === 0;
  for (const collection of terrainCollections) {
    const option = document.createElement('option');
    option.value = collection.id;
    option.textContent = `${collection.title} (${collection.group?.title ?? ''})`;
    terrainSelect.append(option);
  }
  if (terrainChoice) terrainSelect.value = terrainChoice.id;
  terrainToggle.checked = map.getTerrain() !== null;

  const applyTerrain = () =>
    map.setTerrain(
      terrainToggle.checked && terrainChoice
        ? { source: TERRAIN_SOURCE, exaggeration: terrainExaggeration }
        : null,
    );
  terrainToggle.addEventListener('change', applyTerrain);
  terrainSelect.addEventListener('change', () => {
    const next = terrainCollections.find((c) => c.id === terrainSelect.value);
    if (!next || next === terrainChoice) return;
    terrainChoice = next;
    // **ソースごと差し替える** (URL もエンコードも範囲も標高ごとに違う)。差し替えのために
    // いったん外すが、その通知でチェックを外さない (外すと、付け直されずに地形が消えた)。
    switchingTerrain = true;
    map.setTerrain(null);
    if (map.getSource(TERRAIN_SOURCE)) map.removeSource(TERRAIN_SOURCE);
    map.addSource(TERRAIN_SOURCE, terrainSource(next));
    switchingTerrain = false;
    applyTerrain();
  });
  // 起伏の強調は ⚙ で行の下に開く (地図を見ながら動かすもの)。
  terrainSlotEl.append(
    sliderSettings('起伏の強調', 1, 3, 0.5, 1, (v) => `×${v}`, (v) => {
      terrainExaggeration = v;
      if (map.getTerrain()) applyTerrain();
    }),
  );
  terrainSettingsButton.addEventListener('click', () => {
    terrainSlotEl.hidden = !terrainSlotEl.hidden;
    terrainSettingsButton.setAttribute('aria-expanded', String(!terrainSlotEl.hidden));
  });
  terrainDetailButton.addEventListener('click', () => {
    if (!terrainChoice) return;
    layerDetailTitleEl.textContent = `地形 › ${terrainChoice.group?.title ?? ''} › ${terrainChoice.title}`;
    layerCatalogEl.replaceChildren(collectionCard(terrainChoice));
    layerDetailDialog.showModal();
  });
  // 地図右上の地形ボタンで切られたら、一覧のチェックを追随させる。
  map.on('terrain', () => {
    if (switchingTerrain) return;
    terrainToggle.checked = map.getTerrain() !== null;
  });

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
  if (meshSources[0]) mirrorStatus(meshSources[0].id, meshSummaryEl);
  if (roadSource) mirrorStatus(roadSource.id, roadSummaryEl);

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

      // **重要度の段。** 段の規則はカタログから来るので、出所ごとに作り直す
      // (題名は同じでも、何がどの段に入るかは出所の語彙で違う)。
      tierField.hidden = !source.tiers;
      tierOptionsEl.replaceChildren();
      for (const tier of source.tiers?.tiers ?? []) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = tier.id;
        checkbox.checked = filter.tiers === null || filter.tiers.includes(tier.id);
        checkbox.addEventListener('change', () => {
          const all = source.tiers!.tiers.map((t) => t.id);
          const checked = [...tierOptionsEl.querySelectorAll<HTMLInputElement>('input:checked')];
          filter.tiers = checked.length === all.length ? null : checked.map((c) => c.value);
          requestRefresh();
        });
        // 何が入るのかを添える。段の名前だけでは「業務」に工場が入るのか分からない。
        label.title = tier.values.length > 0 ? tier.values.join('・') : 'どの段にも入らないもの';
        label.append(checkbox, document.createTextNode(tier.title));
        tierOptionsEl.append(label);
      }

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

    // **重要度で色分けする。** 重要な段を目立たせ、住宅・その他を退かせる。
    // 引き直さず塗りだけを替える (段は既に地物に入っている)。出所をまたいで効く。
    tierColorToggle.addEventListener('change', () => {
      map.setPaintProperty(
        'buildings-3d',
        'fill-extrusion-color',
        tierColorToggle.checked ? BUILDING_COLOR_BY_TIER : BUILDING_COLOR_BY_HEIGHT,
      );
    });

    // **どちらかの ⚙ を押したら、共有しているパネルをその出所に向ける。**
    // 描く出所は変えない (それは一覧のチェックが決める)。
    pointBuildingSettings = (source) => {
      settingsSource = source;
      showFilters(source);
      buildingCountEl.textContent = layerStatus.get(source.id) ?? '';
    };
    showFilters(settingsSource);
    // 整備範囲は refreshBuildings が出すが、その呼び出しは moveend でしか
    // 起きない。起動直後にも一度呼んでおかないと、地図を動かすまで出ない。
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
  /** 周辺検索の待ち受け中。📍と同じく、押してから地図をクリックする。 */
  let nearbyMode = false;
  /** 吹き出しの出る地物の上にいるか (ポインタの形を変える)。 */
  let hoveringFeature = false;
  const updateCursor = () => {
    map.getCanvas().style.cursor =
      picking || nearbyMode ? 'crosshair' : hoveringFeature ? 'pointer' : '';
  };

  // 📍と◎は**どちらか一方だけ**。両方が待ち受けていると、1回のクリックで
  // 判定と周辺検索が同時に走って、どちらの結果か分からなくなる。
  const setPicking = (on: boolean) => {
    picking = on;
    pickButton.setAttribute('aria-pressed', String(on));
    if (on && nearbyMode) setNearbyMode(false);
    updateCursor();
  };
  const setNearbyMode = (on: boolean) => {
    nearbyMode = on;
    nearbyButton.setAttribute('aria-pressed', String(on));
    if (on && picking) setPicking(false);
    // **押したらパネルを出して、何をすればいいかを言う。** 検索で選んだものがあれば、
    // 地図をクリックせずにそれを起点にもできる。
    if (on) {
      nearbyPanel.hidden = false;
      nearbyOriginEl.textContent = '地図の点・線・建物をクリックしてください';
      nearbyResultsEl.replaceChildren();
      nearbyFromSearch.hidden = lastSelection === null;
    }
    updateCursor();
  };

  pickButton.addEventListener('click', () => setPicking(!picking));
  nearbyButton.addEventListener('click', () => setNearbyMode(!nearbyMode));

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
    if (nearbyMode) {
      setNearbyMode(false);
      return;
    }
    // 周辺検索の結果を出していれば、それを先に閉じる (× を探させない)。
    if (!nearbyPanel.hidden) {
      clearNearby();
      return;
    }
    clearSearch();
  });

  // ---- 周辺検索 ---------------------------------------------------------------
  //
  // 起点は4通り: 検索で選んだもの / 地図上の点 / 地図上の線 / 建物。
  // 地図上のものは◎を押してからクリックする。何も無いところなら点、
  // 線や建物の上ならそれを起点にする。
  let lastSelection: NearbyOrigin | null = null;
  let currentOrigin: NearbyOrigin | null = null;

  /**
   * 結果の見せ方。**種類ごとに地図への表示を切り替え** (`hidden`)、**名前を押すとそれだけを
   * 残して寄る** (`focus`)。「当たった川はどこか」「当たった駅だけ見たい」に答えるため。
   *
   * `hidden` の鍵は種類の名前 (「鉄道」「駅」…)、建物全体は「建物」、建物の段は `段:公共施設`。
   */
  let nearbyView: { hidden: Set<string>; focus: { kind: string; name: string } | null } = {
    hidden: new Set(),
    focus: null,
  };
  /** 最後に描いた結果 (名前を押したときに寄る先を探す)。 */
  let nearbyDrawn: { buildings: GeoJSON.Feature[]; lines: GeoJSON.Feature[] } = { buildings: [], lines: [] };

  const TRUE: ExpressionSpecification = ['==', 1, 1];
  const FALSE: ExpressionSpecification = ['==', 1, 0];

  /** 見せ方を地図の絞り込み (filter) に写す。 */
  const applyNearbyView = () => {
    const { hidden, focus } = nearbyView;
    const tiers = [...hidden].filter((key) => key.startsWith('段:')).map((key) => key.slice(2));
    const onlyName = (kind: string): ExpressionSpecification =>
      focus ? (focus.kind === kind ? ['==', ['get', 'name'], focus.name] : FALSE) : TRUE;
    if (map.getLayer('nearby-hits')) {
      map.setFilter('nearby-hits', [
        'all',
        hidden.has('建物') ? FALSE : TRUE,
        ['!', ['in', ['get', 'tier'], ['literal', tiers]]],
        onlyName('建物'),
      ]);
    }
    if (map.getLayer('nearby-hit-lines')) {
      map.setFilter('nearby-hit-lines', [
        'all',
        ['!', ['in', ['get', 'kind'], ['literal', [...hidden]]]],
        focus ? ['all', ['==', ['get', 'kind'], focus.kind], ['==', ['get', 'name'], focus.name]] : TRUE,
      ]);
    }
  };

  /** 名前を押したとき: それだけを残し、そこへ寄る。もう一度押すと戻す。 */
  const focusNearby = (kind: string, name: string) => {
    const same = nearbyView.focus?.kind === kind && nearbyView.focus.name === name;
    nearbyView.focus = same ? null : { kind, name };
    applyNearbyView();
    if (!same) {
      const pool = kind === '建物' ? nearbyDrawn.buildings : nearbyDrawn.lines;
      const matched = pool.filter(
        (f) => f.properties?.name === name && (kind === '建物' || f.properties?.kind === kind),
      );
      const box = unionBbox(matched.map((f) => geometryBbox(f.geometry)));
      if (box) {
        map.fitBounds(
          [
            [box[0], box[1]],
            [box[2], box[3]],
          ],
          { padding: 80, maxZoom: 17, duration: 600 },
        );
      }
    }
  };
  let nearbyToken = 0;

  /** 検索で選んだものを覚えておく。周辺検索のパネルから起点にできる。 */
  const rememberSelection = (label: string, geometry: GeoJSON.Geometry) => {
    lastSelection = { label, geometry };
    nearbyFromSearch.hidden = false;
  };

  /** 起点に使える地図上のレイヤーと、その呼び名・名前の属性。上ほど優先。 */
  const ORIGIN_LAYERS: { layer: string; label: string; nameKey: string | null }[] = [
    { layer: 'buildings-3d', label: '建物', nameKey: null },
    { layer: 'line-power_line', label: '送電線', nameKey: 'name' },
    { layer: 'line-waterway', label: '川', nameKey: 'name' },
    { layer: 'railway-station', label: '駅', nameKey: 'stationName' },
    { layer: 'railway-line', label: '鉄道', nameKey: 'lineName' },
    { layer: 'road-line', label: '道路', nameKey: 'roadName' },
  ];

  /**
   * クリックした場所の起点を決める。**線は同じ名前の区間をまとめて起点にする**
   * (川や送電線は区間に切れているので、1区間だけだと「川沿い」にならない)。
   * 名前は表示中のデータから集めるので、画面に出ている範囲の分になる。
   */
  const originAt = async (
    point: { x: number; y: number },
    lngLat: { lng: number; lat: number },
  ): Promise<NearbyOrigin> => {
    const layers = ORIGIN_LAYERS.filter(({ layer }) => map.getLayer(layer));
    const hits = map.queryRenderedFeatures([point.x, point.y], {
      layers: layers.map(({ layer }) => layer),
    });
    const hit = hits[0];
    const spec = hit && layers.find(({ layer }) => layer === hit.layer.id);
    if (!hit || !spec) {
      return {
        label: `地図上の点 (${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)})`,
        geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] },
      };
    }
    if (spec.nameKey === null) {
      return {
        label: `${spec.label} ${(hit.properties.name as string | null) ?? '(名称なし)'}`,
        geometry: hit.geometry,
        height: (hit.properties.height as number | null | undefined) ?? null,
      };
    }
    const name = hit.properties[spec.nameKey] as string | null;
    if (!name) return { label: `${spec.label} (名前なし)`, geometry: hit.geometry };
    const data = await (map.getSource(hit.source) as GeoJSONSource).getData();
    const lines: GeoJSON.Position[][] = [];
    if (data.type === 'FeatureCollection') {
      for (const feature of data.features) {
        if (feature.properties?.[spec.nameKey] !== name) continue;
        const g = feature.geometry;
        if (g.type === 'LineString') lines.push(g.coordinates);
        if (g.type === 'MultiLineString') lines.push(...g.coordinates);
      }
    }
    return {
      label: `${spec.label} ${name}`,
      geometry: lines.length > 0 ? { type: 'MultiLineString', coordinates: lines } : hit.geometry,
    };
  };

  map.on('click', (e) => {
    if (!nearbyMode) return;
    // このクリックは起点を選ぶもの。吹き出し (下の click) には渡さない。
    e.preventDefault();
    setNearbyMode(false);
    void originAt(e.point, e.lngLat).then(runNearby);
  });

  // **結果だけを目立たせる。** 周辺検索の結果を出しているあいだ、うちのデータの層を
  // 薄くする (消しはしない — 薄く残すと、結果がどこに当たっているかの手がかりになる)。
  // 背景地図と周辺検索の層 (起点・範囲・結果) はそのまま。
  const NEARBY_KEEP = /^(basemap\/|nearby-|highlight|selected-point)/;
  type PaintProperty = Parameters<MapLibreMap['getPaintProperty']>[1];
  const DIM_PROPERTIES: Record<string, PaintProperty[]> = {
    fill: ['fill-opacity'],
    line: ['line-opacity'],
    circle: ['circle-opacity', 'circle-stroke-opacity'],
    symbol: ['text-opacity', 'icon-opacity'],
  };
  const NEARBY_DIM = 0.12;
  /** 周辺検索の層。**下から上の順** (範囲 → 当たったもの → 起点)。 */
  const NEARBY_LAYERS = [
    'nearby-zone-fill',
    'nearby-zone-line',
    'nearby-hits',
    'nearby-hit-lines',
    'nearby-origin-fill',
    'nearby-origin-casing',
    'nearby-origin-line',
    'nearby-origin-point',
  ];
  /** 薄くした層と、元の値 (戻すため)。元が既定値なら undefined で、戻すと既定に戻る。 */
  type PaintValue = Parameters<MapLibreMap['setPaintProperty']>[2];
  const dimmed = new Map<string, [PaintProperty, PaintValue][]>();
  const nearbyFocusInput = document.querySelector<HTMLInputElement>('#nearby-focus')!;

  /** 隠した立体の層 (戻すため)。 */
  const hiddenExtrusions = new Set<string>();

  const setNearbyFocus = (on: boolean) => {
    if (!on) {
      for (const [id, properties] of dimmed) {
        if (!map.getLayer(id)) continue;
        for (const [property, value] of properties) map.setPaintProperty(id, property, value);
      }
      dimmed.clear();
      for (const id of hiddenExtrusions) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
      }
      hiddenExtrusions.clear();
      return;
    }
    for (const layer of map.getStyle().layers) {
      if (NEARBY_KEEP.test(layer.id) || dimmed.has(layer.id) || hiddenExtrusions.has(layer.id)) continue;
      // **立体は薄くせず隠す。** 当たった建物を同じ場所に立体で重ねるので、薄くした元の
      // 建物と壁が重なって縞模様にちらついた。薄い立体は手がかりとしても読みにくい。
      if (layer.type === 'fill-extrusion') {
        if (layer.layout?.visibility === 'none') continue;
        hiddenExtrusions.add(layer.id);
        map.setLayoutProperty(layer.id, 'visibility', 'none');
        continue;
      }
      const properties = DIM_PROPERTIES[layer.type];
      if (!properties) continue;
      dimmed.set(
        layer.id,
        properties.map((property) => [property, map.getPaintProperty(layer.id, property)]),
      );
      for (const property of properties) map.setPaintProperty(layer.id, property, NEARBY_DIM);
    }
  };

  nearbyFocusInput.addEventListener('change', () => {
    setNearbyFocus(nearbyFocusInput.checked && currentOrigin !== null);
  });

  const clearNearby = () => {
    if (nearbyMode) setNearbyMode(false);
    nearbyToken++;
    currentOrigin = null;
    nearbyPanel.hidden = true;
    setNearbyFocus(false);
    Promise.all(
      ['nearby-zone', 'nearby-hits', 'nearby-hit-lines', 'nearby-origin'].map((id) =>
        setSourceData(id, null),
      ),
    ).catch((e: unknown) => console.error('[nearby] clear failed', e));
  };

  /** 周辺を調べて、パネルと地図に出す。 */
  const runNearby = async (origin: NearbyOrigin) => {
    // 起点が変わったら、種類ごとの表示の切り替えと絞り込みを戻す
    // (距離を変えただけなら、選んでいた見せ方を保つ)。
    if (origin !== currentOrigin) nearbyView = { hidden: new Set(), focus: null };
    currentOrigin = origin;
    nearbyPanel.hidden = false;
    nearbyFromSearch.hidden = lastSelection === null;
    const distance = Number(nearbyDistance.value);
    nearbyOriginEl.textContent = `起点: ${origin.label} (${distance} m 以内)`;
    nearbyResultsEl.textContent = '調べています…';
    const token = ++nearbyToken;
    const frame = nearbyFrame(origin, distance, currentBounds());
    // **押したものをすぐ強調する** (結果を待たずに、何を起点にしたかが分かるように)。
    void (map.getSource('nearby-origin') as GeoJSONSource | undefined)?.setData({
      type: 'Feature',
      properties: { height: origin.height ?? null },
      geometry: origin.geometry,
    });
    // 周辺検索の層を**いちばん上へ**。地図を作るときは早く足すので、あとから足した
    // 建物 (立体)・鉄道・地理院の層の下に隠れていた。下から 範囲 → 結果 → 起点 の順。
    for (const id of NEARBY_LAYERS) if (map.getLayer(id)) map.moveLayer(id);

    try {
      const result = await busy('周辺を調べています…', async () => {
        await ensureSpatial();
        const zone = await conn.query(
          `SELECT ST_AsGeoJSON(${fromMeters(frame, `ST_Buffer(${frame.origin}, ${distance})`)}) AS g;`,
        );
        const zoneGeometry = JSON.parse(
          (zone.toArray()[0].toJSON() as { g: string }).g,
        ) as GeoJSON.Geometry;

        const buildings: NearbyBuildings[] = [];
        for (const source of buildingSources) {
          await source.ensure();
          const found = await fetchNearbyBuildings(conn, source, frame);
          if (found) buildings.push(found);
        }
        // [種類, 結果, 出所のCollection ID]。出所は当たったものの吹き出しに使う。
        const names: [string, { names: string[]; total: number; features: GeoJSON.Feature[] }, string][] = [];
        for (const source of railwaySources) {
          await source.ensure();
          const expression =
            source.kind === 'railway_station'
              ? `station_name || '駅 (' || line_name || ')'`
              : `line_name || ' (' || operator || ')'`;
          names.push([
            source.kind === 'railway_station' ? '駅' : '鉄道',
            await fetchNearbyNames(conn, source, frame, expression),
            source.id,
          ]);
        }
        if (roadSource) {
          await roadSource.ensure();
          names.push([
            '道路',
            await fetchNearbyNames(
              conn,
              roadSource,
              frame,
              `coalesce(nullif(array_to_string(route_names, '・'), ''), road_name)`,
            ),
            roadSource.id,
          ]);
        }
        for (const source of lineSources) {
          await source.ensure();
          names.push([source.title, await fetchNearbyNames(conn, source, frame, 'name'), source.id]);
        }
        // 人口は**いちばん細かいメッシュ**で数える (粗いと範囲からはみ出す分が増える)。
        let population: { population: number; cells: number; label: string } | null = null;
        for (const source of [...meshSources].sort((a, b) => b.digits - a.digits)) {
          if (!source.bbox || !bboxOverlaps(source.bbox, frame.bounds)) continue;
          await source.ensure();
          const found = await fetchNearbyPopulation(conn, source, frame);
          if (found && found.cells > 0) {
            population = { ...found, label: MESH_SIZE_LABELS[source.digits] ?? `${source.digits}桁` };
            break;
          }
        }
        return { zoneGeometry, buildings, names, population };
      });
      if (token !== nearbyToken) return;

      await setSourceData('nearby-zone', result.zoneGeometry);
      // 建物は1棟ずつ段の色で塗るので、属性ごと FeatureCollection で渡す。
      nearbyDrawn = {
        buildings: result.buildings.flatMap((b) => b.features),
        // 線は種類 (駅・鉄道・道路・送電線・川) で塗り分け、種類ごとに切り替える。
        lines: result.names.flatMap(([kind, found, origin]) =>
          found.features.map((feature) => ({
            ...feature,
            properties: { ...feature.properties, kind, origin },
          })),
        ),
      };
      const hitSource = map.getSource('nearby-hits') as GeoJSONSource | undefined;
      await hitSource?.setData({ type: 'FeatureCollection', features: nearbyDrawn.buildings });
      const lineHits = map.getSource('nearby-hit-lines') as GeoJSONSource | undefined;
      await lineHits?.setData({ type: 'FeatureCollection', features: nearbyDrawn.lines });
      applyNearbyView();
      setNearbyFocus(nearbyFocusInput.checked);
      renderNearby(result, frame);
    } catch (e) {
      console.error('[nearby] failed', e);
      if (token === nearbyToken) nearbyResultsEl.textContent = '調べられませんでした';
    }
  };

  const renderNearby = (
    result: {
      buildings: NearbyBuildings[];
      names: [string, { names: string[]; total: number }, string][];
      population: { population: number; cells: number; label: string } | null;
    },
    frame: NearbyFrame,
  ) => {
    const list = document.createElement('dl');
    /**
     * 1種類ぶんの行。見出しに**地図に出すかのチェック** (`key` があるとき)、中身に件数と名前。
     * 件数は数字を大きく出して、名前は押せる札にする (押すとそれだけを残して寄る)。
     */
    const row = (term: string, key: string | null, ...value: (string | Node)[]) => {
      const dt = document.createElement('dt');
      if (key) {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !nearbyView.hidden.has(key);
        box.dataset.nearbyKind = key;
        box.title = '地図に出す';
        box.addEventListener('change', () => {
          if (box.checked) nearbyView.hidden.delete(key);
          else nearbyView.hidden.add(key);
          applyNearbyView();
        });
        label.append(box, term);
        dt.append(label);
      } else {
        dt.textContent = term;
      }
      const dd = document.createElement('dd');
      dd.append(...value);
      list.append(dt, dd);
    };
    const count = (n: number, unit: string) => {
      const strong = document.createElement('strong');
      strong.className = 'nearby-count';
      strong.textContent = `${n.toLocaleString()} ${unit}`;
      return strong;
    };
    /** 押せる名前の札。押すとそれだけを残して寄る (もう一度で戻る)。 */
    const chips = (kind: string, names: string[], rest: number): HTMLElement => {
      const box = document.createElement('div');
      box.className = 'nearby-chips';
      for (const name of names) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'nearby-chip';
        chip.textContent = name;
        chip.title = 'これだけを地図に残して寄る';
        const pressed = nearbyView.focus?.kind === kind && nearbyView.focus.name === name;
        chip.setAttribute('aria-pressed', String(pressed));
        chip.addEventListener('click', () => {
          focusNearby(kind, name);
          // 名前の札だけを戻す (段の札は出し入れの印なので触らない)。
          for (const other of nearbyResultsEl.querySelectorAll('.nearby-chip:not(.tier)')) {
            other.setAttribute('aria-pressed', 'false');
          }
          chip.setAttribute('aria-pressed', String(nearbyView.focus !== null));
        });
        box.append(chip);
      }
      if (rest > 0) {
        const more = document.createElement('span');
        more.className = 'nearby-more';
        more.textContent = `ほか${rest}件`;
        box.append(more);
      }
      return box;
    };
    /** 建物の段ごとの件数。押すと、その段を地図に出すかを切り替える。 */
    const tierToggles = (counts: [string, number][]): HTMLElement => {
      const box = document.createElement('div');
      box.className = 'nearby-chips';
      counts.forEach(([title, n], rank) => {
        if (n === 0) return;
        const key = `段:${title}`;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'nearby-chip tier';
        chip.dataset.rank = String(rank);
        chip.textContent = `${title} ${n.toLocaleString()}`;
        chip.title = 'この段を地図に出す / 隠す';
        chip.setAttribute('aria-pressed', String(!nearbyView.hidden.has(key)));
        chip.addEventListener('click', () => {
          if (nearbyView.hidden.has(key)) nearbyView.hidden.delete(key);
          else nearbyView.hidden.add(key);
          chip.setAttribute('aria-pressed', String(!nearbyView.hidden.has(key)));
          applyNearbyView();
        });
        box.append(chip);
      });
      return box;
    };

    if (result.buildings.length === 0 && buildingSources.length > 0) row('建物', null, 'なし');
    for (const found of result.buildings) {
      const group = collections.find((c) => c.id === found.source.id)?.group?.title;
      const total = found.counts.reduce((sum, [, n]) => sum + n, 0);
      const shown = found.named.slice(0, 10);
      row(
        `建物${group ? ` (${group})` : ''}`,
        '建物',
        count(total, '棟'),
        tierToggles(found.counts),
        ...(shown.length > 0 ? [chips('建物', shown, found.named.length - shown.length)] : []),
      );
    }
    for (const [label, { names, total }] of result.names) {
      if (total === 0) {
        row(label, null, 'なし');
        continue;
      }
      row(label, label, count(total, '件'), chips(label, names, total - names.length));
    }
    if (result.population) {
      row(
        '人口',
        null,
        count(Math.round(result.population.population), '人'),
        ` (概算。${result.population.label}メッシュ ${result.population.cells.toLocaleString()} 個の合計)`,
      );
    }
    const notes: string[] = [];
    if (result.population) {
      notes.push('人口は範囲に掛かるメッシュの値の合計なので、範囲より広い分を含みます。');
    }
    if (frame.clipped) {
      notes.push('起点が画面より大きいので、表示範囲の中だけを数えています。');
    }
    if (result.buildings.some((b) => b.features.length >= NEARBY_DRAW_LIMIT)) {
      notes.push(`地図に描く建物は${NEARBY_DRAW_LIMIT.toLocaleString()}件までです (数は全部)。`);
    }
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = notes.join(' ');
    nearbyResultsEl.replaceChildren(list, ...(notes.length > 0 ? [note] : []));
  };

  nearbyDistance.addEventListener('change', () => {
    if (currentOrigin) void runNearby(currentOrigin);
  });
  nearbyFromSearch.addEventListener('click', () => {
    if (!lastSelection) return;
    setNearbyMode(false);
    void runNearby(lastSelection);
  });
  document.querySelector('#nearby-close')!.addEventListener('click', clearNearby);

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

  // ---- 吹き出し (ホバーと、指で押したとき) ------------------------------------------
  //
  // **層ごとに「何を出すか」を表にし、地図全体で1つの仕掛けで拾う。** 以前は層ごとに
  // mousemove を登録していて、周辺検索の結果 (上に重ねた別の層) には吹き出しが出なかった
  // (当たった建物の上では元の建物を隠すので、建物の吹き出しも消えていた)。
  // いちばん上に描かれているものの吹き出しを出す。
  //
  // **指で押しても同じものを出す** (スマホにはホバーが無い)。

  type Props = Record<string, unknown>;
  type HoverRows = [string, string | null][];
  /** 吹き出しの中身と、**同じものか**の鍵 (同じなら作り直さない — 区間の境でちらつくため)。 */
  type Hover = { key: string; rows: HoverRows };

  const text = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));
  const originOf = (props: Props) => collections.find((c) => c.id === props.origin);

  /** 建物。**どちらの出所の建物か**も言う (PLATEAUとOvertureは同時に出せて、色だけでは見分けにくい)。 */
  const buildingRows = (props: Props): HoverRows => {
    const origin = originOf(props);
    return [
      ['', text(props.name) ?? '(名称なし)'],
      ['用途', text(props.category)],
      ['高さ', props.height ? `${props.height as number} m` : null],
      ['重要度', (props.tierRank as number | undefined) !== -1 ? text(props.tier) : null],
      ['出所', origin?.group?.title ?? origin?.title ?? null],
    ];
  };

  /** 周辺検索で当たったもの、と分かる1行。 */
  const nearbyRow = (): [string, string] => ['周辺検索', `起点から ${nearbyDistance.value} m 以内`];

  const HOVER_LAYERS: Record<string, (props: Props) => Hover> = {
    'nearby-hits': (p) => ({
      key: `nearby|${p.origin}|${p.name}|${p.height}|${p.category}`,
      rows: [...buildingRows(p), nearbyRow()],
    }),
    'nearby-hit-lines': (p) => {
      const origin = originOf(p);
      return {
        key: `nearby-line|${p.kind}|${p.name}`,
        rows: [
          ['', text(p.name) ?? '(名前なし)'],
          ['種類', text(p.kind)],
          ['出所', origin?.group?.title ?? null],
          ['時点', origin?.vintage ?? null],
          nearbyRow(),
        ],
      };
    },
    'buildings-3d': (p) => ({
      key: `building|${p.origin}|${p.name}|${p.height}|${p.category}`,
      rows: buildingRows(p),
    }),
    // 整備範囲のメッシュ。**どのメッシュか、どの自治体かが読めること。**
    // 塗りの濃さは埋まり具合しか表さないので、中身はここでしか分からない。
    'buildings-coverage-fill': (p) => {
      const code = p.code as string;
      const cities = (p.cities as string) || '(不明)';
      const filled = p.filled as number;
      const total = p.total as number;
      return {
        key: `cell|${code}`,
        rows: [
          ['', `${MESH_SIZE_LABELS[code.length] ?? `${code.length}桁`}メッシュ`],
          ['メッシュコード', code],
          // **束ねると自治体が増える。** 80kmまで引くと何十も並ぶので、多いときは数だけにする。
          ['自治体', cities.split('、').length > 6 ? `${cities.split('、').length} 市区町村` : cities],
          // **濃淡を数で裏付ける。** 1kmで見ているときは必ず1/1なので出さない。
          [
            'データのある1kmセル',
            total > 1
              ? `${filled.toLocaleString()} / ${total.toLocaleString()} (${Math.round((filled / total) * 100)}%)`
              : null,
          ],
          ['建物', `${(p.buildings as number).toLocaleString()} 棟`],
        ],
      };
    },
    // 駅なら駅名を見出しにする。路線には駅名が入っていない。
    'railway-station': (p) => railwayHover(p),
    'railway-line': (p) => railwayHover(p),
    // 道路は交差点ごとに区間が切れている。名前と路線と等級が同じなら同じ道として扱う。
    'road-line': (p) => {
      const routes = text(p.routeNames) ?? '';
      const name = text(p.roadName);
      return {
        key: `road|${name ?? ''}|${routes}|${p.roadClass}`,
        rows: [
          // 名前が無い区間もある。その場合は路線名を見出しに繰り上げる。
          ['', name || routes || '(名前なし)'],
          // **路線は複数あることがある。** 見出しに使ったものと同じなら繰り返さない。
          ['路線', routes && routes !== name ? routes : null],
          ['種別', text(p.roadClass)],
          ['時点', roadVintage ?? null],
        ],
      };
    },
    ...Object.fromEntries(
      LINE_KINDS.map((kind) => [
        `line-${kind}`,
        (p: Props): Hover => {
          const origin = originOf(p);
          return {
            key: `line|${kind}|${p.name ?? ''}|${p.lineClass}`,
            rows: [
              ['', text(p.name) ?? '(名前なし)'],
              ['種別', text(p.lineClass)],
              ['出所', origin?.group?.title ?? null],
              ['時点', origin?.vintage ?? null],
            ],
          };
        },
      ]),
    ),
  };

  function railwayHover(p: Props): Hover {
    const station = text(p.stationName);
    return {
      key: `rail|${station ?? ''}|${p.lineName}|${p.operator}`,
      rows: [
        ['', station ? `${station}駅` : text(p.lineName)],
        ['路線', station ? text(p.lineName) : null],
        ['事業者', text(p.operator)],
        ['種別', text(p.institutionType)],
        ['区分', text(p.railwayClass)],
        ['時点', railwayVintage ?? null],
      ],
    };
  }

  /** うちのデータ (と周辺検索の結果) で、その点のいちばん上にあるもの。 */
  const ownHoverAt = (point: { x: number; y: number }): Hover | null => {
    const ids = Object.keys(HOVER_LAYERS).filter((id) => map.getLayer(id));
    const top = map.queryRenderedFeatures([point.x, point.y], { layers: ids })[0];
    return top ? HOVER_LAYERS[top.layer.id](top.properties) : null;
  };

  /**
   * 外部のベクトルタイル (地理院)。描画の層が123あって表に書ききれないので、
   * その点にある地物から地理院の層のものを探す。**うちのデータが無いときだけ**使う。
   */
  const vectorHoverAt = (point: { x: number; y: number }): Hover | null => {
    if (vectorOverlays.length === 0) return null;
    for (const feature of map.queryRenderedFeatures([point.x, point.y])) {
      const overlay = vectorOverlays.find((o) => o.styleLayers.has(feature.layer.id));
      if (!overlay) continue;
      const sourceLayer = overlay.styleLayers.get(feature.layer.id)!;
      const props = feature.properties;
      const theme = overlay.collection.themes?.find((t) => t.layers.some((l) => l.id === sourceLayer));
      const layer = theme?.layers.find((l) => l.id === sourceLayer);
      return {
        key: `vector|${sourceLayer}|${props.vt_code ?? ''}|${props.vt_text ?? ''}`,
        rows: [
          ['', text(props.vt_text) ?? `${theme?.title ?? ''} › ${layer?.title ?? sourceLayer}`],
          ['層', `${layer?.title ?? sourceLayer} (${sourceLayer})`],
          // 地物の種別のコード。意味は配布元の「地物種別コード一覧」にある。
          ['種別コード', text(props.vt_code)],
          ['出所', `${overlay.collection.group?.title ?? ''} ${overlay.collection.title}`.trim()],
          ['時点', overlay.collection.vintage ?? null],
        ],
      };
    }
    return null;
  };

  let hoveredKey = '';
  const showHover = (lngLat: { lng: number; lat: number }, hover: Hover) => {
    hoverPopup.setLngLat(lngLat).addTo(map);
    if (hover.key === hoveredKey) return;
    hoveredKey = hover.key;
    hoverPopup.setDOMContent(hoverContent(hover.rows));
  };
  const hideHover = () => {
    if (!hoveredKey) return;
    hoveredKey = '';
    hoverPopup.remove();
  };

  map.on('mousemove', (e) => {
    // **判定中はホバーを出さない。** 判定の結果も吹き出しで出すので、
    // 2つ並ぶとどちらが押した場所のものか分からなくなる。
    if (picking) return;
    const own = ownHoverAt(e.point);
    hoveringFeature = own !== null;
    updateCursor();
    const hover = own ?? vectorHoverAt(e.point);
    if (hover) showHover(e.lngLat, hover);
    else hideHover();
  });
  map.getCanvas().addEventListener('mouseleave', () => {
    hoveringFeature = false;
    updateCursor();
    hideHover();
  });

  // **押したときも出す** (スマホ)。📍や◎で押した地点は、そちらが先に受け取って
  // 印を付ける (`preventDefault`)。何も無いところを押したら閉じる。
  map.on('click', (e) => {
    if (e.defaultPrevented || picking || nearbyMode) return;
    const hover = ownHoverAt(e.point) ?? vectorHoverAt(e.point);
    if (hover) {
      hoveredKey = '';
      showHover(e.lngLat, hover);
    } else {
      hideHover();
    }
  });

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
