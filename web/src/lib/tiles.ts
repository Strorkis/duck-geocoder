/**
 * **地図タイル** (背景地図・地形・外部のベクタータイル) を MapLibre に載せる部品。
 * 一覧や画面には依存しない (どの行を出すかは呼ぶ側が決める)。
 *
 * **背景地図と地形もカタログから来る。** 以前は URL をコードに書いていて、どこの何を
 * 使っているか (出所・使う条件) が画面から見えなかった。いまは国土地理院の
 * 地図タイル (`raster_tiles`) と標高 (`terrain`) が Collection として載っていて、
 * タイルは web-map-links 拡張のリンク (`rel: "xyz"` / `"tilejson"`) で指される。
 * 範囲 (`duck:zoom`) も地図ごとにカタログが持つ (白地図はズーム5〜14しか無い)。
 *
 * 地形 (Mapterhorn) の日本のソースは基盤地図情報 (数値標高モデル)。測量法の使用承認は
 * Mapterhorn 側が取得していて、番号はカタログの出典に書いてある。
 * PLATEAUのCityGMLにも地形モデル (TINRelief) が同梱されているが、5mグリッドを
 * 三角形に割っただけで、表示のためにラスタへ焼く意味が無いので使わない (data-sources.md)。
 */
import {
  addProtocol,
  type ExpressionSpecification,
  type LayerSpecification,
  type MapLibreMap,
  type RasterDEMSourceSpecification,
  type RasterSourceSpecification,
  type StyleSpecification,
} from 'maplibre-gl';
import { Protocol as PmtilesProtocol } from 'pmtiles';
import type { Collection, DatasetKind, VectorLayerInfo } from './stac';
import { m } from '../i18n';

/** 背景地図の地図上の ID (ソースと層で同じ)。 */
export const basemapLayerId = (collection: Collection) => `basemap/${collection.id}`;
/** 地形のソース ID。TerrainControl もこれを見る。 */
export const TERRAIN_SOURCE = 'terrain';

/** `pmtiles://` を MapLibre に教える。**1回だけ** (2回登録すると後のものが勝つだけだが無駄)。 */
let pmtilesRegistered = false;
function registerPmtiles() {
  if (pmtilesRegistered) return;
  addProtocol('pmtiles', new PmtilesProtocol().tile);
  pmtilesRegistered = true;
}

/** テーマの見え方。色は1つで、形 (面・線・点) で描き分ける。 */
interface VectorLook {
  color: string;
  /** 線を破線にするか (境界・送電線)。 */
  dash?: number[];
}

/**
 * テーマごとの色。**見え方は UI の持ち物**なので、カタログには書かない。
 * 知らないテーマは既定の色で描く (テーマが増えても描けなくはならない)。
 */
const VECTOR_THEME_LOOKS: Record<string, VectorLook> = {
  anno: { color: '#333333' },
  road: { color: '#b8733e' },
  rail: { color: '#555555' },
  building: { color: '#8c7b6b' },
  water: { color: '#3b7dd8' },
  terrain: { color: '#a0794f' },
  boundary: { color: '#8b4fa8', dash: [3, 2] },
  structure: { color: '#7a7a7a' },
  power: { color: '#d19a00', dash: [4, 2] },
};
const DEFAULT_VECTOR_LOOK: VectorLook = { color: '#666666' };

/** 標高のエンコードの呼び名。 */
export const DEM_ENCODING_LABELS: Record<string, string> = {
  terrarium: 'Terrarium (Mapzen)',
  mapbox: 'Terrain-RGB (Mapbox)',
  gsi: m.demGsi,
};

/** 高さの基準の呼び名。 */
export const DEM_VERTICAL_LABELS: Record<string, string> = {
  orthometric: m.verticalOrthometric,
  ellipsoid: m.verticalEllipsoid,
};

/** 形の種類の呼び名。 */
export const GEOMETRY_LABELS: Record<string, string> = {
  Point: m.geometryPoint,
  LineString: m.geometryLine,
  Polygon: m.geometryPolygon,
};

