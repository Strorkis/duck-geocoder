/**
 * **地域メッシュ (JIS X 0410) の計算。** 画面にも地図にも依存しない。
 *
 * パイプライン側の `pipeline/src/mesh.rs` と同じ計算。JIS X 0410 は変わらないので、
 * 二重に持つことを受け入れている (SQLで書くよりこちらの方が読める)。
 */
import type { Bbox } from './stac';
import type { ViewBounds } from './sources';

/** メッシュコードの桁数から、人間に見せる大きさの呼び名。 */
export const MESH_SIZE_LABELS: Record<number, string> = {
  4: '80km',
  6: '10km',
  8: '1km',
  9: '500m',
  10: '250m',
  11: '125m',
};

/**
 * ズームに対して、メッシュコードを何桁で束ねるか。
 *
 * **メッシュコードは階層になっている**ので、前から切るだけで粗くできる
 * (11桁=125m、10桁=250m、9桁=500m、8桁=1km、6桁=10km、4桁=80km)。
 *
 * 引くほど粗くするのは、描く数を抑えるため。125mメッシュは全国で282万件ある。
 * どのファイルから作るかは `meshSourceFor` が別に決める。
 */
export function meshDigits(zoom: number): number {
  if (zoom >= 15) return 11;
  if (zoom >= 14) return 10;
  if (zoom >= 12) return 9;
  if (zoom >= 9) return 8;
  if (zoom >= 6) return 6;
  return 4;
}

/**
 * この桁のメッシュ1つに入る1kmセルの数。
 *
 * JIS X 0410 は 4桁 (80km) → 6桁 (10km) → 8桁 (1km) で、
 * 4→6 は緯度経度それぞれ8分割 (8×8)、6→8 は10分割 (10×10)。
 */
export function meshCellCapacity(digits: number): number {
  if (digits >= 8) return 1;
  if (digits === 6) return 100;
  if (digits === 4) return 64 * 100;
  throw new Error(`想定していないメッシュの桁数: ${digits}`);
}

/**
 * メッシュコードから範囲を求める。
 *
 * **束ねたセルは、この矩形で描く。** 中に入っている子メッシュのbboxの和で描くと、
 * 人のいる子だけを囲った形になり、細い縦帯のような「メッシュではない形」が出る。
 * 実際に地図で見て分かった。
 */
export function meshBounds(code: string): Bbox {
  const digits = [...code].map(Number);
  // 1次メッシュ。緯度は1.5倍した整数部、経度は100を引いた整数部。
  let latSize = 2 / 3;
  let lonSize = 1;
  let south = (digits[0] * 10 + digits[1]) / 1.5;
  let west = digits[2] * 10 + digits[3] + 100;

  // 2次メッシュ。1次を縦横8分割し、南西を0として行・列で指す。
  if (digits.length >= 6) {
    latSize /= 8;
    lonSize /= 8;
    south += digits[4] * latSize;
    west += digits[5] * lonSize;
  }
  // 3次メッシュ。2次を縦横10分割する。
  if (digits.length >= 8) {
    latSize /= 10;
    lonSize /= 10;
    south += digits[6] * latSize;
    west += digits[7] * lonSize;
  }
  // 分割メッシュ。1桁ごとに4分割で、1=南西 2=南東 3=北西 4=北東。
  for (const quadrant of digits.slice(8)) {
    latSize /= 2;
    lonSize /= 2;
    south += Math.floor((quadrant - 1) / 2) * latSize;
    west += ((quadrant - 1) % 2) * lonSize;
  }
  return [west, south, west + lonSize, south + latSize];
}

/**
 * 緯度経度の点が入る3次メッシュ (8桁、約1km) のコード。[`meshBounds`] の逆。
 * (1次は緯度×1.5と経度−100の整数部、2次は8分割、3次は10分割)。
 */
export function meshCode3(lon: number, lat: number): string {
  const p = Math.floor(lat * 1.5);
  const u = Math.floor(lon - 100);
  const latRest = lat * 1.5 - p;
  const lonRest = lon - 100 - u;
  const q = Math.floor(latRest * 8);
  const v = Math.floor(lonRest * 8);
  const r = Math.floor((latRest * 8 - q) * 10);
  const w = Math.floor((lonRest * 8 - v) * 10);
  return `${p}${u}${q}${v}${r}${w}`;
}

/**
 * 表示範囲に掛かる3次メッシュのコード。**多すぎるときは2次メッシュ (6桁) にまとめる**
 * (PLATEAU配信サービスは6桁でも引ける)。それでも多ければ `null` (寄ってもらう)。
 */
export function meshCodesInView(bounds: ViewBounds, limit = 60): string[] | null {
  const codes = new Set<string>();
  // 3次メッシュは緯度30秒 (1/120度)・経度45秒 (1/80度)。半分の刻みで拾えば漏れない。
  for (let lat = bounds.south; lat <= bounds.north + 1 / 240; lat += 1 / 240) {
    for (let lon = bounds.west; lon <= bounds.east + 1 / 160; lon += 1 / 160) {
      codes.add(meshCode3(Math.min(lon, bounds.east), Math.min(lat, bounds.north)));
      if (codes.size > 2000) break;
    }
  }
  if (codes.size <= limit) return [...codes].sort();
  const coarse = new Set([...codes].map((code) => code.slice(0, 6)));
  return coarse.size <= limit / 4 ? [...coarse].sort() : null;
}
