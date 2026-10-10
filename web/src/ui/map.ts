/**
 * **地図を作る部分と、データの描き方 (色・太さ)。**
 *
 * データの層 (建物・鉄道・道路…) は地図を作るときに全部足しておき、中身 (GeoJSON) を
 * 後から差し替える。重ね順は一覧が決める (ui/layer-list.ts の目印の層の直下に積む)。
 */
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  TerrainControl,
  type ExpressionSpecification,
} from 'maplibre-gl';
import type { Collection } from '../lib/stac';
import { LINE_KINDS, type LineKind } from '../lib/sources';
import { TERRAIN_SOURCE, baseStyle } from '../lib/tiles';
import { buildDataCredits, collapseAttribution, watchAttributionHeight } from './credits';
import { LAYER_ANCHORS } from './layer-list';
import { m } from '../i18n';

export const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

/** 線の見せ方。川は水色の実線、送電線は紫の破線 (道路・鉄道と見分けるため)。 */
export const LINE_STYLES: Record<LineKind, { color: string; width: number; dash: number[] | null }> = {
  power_line: { color: '#7b4fa0', width: 1.6, dash: [2, 1.5] },
  waterway: { color: '#3a8fd6', width: 1.8, dash: null },
};

/** 線の種別 (`class`) の呼び名。Overture の値はOSM由来の英語なので言い直す。 */
export const LINE_CLASS_LABELS: Readonly<Record<string, string>> = m.lineClassLabels;

/**
 * 道路の等級ごとの色と呼び名。**語彙はカタログから来る**ので、ここには
 * 見せ方だけを持つ (鉄道の事業者種別と同じ)。
 *
 * Overtureの `class` はOSM由来で、日本の制度とは1対1で対応しない。
 * 「おおよそ」と分かる書き方にしてある。
 */
export const ROAD_STYLES: Record<string, { label: string; color: string; width: number }> = {
  motorway: { label: m.roadMotorway, color: '#2f7d32', width: 3 },
  trunk: { label: m.roadTrunk, color: '#c2410c', width: 2.4 },
  primary: { label: m.roadPrimary, color: '#8a6d3b', width: 1.8 },
};

/**
 * 事業者種別ごとの色。**語彙はカタログから来る**ので、ここには色だけを持つ。
 *
 * 種別を選んだのは、5つしかなくて凡例に収まり、かつ
 * 「新幹線か在来線か」「公営か民営か」という運航側が気にする区別に近いため。
 * 鉄道区分 (普通鉄道/軌道/モノレールなど11種) は細かすぎて色では読めない。
 */
export const RAILWAY_COLORS: Record<string, string> = {
  JRの新幹線: '#c2185b',
  JR在来線: '#1565c0',
  公営鉄道: '#2e7d32',
  民営鉄道: '#ef6c00',
  第三セクター: '#6a1b9a',
};

/** 語彙に無い種別が来たときの色。カタログが増えても消えないようにする。 */
export const RAILWAY_FALLBACK_COLOR = '#616161';

/**
 * 建物の塗り (既定)。**高さで塗り分ける。** 傾けずに見るときも高さが分かるようにするため。
 * 高さを持たないデータ (Overtureはほぼ全件がそう) では既定色のままになる。
 *
 * **出所で色相を分ける。** PLATEAUとOvertureは同時に出せるので、
 * 重なったところでどちらの建物かが見分けられないと困る。
 * カタログで先頭の出所 (`palette` 0) が青、それ以外が橙。
 */
