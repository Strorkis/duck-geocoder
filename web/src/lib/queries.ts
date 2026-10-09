/**
 * **表示範囲のデータを引く問い合わせ** (DuckDB)。画面にも地図にも依存しない。
 *
 * どれも同じ形をしている。
 * 1. 表示範囲に重なるファイルだけを渡す (`filesInView` — カタログを空間索引として使う)
 * 2. `bbox` の列で先に絞る (行グループの統計で読み飛ばさせる)
 * 3. 上限があるものは**画面中心に近い順**に取る (上限で切っても帯状に欠けない)
 *
 * 返すのは描くための素の値。色や呼び名は描く側 (main) が決める。
 *
 * **ジオメトリは列をそのまま返す** (GeoArrow の WKB)。SQL で GeoJSON の文字列にしてから
 * `JSON.parse` するより速い (lib/wkb.ts)。
 */
import type * as duckdb from '@duckdb/duckdb-wasm';
import { tierExpression } from './stac';
import { geometryOf } from './wkb';
import { meshBounds, meshCellCapacity } from './mesh';
import {
  filesInView,
  lodFilter,
  type BuildingCoverage,
  type BuildingSource,
  type LineSource,
  type MeshSource,
  type RailwaySource,
  type RoadSource,
  type ViewBounds,
} from './sources';

/** 表示範囲で絞る WHERE の中身。 */
function inView(bounds: ViewBounds): string {
  return `bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}
      AND bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}`;
}

/**
 * 画面中心に近い順の ORDER BY の中身。緯度方向と経度方向で1度あたりの距離が違うので、
 * 経度差を縮めてから比べる (東京付近では経度1度が緯度1度の約0.81倍)。並べ替えの順序だけの
 * 話なので、厳密な測地線距離までは要らない。
 */
function nearCenter(bounds: ViewBounds): string {
  const lonScale = Math.cos((bounds.centerLat * Math.PI) / 180);
  return `pow(((bbox.xmin + bbox.xmax) / 2 - ${bounds.centerLon}) * ${lonScale}, 2)
      + pow((bbox.ymin + bbox.ymax) / 2 - ${bounds.centerLat}, 2)`;
}

const fileList = (files: string[]) => files.map((file) => `'${file}'`).join(', ');
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

// ---- 送電線・川 ------------------------------------------------------------------

export interface LineFeature {
  geojson: GeoJSON.Geometry;
  name: string | null;
  lineClass: string;
}

/** 表示範囲の線を引く。道路 ([`fetchRoadsInView`]) と同じく、中心に近い順に上限まで。 */
export async function fetchLinesInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: LineSource,
  bounds: ViewBounds,
  limit: number,
  lod: number | undefined,
): Promise<LineFeature[]> {
  const files = filesInView(source, bounds);
  if (files.length === 0) return [];
  const result = await conn.query(`
    SELECT geometry, name, class
    FROM read_parquet([${fileList(files)}])
    WHERE ${lodFilter(lod)} ${inView(bounds)}
    ORDER BY ${nearCenter(bounds)}
    LIMIT ${limit};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as { geometry: unknown; name: string | null; class: string };
    return { geojson: geometryOf(r.geometry), name: r.name, lineClass: r.class };
  });
}

// ---- 道路 ------------------------------------------------------------------------

/** 道路1件分の表示用データ。 */
export interface RoadFeature {
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
 * 表示範囲に入る道路を取り出す。
 *
 * `class` はファイルが分かれているので、**選ばれていない等級のファイルは
 * そもそも読みに行かない** (これが class で分けている理由)。
 */
export async function fetchRoadsInView(
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
  const result = await conn.query(`
    SELECT geometry, road_name, class, route_names
    FROM read_parquet([${fileList(files)}])
    WHERE ${lodFilter(lod)} ${inView(bounds)}
    ORDER BY ${nearCenter(bounds)}
    LIMIT ${limit};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      geometry: unknown;
      road_name: string | null;
      class: string;
      route_names: unknown;
    };
    return {
      geojson: geometryOf(r.geometry),
      roadName: r.road_name,
      roadClass: r.class,
      // リスト列はArrowのVectorで返るので、素の配列に均す。
      routeNames: Array.from((r.route_names ?? []) as ArrayLike<unknown>, String),
    };
  });
}

// ---- 鉄道 ------------------------------------------------------------------------

