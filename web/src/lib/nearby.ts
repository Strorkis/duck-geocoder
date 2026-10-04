/**
 * **周辺検索の問い合わせ** (DuckDB)。画面にも地図にも依存しない。
 *
 * **起点 (点・線・面) から○m以内に何があるか**を、カタログにあるデータ全部に聞く。
 * 画面に出しているかどうかは関係ない (出していないデータも数える)。
 * 用途を決め打ちしない汎用の部品で、「川沿い・送電線沿いに何があるか」も
 * 「この建物の周りに学校はあるか」も同じ問い合わせになる。
 */
import type * as duckdb from '@duckdb/duckdb-wasm';
import { tierExpression, type ItemFile } from './stac';
import {
  EXACT_LOD,
  filesInView,
  geometryBbox,
  lodFilter,
  type BuildingSource,
  type MeshSource,
  type ViewBounds,
} from './sources';

/** 周辺検索の起点。 */
export interface NearbyOrigin {
  /** 何を起点にしたか (「山手線」「地図上の点」など)。 */
  label: string;
  geometry: GeoJSON.Geometry;
  /** 起点が建物なら、その高さ (立体で強調するため)。 */
  height?: number | null;
}

/**
 * 距離を測るための座標の置き換え。**起点の近くの緯度でメートルに直す**
 * (`ST_Affine`)。経度1度の長さは緯度で変わるので、起点の中心の緯度で決める。
 * 1km以内なら平面とみなした誤差は小さい (東京で1kmにつき数m)。
 */
export interface NearbyFrame {
  /** `ST_Affine(… , sx, 0, 0, sy, ox, oy)` で度をメートルに直す。 */
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  /** 先に絞るための範囲 (起点の範囲を距離ぶん広げたもの。表示範囲で切ることがある)。 */
  bounds: ViewBounds;
  /** 表示範囲で切ったか。起点が画面より大きい (長い路線など) とき。 */
  clipped: boolean;
  /** 起点のジオメトリをメートルに直したSQLの式。 */
  origin: string;
  distance: number;
}

/**
 * 周辺検索の座標系と先に絞る範囲を決める。
 *
 * **起点が画面より大きいときは、表示範囲の中だけを数える。** 路線のように
 * 長いものを起点にすると、範囲が都市を丸ごと覆って建物を何百MBも読むことになる。
 */