export const BUILDING_COLOR_BY_HEIGHT: ExpressionSpecification = [
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
export const BUILDING_COLOR_BY_TIER: ExpressionSpecification = [
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

/**
 * **引いた表示の建物のタイルの層** (出所ごとに1つ)。段で間引くズームでは GeoParquet を読まずに
 * これを描く (ui/layers/buildings.ts)。吹き出し (hover.ts) と一覧の重ね順 (main.ts) も見る。
 */
export const BUILDING_TILES_PREFIX = 'buildings-tiles/';
export const buildingTilesLayerId = (collectionId: string) => `${BUILDING_TILES_PREFIX}${collectionId}`;

/**
 * 建物の塗りの式を、タイルの層で使える形にする。**塗りの規則は1つに保つ** (`BUILDING_COLOR_BY_*`)。
 * GeoJSON の地物は出所の番号 (`palette`) と段の順位 (`tierRank`) を持つが、タイルの地物は持たない。
 * 出所の番号は層ごとに決まった値に、段の順位はタイルの `lod` (段の順位そのもの) に置き換える。
 */
export function tileColor(expression: ExpressionSpecification, palette: number): ExpressionSpecification {
  const replace = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    if (value.length === 2 && value[0] === 'get' && value[1] === 'palette') return palette;
    if (value.length === 2 && value[0] === 'get' && value[1] === 'tierRank') return ['get', 'lod'];
    return value.map(replace);
  };
  return replace(expression) as ExpressionSpecification;
}

/**
 * 地図を生成し、スタイルのロードとデータ・周辺検索・ハイライトの層の追加が終わるまで待つ。
 *
 * 出典表示はカタログから組み立てる。どのデータセットを配信するかはカタログ次第なので、
 * ここに書き並べると実際に使っているものとずれる。表示義務のある出典が抜けるのは
 * ライセンス違反になるため、データ側に追随させる。
 */
export function initMap(collections: Collection[]): Promise<MapLibreMap> {
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
  map.addControl(new AttributionControl({ compact: true, customAttribution: buildDataCredits(collections) }));
  collapseAttribution(map);
  watchAttributionHeight(map);
  // 建物を立体で描くので、傾きを操作する手段を出しておく。
  // visualizePitch を付けるとコンパスが傾きも表し、クリックで方位と傾きが
  // 0に戻る。つまり「2Dに戻す」手段が標準で付いてくるので、自前で切り替えUIを持たない。
  // 左上は検索欄、右下は出典表示があるので右上に置く。
  map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
  // 地形を切る手段。平野部では起伏が無く、タイルを読むだけになる場面もある。
  // 一覧の「地形」の行と同じもの (どちらで切っても、もう一方が追随する)。
  // 地図の上ですぐ切れるので残す。地形がカタログに無ければ出さない。
  const hasTerrain = collections.some((c) => c.kind === 'terrain' && c.tileLink);
  if (hasTerrain) map.addControl(new TerrainControl({ source: TERRAIN_SOURCE }), 'top-right');

  map.on('error', (e) => console.error('[map] error', e.error ?? e));

  return new Promise((resolve) => {
    map.on('load', () => {
      addDataLayers(map);
      addOverlayLayers(map);
      // 地形は最後に有効にする。ここまで来ていれば、以降タイルが取れなくても
      // 起伏が出ないだけで地図は使える。起動を外部サービスに握らせない。
      if (hasTerrain) map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: 1 });
      resolve(map);
    });
  });
}

/** 空の GeoJSON のソースを足す。中身は描く側が後から差し替える。 */
const emptySource = (map: MapLibreMap, id: string) =>
  map.addSource(id, { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });

/** 重ね順の目印 (描かない)。 */
const anchor = (map: MapLibreMap, id: string) =>
  map.addLayer({ id, type: 'background', layout: { visibility: 'none' } });

/**
 * データの層。**重ね順の目印の間に置く** — 地図タイルは `anchor/tiles` の直下、データは
 * `anchor/data` の直下に、一覧の順で積む (ui/layer-list.ts の applyOrder)。データは地図タイルより
 * 常に上、周辺検索とハイライトより下。ここでの並びは、一覧に足したときの既定の重なりと同じ。
 */
