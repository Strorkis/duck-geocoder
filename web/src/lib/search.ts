/**
 * **検索と逆ジオコーディングの問い合わせ** (DuckDB)。画面にも地図にも依存しない。
 *
 * 引く先は、初期化 (lib/duckdb.ts) が作るビュー: `admin` `admin_names` `isj_oaza`
 * `station` `section` `road_route` `road`。地名・駅・路線は検索するまでビューを作らない
 * (`ensureOaza` などを先に呼ぶ)。
 */
import type * as duckdb from '@duckdb/duckdb-wasm';
import type { Bbox } from './stac';
import { geometryOf } from './wkb';

/**
 * 検索結果。
 * - admin: 行政区域。面を持つので選択するとポリゴンをハイライトする。
 * - oaza:  大字・町丁目(位置参照情報)。代表点しか無いのでその地点へ飛ぶ。
 */
export type SearchResult =
  | { kind: 'admin'; label: string; adminId: string }
  | { kind: 'oaza'; label: string; lon: number; lat: number }
  // 駅。**人が実際に検索する語**なので、地名と並べて出す。
  | { kind: 'station'; label: string; detail: string; lon: number; lat: number }
  // 路線。点ではなく**範囲**なので、飛び先は fitBounds になる。
  // 線そのものは選んだときに読んでハイライトする (`lineName` / `operator` で引く)。
  | { kind: 'line'; label: string; detail: string; bbox: Bbox; lineName: string; operator: string }
  | { kind: 'route'; label: string; detail: string; bbox: Bbox; routeName: string };

/** 候補として表示する件数の上限 (行政区域と地名の合計)。 */
export const MAX_RESULTS = 10;

/**
 * 打った語そのものではない道路を、候補に出す上限。
 *
 * **道路は同じ語を含む路線が桁違いに多い。**「東京」には109路線が当たり、
 * 上限を掛けずに前へ出したときは候補10件をすべて道路が埋めて、
 * 東京駅も東京都も消えた。
 */
export const ROUTE_SUGGESTIONS = 3;

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * 「港区 芝公園」のように複数の要素が並んだ入力も拾えるよう、空白区切りの
 * トークンごとに「連結した住所」への部分一致をANDで取る条件式を組み立てる。
 * (列ごとの部分一致だと、候補選択後にinputへ入る連結文字列が何にも一致しない)
 */
export function buildMatchConditions(keyword: string, concatExpr: string): string {
  return keyword
    .split(/[\s　]+/)
    .filter((token) => token.length > 0)
    .map((token) => `${concatExpr} ILIKE '%${token.replace(/'/g, "''")}%'`)
    .join(' AND ');
}

export async function searchAddress(
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
 *
 * **運営会社まで入れないと壊れる。**「本線」は複数の会社が使う一般名で、
 * 駅名と路線名だけだと住吉駅 (兵庫と福岡) が同じ組になり、平均を取ると
 * **600km離れた中間点**に飛ぶ。実測で3組 (10,134組中) がこれに当たり、
 * 会社を足すと最大の広がりが1kmに収まる。
 *
 * 位置は **bboxの中心**。駅は点ではなく線 (ホームの延長) なので、
 * `bbox.xmin` をそのまま使うと端に寄る。
 */
export async function searchStations(
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
export async function searchLines(
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
 *
 * `classLabel` は等級の呼び名 (「国道」など)。見せ方は画面の側が持つ。
 */
export async function searchRoutes(
  conn: duckdb.AsyncDuckDBConnection,
  keyword: string,
  classLabel: (roadClass: string) => string,
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
      detail: `${classLabel(r.class)} · ${Number(r.segments).toLocaleString()} 区間`,
      bbox: [r.bbox.xmin, r.bbox.ymin, r.bbox.xmax, r.bbox.ymax] as Bbox,
      routeName: r.route_name,
    };
  });
}

/**
 * 区間の並びを1つのMultiLineStringにまとめる。ハイライト用。
 *
 * 1件も無ければ `null` を返す。空のMultiLineStringを入れると、
 * MapLibreが空のソースと区別できない。
 */