/**
 * タイルの層1つを描く地図の層。**カタログに書いた形の種類だけから決める**
 * (面は塗りと輪郭、線は線、文字を持つ点は文字、それ以外の点は丸)。
 *
 * 配布元の描き方 (地理院の `std.json`) は使わない。規約が明示しているのはタイル
 * (データ) で、スタイル・記号・フォントの扱いは書かれていないため。
 * 文字はブラウザのフォントで描く (`glyphs` を指定しなければ MapLibre がそうする)。
 */
function vectorLayerSpecs(
  source: string,
  layer: VectorLayerInfo,
  look: VectorLook,
): LayerSpecification[] {
  const base = {
    source,
    'source-layer': layer.id,
    // 入れるまでは出さない。入り切りは `VectorOverlay.apply` が写す。
    layout: { visibility: 'none' as const },
  };
  const id = (suffix: string) => `${source}/${layer.id}/${suffix}`;
  const width: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 8, 0.4, 16, 1.6];
  switch (layer.geometry) {
    case 'Polygon':
      return [
        { ...base, id: id('fill'), type: 'fill', paint: { 'fill-color': look.color, 'fill-opacity': 0.2 } },
        {
          ...base,
          id: id('outline'),
          type: 'line',
          paint: { 'line-color': look.color, 'line-width': 0.6, 'line-opacity': 0.6 },
        },
      ];
    case 'LineString':
      return [
        {
          ...base,
          id: id('line'),
          type: 'line',
          paint: {
            'line-color': look.color,
            'line-width': width,
            'line-opacity': 0.8,
            ...(look.dash ? { 'line-dasharray': look.dash } : {}),
          },
        },
      ];
    default:
      if (layer.fields.includes('vt_text')) {
        return [
          {
            ...base,
            id: id('text'),
            type: 'symbol',
            layout: {
              ...base.layout,
              'text-field': ['get', 'vt_text'],
              'text-font': ['sans-serif'],
              'text-size': 11,
            },
            paint: {
              'text-color': look.color,
              'text-halo-color': 'rgba(255, 255, 255, 0.9)',
              'text-halo-width': 1.2,
            },
          },
        ];
      }
      return [
        {
          ...base,
          id: id('point'),
          type: 'circle',
          paint: { 'circle-color': look.color, 'circle-radius': 2.5, 'circle-opacity': 0.8 },
        },
      ];
  }
}

/**
 * **外部のベクトルタイルを重ねる。** 層ごとに入り切りできる。
 *
 * 描き方は**カタログに書いた形の種類から自前で決める** ([`vectorLayerSpecs`])。
 * 配布元のスタイルは読まない — データだけで描けることが、置き方 (STAC + PMTiles) の確かめになる。
 *
 * **入り切りの状態はここが持ち、ズームでは変えない。** 地理院地図Vectorはズームで
 * 出る層が変わると絞り込みが戻ってしまい、使いにくかった。描かれるかどうかは
 * タイルの側 (その層が入っているズーム) が決めるので、こちらは「出したいか」だけを持つ。
 *
 * 何も出さないうちは**何も読まない** (スタイルもタイルも)。最初に入れたときに読む。
 */
export interface VectorOverlay {
  collection: Collection;
  /** タイルの層ID → 出すか。 */
  visible: Map<string, boolean>;
  /** 状態を地図に写す。初めて何かを出すときにスタイルを読む。 */
  apply: () => Promise<void>;
  /** 地図の描画の層ID → タイルの層ID。ホバーで使う。 */
  styleLayers: Map<string, string>;
  /** タイルの層を描く地図の層ID (重ね順を並べ替えるため)。まだ読んでいなければ空。 */
  layerIds: (sourceLayers: string[]) => string[];
}

