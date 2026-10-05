/**
 * **人口メッシュ** (国勢調査)。色は SORA の地上リスク (iGRC) の区切りで段を切る。
 *
 * 細かさの違う Collection (125m・1km) を、ズームに応じて選んで束ねる (`meshSourceFor`)。
 * 一覧の行は1つで、ID は先頭のメッシュ。
 */
import type { GeoJSONSource } from 'maplibre-gl';
import { meshSourceFor, type MeshSource } from '../../lib/sources';
import { MESH_SIZE_LABELS, meshBounds, meshDigits } from '../../lib/mesh';
import { fetchMeshInView } from '../../lib/queries';
import { AIRCRAFT_CLASSES, IGRC_BANDS, igrcBand } from '../../lib/igrc';
import { EMPTY_FEATURE_COLLECTION } from '../map';
import { requester, type DrawContext } from './context';

export interface MeshLayer {
  request: () => void;
  /** 設定パネルの要約 (一覧の行へ写す)。 */
  summary: HTMLElement;
}

export function createMeshLayer(ctx: DrawContext, sources: MeshSource[]): MeshLayer {
  const { map } = ctx;
  const aircraftSelect = document.querySelector<HTMLSelectElement>('#aircraft-class')!;
  const legendBody = document.querySelector<HTMLTableSectionElement>('#mesh-legend tbody')!;
  const summary = document.querySelector<HTMLParagraphElement>('#mesh-summary')!;

  /** 選んでいる機体の区分。iGRC表の列にあたる。 */
  let aircraftIndex = 0;
  let token = 0;
  /** いま地図にメッシュを載せているか。空を載せ直す無駄を避けるために持つ。 */
  let shown = false;

  /** 凡例を作り直す。機体を変えると iGRC の値が変わる。 */
  const renderLegend = () => {
    legendBody.replaceChildren();
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
      legendBody.append(row);
    }
  };

  const refresh = async () => {
    const mapSource = map.getSource('population-mesh') as GeoJSONSource | undefined;
    if (!mapSource) return;

    /**
     * メッシュを消す。**既に空なら何もしない。** `moveend` は地図を動かすたびに飛ぶので、
     * 消えている状態で毎回 `setData` を呼ぶと、空のデータをワーカーへ往復させ続けることになる。
     */
    const clear = async (message: string) => {
      if (shown) {
        await mapSource.setData(EMPTY_FEATURE_COLLECTION);
        shown = false;
      }
      summary.textContent = message;
    };

    // 世代は最初に進める (外したあとに読み込み中の結果が描かれないように)。
    const mine = ++token;
    if (!ctx.isVisible(sources[0]?.id ?? '')) {
      await clear('');
      return;
    }

    const digits = meshDigits(map.getZoom());
    // 要求する細かさを出せる出所が無ければ出せない。125mしか配っていない状態で
    // 引くと、これに当たる代わりに125mから束ねることになっていた。
    const source = meshSourceFor(sources, digits);
    if (!source) {
      await clear('この縮尺の人口密度は配信されていません');
      return;
    }

    const cells = await ctx.busy('人口密度を読み込み中…', async () => {
      await source.ensure();
      return fetchMeshInView(ctx.conn, source, ctx.currentBounds(), digits);
    });
    if (mine !== token) return;

    shown = true;
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
      summary.textContent = 'この範囲に人口メッシュがありません';
      return;
    }
    const peak = cells.reduce((max, cell) => Math.max(max, cell.density), 0);
    const igrc = igrcBand(peak).igrc[aircraftIndex];
    const size = MESH_SIZE_LABELS[digits] ?? `${digits}桁`;
    summary.textContent =
      `${size}メッシュ / 表示範囲の最大 ${Math.round(peak).toLocaleString()} 人/km² ` +
      `(iGRC ${igrc === null ? '範囲外' : igrc})`;
  };

  const request = requester(ctx, 'mesh', '人口密度', refresh);

  for (const [index, { label }] of AIRCRAFT_CLASSES.entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = label;
    aircraftSelect.append(option);
  }
  renderLegend();
  // 機体を変えても地図の色は変わらない (色は密度の帯で決まる)。
  // 変わるのは凡例と要約に出る iGRC の値だけ。
  aircraftSelect.addEventListener('change', () => {
    aircraftIndex = Number(aircraftSelect.value);
    renderLegend();
    request();
  });
  map.on('moveend', request);
  return { request, summary };
}