export function toMultiLineString(parts: GeoJSON.Geometry[]): GeoJSON.Geometry | null {
  const coordinates = parts.flatMap((part) =>
    part.type === 'LineString'
      ? [part.coordinates]
      : part.type === 'MultiLineString'
        ? part.coordinates
        : [],
  );
  return coordinates.length > 0 ? { type: 'MultiLineString', coordinates } : null;
}

/** ジオメトリの列 (GeoArrow の WKB) だけを返した結果を GeoJSON の並びに。 */
const geometries = (result: { toArray(): { toJSON(): unknown }[] }) =>
  result.toArray().map((row) => geometryOf((row.toJSON() as { geometry: unknown }).geometry));

/**
 * 選んだ路線の道路を読む。**ハイライトのためだけに、そのときだけ読む。**
 *
 * 範囲で絞るのは鉄道と同じ理由 (row groupの統計で読み飛ばさせる)。
 * **`list_contains` で当てる。** 1区間が複数の路線に属するのでリストになっている。
 */
export async function fetchRouteGeometry(
  conn: duckdb.AsyncDuckDBConnection,
  routeName: string,
  [west, south, east, north]: Bbox,
): Promise<GeoJSON.Geometry[]> {
  return geometries(
    await conn.query(`
      SELECT geometry
      FROM road
      WHERE list_contains(route_names, ${quote(routeName)})
        AND bbox.xmin <= ${east} AND bbox.xmax >= ${west}
        AND bbox.ymin <= ${north} AND bbox.ymax >= ${south};
    `),
  );
}

/**
 * 選んだ路線の線を読む。**ハイライトのためだけに、そのときだけ読む。**
 *
 * 範囲 (`bbox`) で絞るのは、row group の統計で読み飛ばさせるため。
 * 路線のファイルは5.2MB (ジオメトリ4.6MB) あるが、
 * 実測では山手線が65区間で8KB、東海道線でも493区間で140KB。
 */
export async function fetchLineGeometry(
  conn: duckdb.AsyncDuckDBConnection,
  lineName: string,
  operator: string,
  [west, south, east, north]: Bbox,
): Promise<GeoJSON.Geometry[]> {
  return geometries(
    await conn.query(`
      SELECT geometry
      FROM section
      WHERE line_name = ${quote(lineName)} AND operator = ${quote(operator)}
        AND bbox.xmin <= ${east} AND bbox.xmax >= ${west}
        AND bbox.ymin <= ${north} AND bbox.ymax >= ${south};
    `),
  );
}

/**
 * 逆ジオコーディング。指定した座標を含む行政区域を返す。
 *
 * ポリゴンとの包含判定 (ST_Contains) は重いので、先に bbox 列で候補を絞る。
 * bbox はGeoParquet生成時に書き込んである covering 列で、
 * これがあるおかげで全国データ (12万件) でも実用的な速度で返る。
 */
export async function reverseGeocode(
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

/** 行政区域の形 (飛び地や島は1つにまとめる) と範囲。 */
export async function fetchAdminPolygon(
  conn: duckdb.AsyncDuckDBConnection,
  adminId: string,
): Promise<{ geojson: GeoJSON.Geometry; bbox: Bbox } | null> {
  const result = await conn.query(`
    SELECT ST_Union_Agg(geometry) AS geometry,
           min(bbox.xmin) AS xmin, min(bbox.ymin) AS ymin,
           max(bbox.xmax) AS xmax, max(bbox.ymax) AS ymax
    FROM admin
    WHERE admin_id = ${quote(adminId)};
  `);
  const rows = result.toArray();
  if (rows.length === 0) return null;
  const row = rows[0].toJSON() as {
    geometry: unknown;
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  };
  // 当たる行が無いと、集約の結果は NULL の1行になる。
  if (row.geometry === null || row.geometry === undefined) return null;
  return {
    geojson: geometryOf(row.geometry),
    bbox: [row.xmin, row.ymin, row.xmax, row.ymax],
  };
}