/** 鉄道1件分の表示用データ。路線と駅で同じ形にしてある。 */
export interface RailwayFeature {
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
 * 表示範囲に入る鉄道を取り出す。
 *
 * 駅のファイルにしか `station_name` が無いので、SELECT する列を出所で変える。
 * 路線側で `station_name` を書くとスキーマに無い列で落ちる。
 */
export async function fetchRailwayInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: RailwaySource,
  bounds: ViewBounds,
  institutionTypes: string[] | null,
  limit: number,
  lod: number | undefined,
): Promise<RailwayFeature[]> {
  const files = filesInView(source, bounds);
  if (files.length === 0) return [];
  const conditions = [inView(bounds)];
  if (lod !== undefined) conditions.push(`lod = ${lod}`);
  if (institutionTypes) {
    // 建物の用途と同じく、1つも選ばれていなければ1件も出さない。
    const types = institutionTypes.map(quote).join(', ');
    conditions.push(types.length > 0 ? `institution_type IN (${types})` : 'false');
  }
  const stationSelect = source.kind === 'railway_station' ? 'station_name' : 'NULL';
  const result = await conn.query(`
    SELECT
      geometry,
      line_name, operator, institution_type, railway_class,
      ${stationSelect} AS station_name
    FROM read_parquet([${fileList(files)}])
    WHERE ${conditions.join('\n      AND ')}
    ORDER BY ${nearCenter(bounds)}
    LIMIT ${limit};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      geometry: unknown;
      line_name: string;
      operator: string;
      institution_type: string;
      railway_class: string;
      station_name: string | null;
    };
    return {
      geojson: geometryOf(r.geometry),
      lineName: r.line_name,
      operator: r.operator,
      institutionType: r.institution_type,
      railwayClass: r.railway_class,
      stationName: r.station_name,
    };
  });
}

// ---- 人口メッシュ ------------------------------------------------------------------

/** 集約したメッシュ1つ分。 */
export interface MeshCell {
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
export async function fetchMeshInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: MeshSource,
  bounds: ViewBounds,
  digits: number,
): Promise<MeshCell[]> {
  const files = filesInView(source, bounds);
  if (files.length === 0) return [];
  const result = await conn.query(`
    SELECT
      substr(mesh_code, 1, ${digits}) AS code,
      sum(population) AS population,
      max(density) AS density
    FROM read_parquet([${fileList(files)}])
    WHERE ${inView(bounds)}
      AND density IS NOT NULL
    GROUP BY code;
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      code: string;
      population: number | bigint | null;
      density: number;
    };
    return { code: r.code, population: Number(r.population ?? 0), density: r.density };
  });
}

// ---- 建物の整備範囲 ----------------------------------------------------------------

