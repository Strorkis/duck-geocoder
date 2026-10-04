/**
 * **データの出所** (GeoParquet のファイル群) と、表示範囲から読むファイルを選ぶ部品。
 * 問い合わせ (DuckDB) からも画面からも使う。地図には依存しない。
 */
import type { Bbox, ItemFile, Tiers } from './stac';

/** 地図の表示範囲。 */
export interface ViewBounds {
  west: number;
  south: number;
  east: number;
  north: number;
  /** 画面中心。傾けると bounds の中心とはずれるので、地図から直接もらう。 */
  centerLon: number;
  centerLat: number;
}

/** 複数の範囲を包む範囲。データセットが分割されていても1つに畳める。 */
export function unionBbox(boxes: Bbox[]): Bbox | null {
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

/** 収録範囲が表示範囲と重なるか。 */
export function bboxOverlaps([west, south, east, north]: Bbox, bounds: ViewBounds): boolean {
  return (
    west <= bounds.east && east >= bounds.west && south <= bounds.north && north >= bounds.south
  );
}

/** 表示範囲に重なるファイル。**重ならないファイルは読まない** (行グループの統計より手前で落とす)。 */
export function filesInView(
  source: { files: ItemFile[] },
  bounds: ViewBounds,
): string[] {
  const overlapping = source.files.filter(
    // 収録範囲が分からないファイルは落とさない (判断材料が無いので読む)。
    ({ bbox }) => !bbox || bboxOverlaps(bbox, bounds),
  );
  return overlapping.map(({ file }) => file);
}

/** GeoJSON の座標を全部たどって範囲を返す。 */
export function geometryBbox(geometry: GeoJSON.Geometry): Bbox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (value: unknown): void => {
    if (Array.isArray(value) && typeof value[0] === 'number') {
      const [x, y] = value as number[];
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, y);
      north = Math.max(north, y);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    }
  };
  if (geometry.type === 'GeometryCollection') {
    for (const part of geometry.geometries) {
      const [w, s, e, n] = geometryBbox(part);
      west = Math.min(west, w);
      south = Math.min(south, s);
      east = Math.max(east, e);
      north = Math.max(north, n);
    }
  } else {
    visit(geometry.coordinates);
  }
  return [west, south, east, north];
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
export interface BuildingSource {
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
  /** 重要度の段の規則 (カタログの `duck:tiers`)。無ければ段で絞れない。用途を問わない部品。 */
  tiers: Tiers | undefined;
}

/**
 * 整備範囲のメッシュ。[`BuildingSource.coverage`] が持つ。
 *
 * **1kmで配られている。** 粗くするのはコードを前から切るだけで済む
 * (人口メッシュと同じ仕組み)。
 */
export interface BuildingCoverage {
  files: ItemFile[];
  /** 配られている細かさ (メッシュコードの桁数)。これより細かくはできない。 */
  meshDigits: number;
  ensure: () => Promise<void>;
}

/**
 * 鉄道 (国土数値情報 N02)。路線と駅で列構成が違うので別のCollectionになっている。
 *
 * **駅のジオメトリも線**。原典がホームの延長を線で持っているので、点ではない。
 */
export interface RailwaySource {
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
export interface RoadSource {
  id: string;
  bbox: Bbox | null;
  files: ItemFile[];
  /** 粗い段の許容誤差 (メートル)。段が無ければ undefined。 */
  coarseLodToleranceM: number | undefined;
  ensure: () => Promise<void>;
}

/** 名前と種別だけを持つ線の種類。 */
export type LineKind = 'power_line' | 'waterway';

/**
 * 名前と種別だけを持つ線 (送電線・川)。**道路と違って等級の絞り込みを持たない。**
 * 粗い段の切り替え・一覧の行・ホバーは道路と同じ仕組みを使う。
 */
export interface LineSource {
  id: string;
  kind: LineKind;
  title: string;
  bbox: Bbox | null;
  files: ItemFile[];
  /** 粗い段の許容誤差 (メートル)。段が無ければ undefined。 */
  coarseLodToleranceM: number | undefined;
  ensure: () => Promise<void>;
}

/**
 * 人口メッシュの出所。**SORAの地上リスクを見るためのもの。**
 *
 * 建物と違って「引いた状態で見たい」データなので、ズームに応じて
 * メッシュを粗くして出す (`meshDigits`)。
 */
export interface MeshSource {
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
export function meshSourceFor(sources: MeshSource[], digits: number): MeshSource | undefined {
  return sources
    .filter((source) => source.digits >= digits)
    .sort((a, b) => a.digits - b.digits)[0];
}

/** 粗い段 (`lod = 0`)。統合して簡略化した行。 */
export const COARSE_LOD = 0;
/** 原寸 (`lod = 1`)。元の行がそのまま入っている。 */
export const EXACT_LOD = 1;

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
export function coarseLodUntilZoom(toleranceM: number): number {
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
export function lodForZoom(
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
export function lodFilter(lod: number | undefined): string {
  return lod === undefined ? '' : `lod = ${lod} AND`;
}

/**
 * いま粗い段を見ているのかを画面で断る文。
 *
 * **黙って簡略化したものを見せない。** 引いた表示では統合して簡略化した線が
 * 出ているので、そう書いておかないと区間数が急に減ったように見える。
 * どのズームで原寸に切り替わるかも一緒に言う。
 */
export function lodNote(
  source: { coarseLodToleranceM: number | undefined },
  lod: number | undefined,
): string {
  if (source.coarseLodToleranceM === undefined || lod !== COARSE_LOD) return '';
  const until = coarseLodUntilZoom(source.coarseLodToleranceM);
  return ` · 簡略表示 (ズーム${until + 1}から原寸)`;
}

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
export function sourceLodNote(
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
