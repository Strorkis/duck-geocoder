/**
 * **鉄道** (国土数値情報 N02)。路線と駅は別の Collection で、一覧でも別の行。
 * 絞り込み (事業者種別) と設定パネルは両方で共有する。
 *
 * **ズームで隠さない。** 路線のジオメトリ列は原寸で4.5MBあって全国を一度に
 * 読むと起動時の転送量 (1.5MB) を超えるが、**引いたときは粗い段 (`lod = 0`) を
 * 引く**ので全国597本・329KBで足りる。
 *
 * **駅には段が無い。** 点に近い短い線なので簡略化しても縮まない。
 * 表示範囲で絞るだけで足りる (全国で2.2万件・821KB)。
 */
import type { GeoJSONSource } from 'maplibre-gl';
import { lodForZoom, lodNote, type RailwaySource } from '../../lib/sources';
import { fetchRailwayInView, type RailwayFeature } from '../../lib/queries';
import { EMPTY_FEATURE_COLLECTION, RAILWAY_COLORS, RAILWAY_FALLBACK_COLOR } from '../map';
import { requester, type DrawContext } from './context';
import { m } from '../../i18n';

export function createRailwayLayer(
  ctx: DrawContext,
  sources: RailwaySource[],
  /** 事業者種別の語彙 (カタログから)。 */
  institutionTypes: string[],
): () => void {
  const { map } = ctx;
  const typesEl = document.querySelector<HTMLDivElement>('#railway-types')!;
  const summary = document.querySelector<HTMLParagraphElement>('#railway-summary')!;
  let token = 0;
  let shown = false;

  // 選択肢はカタログの語彙から作る。色見本を添えて、地図の色と対応付ける。
  for (const type of institutionTypes) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = type;
    input.checked = true;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = RAILWAY_COLORS[type] ?? RAILWAY_FALLBACK_COLOR;
    label.append(input, swatch, document.createTextNode(type));
    typesEl.append(label);
  }
  const inputs = [...typesEl.querySelectorAll<HTMLInputElement>('input')];

  const toGeoJson = (features: RailwayFeature[]): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features: features.map((feature) => ({
      type: 'Feature',
      properties: {
        // 色は引くときに決める (凡例と同じ表から作る)。
        color: RAILWAY_COLORS[feature.institutionType] ?? RAILWAY_FALLBACK_COLOR,
        lineName: feature.lineName,
        operator: feature.operator,
        institutionType: feature.institutionType,
        railwayClass: feature.railwayClass,
        stationName: feature.stationName,
      },
      geometry: feature.geojson,
    })),
  });

  const refresh = async () => {
    const lineSource = map.getSource('railway') as GeoJSONSource | undefined;
    const stationSource = map.getSource('railway-stations') as GeoJSONSource | undefined;
    if (!lineSource || !stationSource) return;

    const clear = async (message: string) => {
      if (shown) {
        await lineSource.setData(EMPTY_FEATURE_COLLECTION);
        await stationSource.setData(EMPTY_FEATURE_COLLECTION);
        shown = false;
      }
      summary.textContent = message;
      for (const source of sources) ctx.setStatus(source.id, '');
    };

    // 世代は最初に進める (外したあとに読み込み中の結果が描かれないように)。
    const mine = ++token;
    const visible = sources.filter((source) => ctx.isVisible(source.id));
    if (visible.length === 0) {
      await clear('');
      return;
    }

    const selected = inputs.filter((input) => input.checked).map((input) => input.value);
    const limit = ctx.detail().railwayLimit;
    const zoom = map.getZoom();
    const bounds = ctx.currentBounds();
    const results = await ctx.busy(m.loadingNamed(m.railways), () =>
      Promise.all(
        visible.map(async (source) => {
          await source.ensure();
          return {
            kind: source.kind,
            features: await fetchRailwayInView(
              ctx.conn,
              source,
              bounds,
              institutionTypes.length > 0 ? selected : null,
              limit,
              // 駅には段が無いので、そちらは undefined が返って条件が付かない。
              lodForZoom(source, zoom),
            ),
          };
        }),
      ),
    );
    if (mine !== token) return;

    const lines = results.find((r) => r.kind === 'railway')?.features ?? [];
    const stations = results.find((r) => r.kind === 'railway_station')?.features ?? [];
    shown = true;
    await lineSource.setData(toGeoJson(lines));
    await stationSource.setData(toGeoJson(stations));

    // 行ごとの状態。**出していない方は空にする** (前の件数が残らないように)。
    for (const source of sources) {
      if (!visible.includes(source)) {
        ctx.setStatus(source.id, '');
        continue;
      }
      const features = source.kind === 'railway' ? lines : stations;
      ctx.setStatus(
        source.id,
        features.length === 0
          ? m.noneInView
          : (source.kind === 'railway' ? m.lineCount(features.length) : m.stationCount(features.length)) +
              lodNote(source, lodForZoom(source, zoom)) +
              (features.length >= limit ? m.displayLimit : ''),
      );
    }

    if (lines.length === 0 && stations.length === 0) {
      summary.textContent = m.noRailwaysInView;
      return;
    }
    const capped = lines.length >= limit || stations.length >= limit;
    const lineInfo = visible.find((source) => source.kind === 'railway');
    summary.textContent =
      m.railwaySummary(lines.length, stations.length) +
      (lineInfo ? lodNote(lineInfo, lodForZoom(lineInfo, zoom)) : '') +
      (capped ? m.limitReached : '');
  };

  const request = requester(ctx, 'railway', m.railways, refresh);
  for (const input of inputs) input.addEventListener('change', request);
  const setAll = (checked: boolean) => {
    for (const input of inputs) input.checked = checked;
    request();
  };
  document.querySelector('#railway-all')!.addEventListener('click', () => setAll(true));
  document.querySelector('#railway-none')!.addEventListener('click', () => setAll(false));
  map.on('moveend', request);
  return request;
}