/** 整備範囲のセル1つ。 */
export interface CoverageCell {
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
export async function fetchCoverageInView(
  conn: duckdb.AsyncDuckDBConnection,
  coverage: BuildingCoverage,
  bounds: ViewBounds,
  digits: number,
): Promise<CoverageCell[]> {
  const files = filesInView(coverage, bounds);
  if (files.length === 0) return [];
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
    FROM read_parquet([${fileList(files)}])
    WHERE ${inView(bounds)}
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

/**
 * 表示範囲に整備範囲のセルが**1つでも**あるか。一覧の「この範囲には無い」の判定に使う。
 *
 * Collectionの収録範囲 (bbox) だけで決めると、PLATEAUは306都市の和が日本を
 * ほぼ覆う箱になり、山の中でも「ある」と出る。整備範囲は1kmのセルで持っているので、
 * そちらに聞けば**建物が1棟でもあるところだけ**を「ある」と言える。
 *
 * **1行見つかれば止める** (`LIMIT 1`)。セルを数えたり束ねたりしないので、
 * 描くための問い合わせ (`fetchCoverageInView`) より軽い。
 */
export async function coverageInView(
  conn: duckdb.AsyncDuckDBConnection,
  coverage: BuildingCoverage,
  bounds: ViewBounds,
): Promise<boolean> {
  const files = filesInView(coverage, bounds);
  if (files.length === 0) return false;
  const result = await conn.query(`
    SELECT 1 FROM read_parquet([${fileList(files)}])
    WHERE ${inView(bounds)}
    LIMIT 1;
  `);
  return result.numRows > 0;
}

/**
 * 整備範囲のメッシュをGeoJSONにする。
 *
 * **矩形はメッシュコードから計算する** (人口メッシュと同じ)。配られた
 * ジオメトリを使わないのは、コードを前から切って束ねたあとの大きさで描きたいため。
 *
 * **濃淡は充足率で付ける。** 建物の数で濃くすると人口密集部が濃くなるだけで、
 * 「整備されているか」とは別のものを見せてしまう。代わりに
 * **束ねたセルのうち何割にデータがあるか**で塗る。
 *
 * **沿岸のセルは決して100%にならない** — 海の子セルは元々データを持てない。
 * つまりこれは「整備率」ではなく**このセルの面積のうちデータがある割合**。
 */
export function coverageFeatureCollection(cells: CoverageCell[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cells.map(({ code, buildings, filled, cities }) => {
      const [west, south, east, north] = meshBounds(code);
      const total = meshCellCapacity(code.length);
      return {
        type: 'Feature',
        properties: { code, buildings, filled, total, ratio: filled / total, cities: cities.join('、') },
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

// ---- 建物 ------------------------------------------------------------------------

/** 建物1件分の表示用データ。 */
export interface BuildingFeature {
  geojson: GeoJSON.Geometry;
  name: string | null;
  /** 用途 (PLATEAU) または種別 (Overture)。出所によって語彙が違う。 */
  category: string | null;
  height: number | null;
  /** 重要度の段のID。出所が段を持たなければ null。 */
  tier: string | null;
}

/** 建物の絞り込み条件。PLATEAUのように属性が揃っている出所でだけ意味を持つ。 */
export interface BuildingFilter {
  /** 高さの下限 (m)。0なら絞らない。 */
  minHeight: number;
  /** 対象の用途。null なら絞らない。 */
  usages: string[] | null;
  /** 対象の重要度の段 (ID)。null なら絞らない。 */
  tiers: string[] | null;
}

/**
 * 表示範囲に入る建物を取り出す。
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
export async function fetchBuildingsInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: BuildingSource,
  bounds: ViewBounds,
  filter: BuildingFilter,
  limit: number,
  /** 間引くときの段の上限 (この順位まで出す)。`undefined` なら全部。 */
  maxRank?: number,
): Promise<BuildingFeature[]> {
  // 表示範囲に重なるファイルだけを渡す。重なるものが無ければ問い合わせない。
  // **間引くときは概観を読む** (要る段がすべて入っているとき)。元のファイルを開く往復が、
  // 都道府県・QuadKey ごとの数ファイルで済む。
  const overview =
    maxRank !== undefined &&
    source.overviews.length > 0 &&
    source.overviews.every(({ lodMax }) => lodMax !== null && lodMax >= maxRank);
  const files = filesInView(overview ? { files: source.overviews } : source, bounds);
  if (files.length === 0) return [];

  // 絞り込みは **SQLに渡す**。取得後にJavaScript側で捨てると、
  // 読む量も転送する量も減らないため。
  const conditions = [inView(bounds)];
  // **段の列で間引く。** 段ごとに行グループが分かれているので、統計で読み飛ばせる。
  if (maxRank !== undefined && source.tiers?.lod_column) {
    conditions.unshift(`${source.tiers.lod_column} <= ${maxRank}`);
  }
  if (source.hasHeight && filter.minHeight > 0) {
    conditions.push(`height >= ${filter.minHeight}`);
  }
  if (source.categoryColumn && filter.usages) {
    // 用途が1つも選ばれていなければ1件も出さない (空のINは常に偽)。
    const list = filter.usages.map(quote).join(', ');
    conditions.push(list.length > 0 ? `${source.categoryColumn} IN (${list})` : 'false');
  }
  // 段は規則から求める式。絞るときも同じ式を条件にする (列が無いので)。
  const tierSelect = source.tiers ? tierExpression(source.tiers) : 'NULL';
  if (source.tiers && filter.tiers) {
    const list = filter.tiers.map(quote).join(', ');
    conditions.push(list.length > 0 ? `(${tierSelect}) IN (${list})` : 'false');
  }
  const categorySelect = source.categoryColumn ?? 'NULL';

  const result = await conn.query(`
    SELECT geometry, name, ${categorySelect} AS category, height,
      ${tierSelect} AS tier
    FROM read_parquet([${fileList(files)}])
    WHERE ${conditions.join('\n      AND ')}
    ORDER BY ${nearCenter(bounds)}
    LIMIT ${limit};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      geometry: unknown;
      name: string | null;
      category: string | null;
      height: number | null;
      tier: string | null;
    };
    return {
      geojson: geometryOf(r.geometry),
      name: r.name,
      category: r.category,
      height: r.height,
      tier: r.tier,
    };
  });
}
