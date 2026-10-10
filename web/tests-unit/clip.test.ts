// 線を四角で切り取る部品の単体テスト。周辺検索で、長い線 (鉄道) の押した地点の前後だけを起点にする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aroundBox, clipLines } from '../src/lib/clip.ts';

const BOX: [number, number, number, number] = [0, 0, 10, 10];

test('四角の中の線はそのまま残る', () => {
  const line: GeoJSON.Geometry = { type: 'LineString', coordinates: [[1, 1], [5, 5], [9, 1]] };
  assert.deepEqual(clipLines(line, BOX), line);
});

test('四角をまたぐ線は境で切る', () => {
  assert.deepEqual(clipLines({ type: 'LineString', coordinates: [[-10, 5], [20, 5]] }, BOX), {
    type: 'LineString',
    coordinates: [[0, 5], [10, 5]],
  });
});

test('一度外に出て戻る線は、2本に分ける', () => {
  assert.deepEqual(clipLines({ type: 'LineString', coordinates: [[2, 5], [2, 20], [8, 20], [8, 5]] }, BOX), {
    type: 'MultiLineString',
    coordinates: [
      [[2, 5], [2, 10]],
      [[8, 10], [8, 5]],
    ],
  });
});

test('四角に掛からなければ null', () => {
  assert.equal(clipLines({ type: 'LineString', coordinates: [[20, 20], [30, 30]] }, BOX), null);
});

test('線以外はそのまま返す', () => {
  const point: GeoJSON.Geometry = { type: 'Point', coordinates: [50, 50] };
  assert.equal(clipLines(point, BOX), point);
});

test('点の周りの四角は、東京の緯度で経度方向に広くなる', () => {
  const [w, s, e, n] = aroundBox({ lng: 139.77, lat: 35.68 }, 1500);
  assert.ok(Math.abs((n - s) * 110_540 - 3000) < 1);
  assert.ok(e - w > n - s);
});