function addDataLayers(map: MapLibreMap): void {
  anchor(map, LAYER_ANCHORS.tile);

  // 人口メッシュは一番下に敷く。判断の背景であって、主役ではない。
  emptySource(map, 'population-mesh');
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

  // 送電線・川。道路の下に敷く (道路の方が細かく読まれるため)。
  // 種別ごとに1組。見せ方は `LINE_STYLES` (川は実線、送電線は破線)。
  for (const kind of LINE_KINDS) {
    const style = LINE_STYLES[kind];
    emptySource(map, `line-${kind}`);
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

  // 道路は人口メッシュの上、鉄道の下。**鉄道より下に敷く**のは、
  // 交差点で鉄道の方が見えてほしいため (踏切と立体交差の区別は付かないが、
  // 線路の連続性が切れる方が読みにくい)。
  emptySource(map, 'road');
  map.addLayer({
    id: 'road-line',
    type: 'line',
    source: 'road',
    // 色と太さは引くときに決めてしまう (`ROAD_STYLES`)。鉄道と同じ作り。
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.9 },
  });

  // 鉄道は人口メッシュの上、建物の下。メッシュの色が透けて読める濃さにする。
  emptySource(map, 'railway');
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
  emptySource(map, 'railway-stations');
  map.addLayer({
    id: 'railway-station-casing',
    type: 'line',
    source: 'railway-stations',
    paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 11] },
    layout: { 'line-cap': 'round' },
  });
  map.addLayer({
    id: 'railway-station',
    type: 'line',
    source: 'railway-stations',
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 7] },
    layout: { 'line-cap': 'round' },
  });

  // 建物。立体 (fill-extrusion) で描く。平面用と2枚持たないのは、傾き0度なら
  // 真上から見ることになり、平面塗りとほとんど同じに見えるため。
  // 2Dに戻したいときは NavigationControl のコンパスで傾きを0にする。
  emptySource(map, 'buildings');
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
  emptySource(map, 'buildings-coverage');
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
      'fill-opacity': ['interpolate', ['linear'], ['get', 'ratio'], 0, 0.12, 0.05, 0.18, 0.25, 0.26, 1, 0.36],
    },
  });
  map.addLayer({
    id: 'buildings-coverage-outline',
    type: 'line',
    source: 'buildings-coverage',
    // 縁は薄く。3万セルの縁を濃く引くと網目が潰れて塗りが読めない。
    paint: { 'line-color': '#4a6785', 'line-width': 1.5, 'line-opacity': 0.3 },
  });
  anchor(map, LAYER_ANCHORS.data);
}

/** データより上に描くもの: 周辺検索 (範囲・当たったもの・起点) と、検索のハイライト。 */
function addOverlayLayers(map: MapLibreMap): void {
  // 周辺検索の範囲 (起点から○m)。
  emptySource(map, 'nearby-zone');
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
  emptySource(map, 'nearby-hits');
  map.addLayer({
    id: 'nearby-hits',
    // **立体で描く。** 地面に塗るだけだと、立体の建物 (薄くしても) の中に埋もれて
    // 見えなかった。元の建物より少しだけ高くして、重なった面がちらつかないようにする。
    type: 'fill-extrusion',
    source: 'nearby-hits',
    // 重要度で色分けと同じ色。段の無い出所は橙。
    paint: {
      'fill-extrusion-color': ['match', ['get', 'tierRank'], 0, '#c0392b', 1, '#e09a3e', 2, '#8a94a0', '#ff6600'],
      'fill-extrusion-height': ['+', ['coalesce', ['get', 'height'], 3], 0.5],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.95,
    },
  });
  // 範囲に入った線 (駅・鉄道・道路・送電線・川)。種類ごとの色は一覧の線と揃える。
  emptySource(map, 'nearby-hit-lines');
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
  emptySource(map, 'nearby-origin');
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

  emptySource(map, 'highlight');
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
  emptySource(map, 'selected-point');
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
}
