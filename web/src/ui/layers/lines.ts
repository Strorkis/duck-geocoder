/**
 * **送電線・川** (名前と種別だけの線)。
 *
 * 道路と同じく**ズームで隠さない**。引いた表示では粗い段 (名前・種別・タイルで
 * 束ねて簡略化したもの) を引く。上限は道路と共有する (同じ太さの線なので)。
 */
import type { GeoJSONSource } from 'maplibre-gl';
import { COARSE_LOD, lodForZoom, lodNote, type LineSource } from '../../lib/sources';
import { fetchLinesInView } from '../../lib/queries';
import { EMPTY_FEATURE_COLLECTION, LINE_CLASS_LABELS } from '../map';
import { requester, type DrawContext } from './context';

/** 出所ごとに、描き直しを頼む関数を返す。地図を動かすたびにも描き直す。 */
export function createLineLayers(ctx: DrawContext, sources: LineSource[]): Map<string, () => void> {
  const { map } = ctx;
  const tokens = new Map<string, number>();
  const shown = new Set<string>();

  const refresh = async (source: LineSource) => {
    const mapSource = map.getSource(`line-${source.kind}`) as GeoJSONSource | undefined;
    if (!mapSource) return;
    // 世代は最初に進める (外したあとに読み込み中の結果が描かれないように)。
    const token = (tokens.get(source.id) ?? 0) + 1;
    tokens.set(source.id, token);
    if (!ctx.isVisible(source.id)) {
      if (shown.has(source.id)) {
        await mapSource.setData(EMPTY_FEATURE_COLLECTION);
        shown.delete(source.id);
      }
      ctx.setStatus(source.id, '');
      return;
    }
    const limit = ctx.detail().roadLimit;
    const lod = lodForZoom(source, map.getZoom());
    const features = await ctx.busy(`${source.title}を読み込み中…`, async () => {
      await source.ensure();
      return fetchLinesInView(ctx.conn, source, ctx.currentBounds(), limit, lod);
    });
    if (tokens.get(source.id) !== token) return;

    shown.add(source.id);
    await mapSource.setData({
      type: 'FeatureCollection',
      features: features.map((feature) => ({
        type: 'Feature',
        properties: {
          name: feature.name,
          lineClass: LINE_CLASS_LABELS[feature.lineClass] ?? feature.lineClass,
          origin: source.id,
        },
        geometry: feature.geojson,
      })),
    });
    ctx.setStatus(
      source.id,
      features.length === 0
        ? 'この範囲にありません'
        : `${features.length.toLocaleString()} ${lod === COARSE_LOD ? '本' : '区間'}` +
            lodNote(source, lod) +
            (features.length >= limit ? ' (表示上限)' : ''),
    );
  };

  const requests = new Map<string, () => void>();
  for (const source of sources) {
    const request = requester(ctx, `line ${source.id}`, source.title, () => refresh(source));
    requests.set(source.id, request);
    map.on('moveend', request);
  }
  return requests;
}
