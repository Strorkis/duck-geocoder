/**
 * 線を四角で切り取る。周辺検索で、**長い線の押した地点の前後だけ**を起点にするのに使う
 * (路線全体を起点にすると、沿線の建物を丸ごと読むことになる)。地図にも DuckDB にも依存しない。
 */
import type { Bbox } from './stac';

/** 点の周り (半径 m の四角) を度で返す。経度1度の長さは緯度で変わるので、その点の緯度で決める。 */
export function aroundBox(point: { lng: number; lat: number }, meters: number): Bbox {
  const dLon = meters / (111_320 * Math.cos((point.lat * Math.PI) / 180));
  const dLat = meters / 110_540;
  return [point.lng - dLon, point.lat - dLat, point.lng + dLon, point.lat + dLat];
}

/**
 * 線 (LineString / MultiLineString) を四角で切り取る。四角の中に何も残らなければ null。
 * 線以外はそのまま返す。切り取った部分は途切れたところで別の線に分ける。
 */
export function clipLines(geometry: GeoJSON.Geometry, box: Bbox): GeoJSON.Geometry | null {
  const lines =
    geometry.type === 'LineString'
      ? [geometry.coordinates]
      : geometry.type === 'MultiLineString'
        ? geometry.coordinates
        : null;
  if (lines === null) return geometry;
  const out: GeoJSON.Position[][] = [];
  for (const line of lines) {
    let current: GeoJSON.Position[] = [];
    for (let i = 1; i < line.length; i++) {
      const segment = clipSegment(line[i - 1], line[i], box);
      if (segment === null) {
        if (current.length > 1) out.push(current);
        current = [];
        continue;
      }
      const [a, b] = segment;
      const last = current[current.length - 1];
      // 前の線分の終わりから続いていれば、同じ線に足す。
      if (last && last[0] === a[0] && last[1] === a[1]) current.push(b);
      else {
        if (current.length > 1) out.push(current);
        current = [a, b];
      }
    }
    if (current.length > 1) out.push(current);
  }
  if (out.length === 0) return null;
  return out.length === 1 ? { type: 'LineString', coordinates: out[0] } : { type: 'MultiLineString', coordinates: out };
}

/** 線分を四角で切り取る (Liang–Barsky)。四角に掛からなければ null。 */
function clipSegment(
  a: GeoJSON.Position,
  b: GeoJSON.Position,
  [xmin, ymin, xmax, ymax]: Bbox,
): [GeoJSON.Position, GeoJSON.Position] | null {
  const [x1, y1] = a;
  const dx = b[0] - x1;
  const dy = b[1] - y1;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, x1 - xmin],
    [dx, xmax - x1],
    [-dy, y1 - ymin],
    [dy, ymax - y1],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      t0 = Math.max(t0, t);
    } else {
      if (t < t0) return null;
      t1 = Math.min(t1, t);
    }
  }
  const at = (t: number): GeoJSON.Position => (t === 0 ? a : t === 1 ? b : [x1 + t * dx, y1 + t * dy]);
  return [at(t0), at(t1)];
}