export function nearbyFrame(origin: NearbyOrigin, distance: number, view: ViewBounds): NearbyFrame {
  const [west, south, east, north] = geometryBbox(origin.geometry);
  const lat0 = (south + north) / 2;
  const lon0 = (west + east) / 2;
  const sx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const sy = 110_540;
  const dx = distance / sx;
  const dy = distance / sy;
  const expanded = { west: west - dx, south: south - dy, east: east + dx, north: north + dy };
  const clipped =
    expanded.west < view.west ||
    expanded.east > view.east ||
    expanded.south < view.south ||
    expanded.north > view.north;
  const bounds: ViewBounds = clipped
    ? {
        west: Math.max(expanded.west, view.west),
        south: Math.max(expanded.south, view.south),
        east: Math.min(expanded.east, view.east),
        north: Math.min(expanded.north, view.north),
        centerLon: lon0,
        centerLat: lat0,
      }
    : { ...expanded, centerLon: lon0, centerLat: lat0 };
  const json = JSON.stringify(origin.geometry).replace(/'/g, "''");
  const frame = { sx, sy, ox: -lon0 * sx, oy: -lat0 * sy, bounds, clipped, distance };
  return { ...frame, origin: toMeters(frame, `ST_GeomFromGeoJSON('${json}')`) };
}

/** ジオメトリの式をメートルの座標に直す。 */
export function toMeters(
  frame: Pick<NearbyFrame, 'sx' | 'sy' | 'ox' | 'oy'>,
  expression: string,
): string {
  return `ST_Affine(${expression}, ${frame.sx}, 0, 0, ${frame.sy}, ${frame.ox}, ${frame.oy})`;
}

/** メートルの座標を度に戻す ([`toMeters`] の逆)。範囲の輪郭を地図に描くのに使う。 */
export function fromMeters(
  frame: Pick<NearbyFrame, 'sx' | 'sy' | 'ox' | 'oy'>,
  expression: string,
): string {
  return `ST_Affine(${expression}, ${1 / frame.sx}, 0, 0, ${1 / frame.sy}, ${-frame.ox / frame.sx}, ${-frame.oy / frame.sy})`;
}

/** 先に bbox で絞り、そのうえで距離で判定する WHERE の中身。 */
function nearbyCondition(frame: NearbyFrame): string {
  const b = frame.bounds;
  return `bbox.xmin <= ${b.east} AND bbox.xmax >= ${b.west}
      AND bbox.ymin <= ${b.north} AND bbox.ymax >= ${b.south}
      AND ST_DWithin(${toMeters(frame, 'geometry')}, ${frame.origin}, ${frame.distance})`;
}

/** 周辺の建物。段ごとの件数・名前のある建物・強調に使う形。 */
export interface NearbyBuildings {
  source: BuildingSource;
  /** 段の題名 → 件数。段の無い出所では「すべて」の1つ。 */
  counts: [string, number][];
  named: string[];
  features: GeoJSON.Feature[];
}

/** 強調に描く建物の上限。数えるのは全部だが、描くのはここまで。 */
export const NEARBY_DRAW_LIMIT = 3000;

export async function fetchNearbyBuildings(
  conn: duckdb.AsyncDuckDBConnection,
  source: BuildingSource,
  frame: NearbyFrame,
): Promise<NearbyBuildings | null> {
  const files = filesInView(source, frame.bounds);
  if (files.length === 0) return null;
  const list = files.map((file) => `'${file}'`).join(', ');
  const tier = source.tiers ? tierExpression(source.tiers) : `'all'`;
  const where = nearbyCondition(frame);
  const counted = await conn.query(`
    SELECT ${tier} AS tier, count(*) AS n,
      list(DISTINCT name) FILTER (name IS NOT NULL) AS names
    FROM read_parquet([${list}])
    WHERE ${where}
    GROUP BY 1;
  `);
  const rows = counted.toArray().map((row) => row.toJSON() as { tier: string; n: number | bigint; names: unknown });
  if (rows.length === 0) return null;
  const order = source.tiers?.tiers ?? [{ id: 'all', title: 'すべて', values: [] }];
  const counts = order.map(
    (t) => [t.title, Number(rows.find((r) => r.tier === t.id)?.n ?? 0)] as [string, number],
  );
  // 名前は重要な段から並べる (公共施設の名前が先に来る)。
  const named = order.flatMap((t) => {
    const row = rows.find((r) => r.tier === t.id);
    return row?.names ? Array.from(row.names as ArrayLike<unknown>, String) : [];
  });

  // 高さも取る。当たった建物は**立体で**描く (地面に塗るだけだと、立体の建物に埋もれる)。
  // 用途と出所も取る — 結果の上では元の建物を隠すので、**吹き出しはこちらで出す**。
  const height = source.hasHeight ? 'height' : 'NULL';
  const category = source.categoryColumn ?? 'NULL';
  const drawn = await conn.query(`
    SELECT ST_AsGeoJSON(geometry) AS geojson, name, ${tier} AS tier, ${height} AS height,
      ${category} AS category
    FROM read_parquet([${list}])
    WHERE ${where}
    LIMIT ${NEARBY_DRAW_LIMIT};
  `);
  const features = drawn.toArray().map((row) => {
    const r = row.toJSON() as {
      geojson: string;
      name: string | null;
      tier: string;
      height: number | null;
      category: string | null;
    };
    const rank = order.findIndex((t) => t.id === r.tier);
    return {
      type: 'Feature' as const,
      properties: {
        name: r.name,
        category: r.category,
        origin: source.id,
        tierRank: source.tiers ? rank : -1,
        // 種類ごとの表示の切り替えに使う (段の題名。段の無い出所は「すべて」)。
        tier: order[rank]?.title ?? 'すべて',
        height: r.height,
      },
      geometry: JSON.parse(r.geojson) as GeoJSON.Geometry,
    };
  });
  return { source, counts, named, features };
}

/**
 * 周辺にある線や点の名前 (重複なし)。駅・路線・道路・送電線・川で共通。
 * `nameExpression` は名前を作る式 (駅なら駅名と路線名など)。
 */
export async function fetchNearbyNames(
  conn: duckdb.AsyncDuckDBConnection,
  source: { files: ItemFile[]; coarseLodToleranceM?: number },
  frame: NearbyFrame,
  nameExpression: string,
  limit = 30,
): Promise<{ names: string[]; total: number; features: GeoJSON.Feature[] }> {
  const files = filesInView(source, frame.bounds);
  if (files.length === 0) return { names: [], total: 0, features: [] };
  const list = files.map((file) => `'${file}'`).join(', ');
  // 粗い段を持つファイルは原寸だけで判定する (粗い段は簡略化して位置がずれている)。
  const lod = source.coarseLodToleranceM !== undefined ? lodFilter(EXACT_LOD) : '';
  const result = await conn.query(`
    SELECT DISTINCT ${nameExpression} AS name
    FROM read_parquet([${list}])
    WHERE ${lod} ${nearbyCondition(frame)}
      AND (${nameExpression}) IS NOT NULL;
  `);
  const names = result.toArray().map((row) => String((row.toJSON() as { name: unknown }).name));
  names.sort((a, b) => a.localeCompare(b, 'ja'));
  // **当たった区間の形も返す** (地図で、結果だけを目立たせて描く)。名前の無いものも描く。
  // **範囲で切り取る** — 区間ごと描くと、鉄道や川は範囲の外まで長く伸びて、どこが
  // 当たったのかが読めない。範囲は起点付近のメートルで作って度へ戻す (検索と同じ)。
  const zone = fromMeters(frame, `ST_Buffer(${frame.origin}, ${frame.distance})`);
  const shapes = await conn.query(`
    SELECT ST_AsGeoJSON(ST_Intersection(geometry, ${zone})) AS g, ${nameExpression} AS name
    FROM read_parquet([${list}])
    WHERE ${lod} ${nearbyCondition(frame)}
    LIMIT ${NEARBY_DRAW_LIMIT};
  `);
  const features = shapes.toArray().map((row) => {
    const { g, name } = row.toJSON() as { g: string; name: string | null };
    return {
      type: 'Feature' as const,
      properties: { name },
      geometry: JSON.parse(g) as GeoJSON.Geometry,
    };
  });
  return { names: names.slice(0, limit), total: names.length, features };
}

/**
 * 周辺の人口。**範囲に掛かるメッシュの値の合計** なので、範囲より広い分を含む
 * (メッシュの一部だけ掛かっても、そのメッシュ全体の人口を数える)。概算として出す。
 */
export async function fetchNearbyPopulation(
  conn: duckdb.AsyncDuckDBConnection,
  source: MeshSource,
  frame: NearbyFrame,
): Promise<{ population: number; cells: number } | null> {
  const files = filesInView(source, frame.bounds);
  if (files.length === 0) return null;
  const list = files.map((file) => `'${file}'`).join(', ');
  const result = await conn.query(`
    SELECT coalesce(sum(population), 0) AS population, count(*) AS cells
    FROM read_parquet([${list}])
    WHERE ${nearbyCondition(frame)};
  `);
  const row = result.toArray()[0]?.toJSON() as { population: number | bigint; cells: number | bigint };
  return { population: Number(row.population), cells: Number(row.cells) };
}