export function createVectorOverlay(
  map: MapLibreMap,
  collection: Collection,
  beforeId: string,
): VectorOverlay {
  const visible = new Map<string, boolean>();
  for (const theme of collection.themes ?? []) {
    for (const layer of theme.layers) visible.set(layer.id, false);
  }
  /** タイルの層ID → それを描く地図の層ID。 */
  const bySourceLayer = new Map<string, string[]>();
  const styleLayers = new Map<string, string>();
  let loading: Promise<void> | undefined;

  const load = async () => {
    const tiles = collection.assets.data?.href;
    if (!tiles) throw new Error(`${collection.id}: タイルのアセットがありません`);
    registerPmtiles();

    const sourceId = collection.id;
    map.addSource(sourceId, { type: 'vector', url: `pmtiles://${tiles}` });
    for (const theme of collection.themes ?? []) {
      const look = VECTOR_THEME_LOOKS[theme.id] ?? DEFAULT_VECTOR_LOOK;
      for (const layer of theme.layers) {
        const ids = vectorLayerSpecs(sourceId, layer, look).map((spec) => {
          // **うちのデータより下に敷く。** 重ねて見るための背景寄りのもので、主役はGeoParquet側。
          map.addLayer(spec, map.getLayer(beforeId) ? beforeId : undefined);
          styleLayers.set(spec.id, layer.id);
          return spec.id;
        });
        bySourceLayer.set(layer.id, ids);
      }
    }
  };

  const apply = async () => {
    const anyVisible = [...visible.values()].some(Boolean);
    if (!loading) {
      if (!anyVisible) return;
      loading = load();
    }
    await loading;
    for (const [sourceLayer, ids] of bySourceLayer) {
      const value = visible.get(sourceLayer) ? 'visible' : 'none';
      for (const id of ids) map.setLayoutProperty(id, 'visibility', value);
    }
  };

  const layerIds = (sourceLayers: string[]) => sourceLayers.flatMap((id) => bySourceLayer.get(id) ?? []);

  return { collection, visible, apply, styleLayers, layerIds };
}

/**
 * 背景地図のソース。**範囲 (ズーム) はカタログの `duck:zoom`** — 無いズームを要求すると
 * 404を撃ち続ける (白地図は5〜14)。出典はカタログ由来の出典表示が出すので、ここでは付けない。
 */
function basemapSource(collection: Collection): RasterSourceSpecification {
  return {
    type: 'raster',
    tiles: [collection.tileLink!.href],
    tileSize: collection.tileSize ?? 256,
    minzoom: collection.zoom?.[0] ?? 0,
    maxzoom: collection.zoom?.[1] ?? 18,
  };
}

/**
 * 同じ役割 (背景地図・地形) の中で**既定に使うもの**。カタログの `duck:default` が示す
 * (並び順に頼ると、サブカタログの順で変わる — 地理院が Mapterhorn より先に並ぶ)。
 * 示されていなければ先頭。
 */
export function defaultOf(collections: Collection[], kind: DatasetKind): Collection | undefined {
  const candidates = collections.filter((c) => c.kind === kind && c.tileLink);
  return candidates.find((c) => c.isDefault) ?? candidates[0];
}

/**
 * 地形 (標高) のソース。カタログのリンクが TileJSON なら、タイルのURL・エンコードは
 * TileJSON から読ませる (個別に書き写すと、向こうが変えたときに黙ってずれる)。
 * **範囲はカタログの `duck:zoom`** — Mapterhorn の TileJSON は maxzoom を宣言していないが、
 * 実際は z16 までしか無い (止めないと建物を見るズームで404を撃ち続ける)。
 */
export function terrainSource(collection: Collection): RasterDEMSourceSpecification {
  const link = collection.tileLink!;
  if (link.rel === 'tilejson') {
    return { type: 'raster-dem', url: link.href, maxzoom: collection.zoom?.[1] ?? 16 };
  }
  // 地理院の独自形式は、読み込むときに Terrarium へ詰め直す ([`registerGsiDem`])。
  const gsi = collection.demEncoding === 'gsi';
  if (gsi) registerGsiDem();
  return {
    type: 'raster-dem',
    tiles: [gsi ? `${GSI_DEM_PROTOCOL}://${link.href}` : link.href],
    tileSize: collection.tileSize ?? 256,
    minzoom: collection.zoom?.[0] ?? 0,
    maxzoom: collection.zoom?.[1] ?? 14,
    encoding: collection.demEncoding === 'mapbox' ? 'mapbox' : 'terrarium',
  };
}

/** 地理院の標高タイルを Terrarium に詰め直して渡す、MapLibre の取得の仕組み。 */
const GSI_DEM_PROTOCOL = 'gsidem';
let gsiDemRegistered = false;

/**
 * 地理院の標高を1画素ずつ高さ (m) に直す。**独自の形式**で、線形の部分は Terrain-RGB と
 * 同じ形 (x = R×2¹⁶ + G×2⁸ + B、高さ = x × 0.01 m) だが、そのままでは読めない値が2つある:
 *
 * - **値なし** (x = 2²³ = (128,0,0)。海など): そのまま読むと 83,886 m の針が立つ → 0 m にする
 * - **負の値** (x > 2²³、2の補数): そのまま読むと 8万m台に化ける → (x − 2²⁴) × 0.01 m
 */
export function gsiDemHeight(r: number, g: number, b: number): number {
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return 0;
  return (x < 8388608 ? x : x - 16777216) * 0.01;
}

/** 高さ (m) を Terrarium の画素にする (高さ = R×256 + G + B/256 − 32768)。 */
export function terrariumPixel(height: number): [number, number, number] {
  const v = Math.max(0, height + 32768);
  const r = Math.floor(v / 256);
  const g = Math.floor(v) % 256;
  const b = Math.floor((v - Math.floor(v)) * 256);
  return [r, g, b];
}

function registerGsiDem() {
  if (gsiDemRegistered) return;
  gsiDemRegistered = true;
  /** 無いタイル (404。日本の外や海) は 0 m の平らなタイルにする。1枚だけ作って使い回す。 */
  let flat: Promise<ArrayBuffer> | undefined;
  const flatTile = () =>
    (flat ??= (async () => {
      const canvas = new OffscreenCanvas(256, 256);
      const ctx = canvas.getContext('2d')!;
      const [r, g, b] = terrariumPixel(0);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(0, 0, 256, 256);
      return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
    })());
  addProtocol(GSI_DEM_PROTOCOL, async (params, abortController) => {
    const url = params.url.slice(`${GSI_DEM_PROTOCOL}://`.length);
    const response = await fetch(url, { signal: abortController.signal });
    if (response.status === 404) return { data: await flatTile() };
    if (!response.ok) throw new Error(`標高タイルを読めません (${response.status}): ${url}`);
    // **色を変えずに読む** (色空間の変換や乗算済みアルファが入ると、値が狂う)。
    const bitmap = await createImageBitmap(await response.blob(), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const pixels = image.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = terrariumPixel(gsiDemHeight(pixels[i], pixels[i + 1], pixels[i + 2]));
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return { data: await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer() };
  });
}

/**
 * 地図の土台。**背景地図と地形のソースはカタログから組む。**
 *
 * 背景地図はすべて層まで作っておき、**既定のもの (淡色地図) だけを出す**
 * (出していない層はタイルを読まない)。重ね順は一覧の並びで決まる (`applyTileOrder`)。
 */
export function baseStyle(collections: Collection[]): StyleSpecification {
  const basemaps = collections.filter((c) => c.kind === 'raster_tiles' && c.tileLink);
  const terrain = defaultOf(collections, 'terrain');
  const firstBasemap = defaultOf(collections, 'raster_tiles');
  const sources: StyleSpecification['sources'] = {};
  for (const collection of basemaps) sources[basemapLayerId(collection)] = basemapSource(collection);
  if (terrain) sources[TERRAIN_SOURCE] = terrainSource(terrain);
  return {
    version: 8,
    sources,
    // **下から上の順。** 既定の背景地図だけを出す。
    layers: [...basemaps].reverse().map((collection) => ({
      id: basemapLayerId(collection),
      type: 'raster' as const,
      source: basemapLayerId(collection),
      layout: { visibility: collection === firstBasemap ? ('visible' as const) : ('none' as const) },
    })),
    // ここに terrain を書かないこと。スタイルに書くと地形タイルの取得が
    // map の 'load' の条件に入り、**Mapterhornが落ちていると起動できなくなる**
    // (読み込み中の表示から進まない)。読み込み後に setTerrain で有効にする。
  };
}
