/**
 * **道路** (Overture)。等級 (高速・国道・都道府県道) で絞れる。
 *
 * **ズームで隠さない。** 幹線だけで65.6万区間あり、原寸を引いた画面に出すと
 * 9.4MB転送になって線で埋まるが、**引いたときは粗い段 (`lod = 0`) を引く**ので
 * 全国でも高速1,360本・483KBで足りる。どのズームでどちらを引くかは
 * `lodForZoom` がデータの許容誤差から決める。
 */
import type { GeoJSONSource } from 'maplibre-gl';
import { COARSE_LOD, lodForZoom, lodNote, type RoadSource } from '../../lib/sources';
import { fetchRoadsInView } from '../../lib/queries';
import { EMPTY_FEATURE_COLLECTION, ROAD_STYLES } from '../map';
import { requester, type DrawContext } from './context';
import { m } from '../../i18n';

/**
 * 等級ごとに、**どのズームから出すか**。
 *
 * **簡略化だけでは足りない。** 粗い段で転送量は収まるが、全国の都道府県道
 * 4,609本を一度に描くと画面が線で埋まって何も読めず、細い線が重なるので
 * ツールチップも拾うたびに移り変わる。**引いたら幹線だけにする。**
 *
 * 高速はズーム0から出す (全国の骨格として読めるし、1,360本しかない)。
 * これは標準の値で、表示量の設定 (`roadClassZoomShift`) でずらす。
 */
const ROAD_CLASS_MIN_ZOOM: Record<string, number> = {
  motorway: 0,
  trunk: 8,
  primary: 10,
};

export interface RoadLayer {
  request: () => void;
  /** 設定パネルの要約 (一覧の行へ写す)。 */
  summary: HTMLElement;
}

export function createRoadLayer(ctx: DrawContext, source: RoadSource, classes: string[]): RoadLayer {
  const { map } = ctx;
  const classesEl = document.querySelector<HTMLDivElement>('#road-classes')!;
  const summary = document.querySelector<HTMLParagraphElement>('#road-summary')!;
  let token = 0;
  let shown = false;

  /** 表示量の設定を反映した、その等級が出るズーム。0より下げない。 */
  const classMinZoom = (cls: string): number =>
    Math.max(0, (ROAD_CLASS_MIN_ZOOM[cls] ?? 0) - ctx.detail().roadClassZoomShift);

  // 選択肢は**カタログの語彙から**作る。順番だけ ROAD_STYLES に沿わせる (高速 → 国道 → 都道府県道)。
  const ordered = Object.keys(ROAD_STYLES).filter((cls) => classes.includes(cls));
  const rest = classes.filter((cls) => !(cls in ROAD_STYLES));
  for (const cls of [...ordered, ...rest]) {
    const style = ROAD_STYLES[cls];
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = cls;
    input.checked = true;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = style?.color ?? '#777777';
    label.append(input, swatch, document.createTextNode(style?.label ?? cls));
    classesEl.append(label);
  }
  const inputs = [...classesEl.querySelectorAll<HTMLInputElement>('input')];

  const refresh = async () => {
    const mapSource = map.getSource('road') as GeoJSONSource | undefined;
    if (!mapSource) return;
    const clear = async (message: string) => {
      if (shown) {
        await mapSource.setData(EMPTY_FEATURE_COLLECTION);
        shown = false;
      }
      summary.textContent = message;
    };

    // 世代は最初に進める (外したあとに読み込み中の結果が描かれないように)。
    const mine = ++token;
    if (!ctx.isVisible(source.id)) {
      await clear('');
      return;
    }

    const selected = inputs.filter((input) => input.checked).map((input) => input.value);
    const zoom = map.getZoom();
    // **引いたら幹線だけにする。** 選んであっても、そのズームで読めない等級は出さない。
    const shownClasses = selected.filter((cls) => zoom >= classMinZoom(cls));
    const heldBack = selected.length - shownClasses.length;
    const limit = ctx.detail().roadLimit;

    const lod = lodForZoom(source, zoom);
    const features = await ctx.busy(m.loadingNamed(m.roads), async () => {
      await source.ensure();
      return fetchRoadsInView(ctx.conn, source, ctx.currentBounds(), shownClasses, limit, lod);
    });
    if (mine !== token) return;

    shown = true;
    await mapSource.setData({
      type: 'FeatureCollection',
      features: features.map((feature) => {
        const style = ROAD_STYLES[feature.roadClass];
        return {
          type: 'Feature',
          properties: {
            color: style?.color ?? '#777777',
            width: style?.width ?? 1.5,
            roadName: feature.roadName,
            roadClass: style?.label ?? feature.roadClass,
            // ホバーで出すので、ここで読める形にしておく。
            routeNames: feature.routeNames.join(' / '),
          },
          geometry: feature.geojson,
        };
      }),
    });

    // **出していない等級があることを言う。** 黙って外すと「チェックしたのに
    // 出ない」ように見える。どのズームで出るかも数字で言う。
    const heldBackNote = () => {
      if (heldBack === 0) return '';
      const next = Math.min(...selected.filter((cls) => !shownClasses.includes(cls)).map(classMinZoom));
      return m.classesHeldBack(heldBack, next);
    };

    if (features.length === 0) {
      summary.textContent = (shownClasses.length === 0 ? m.noClassAtThisZoom : m.noRoadsInView) + heldBackNote();
      return;
    }
    summary.textContent =
      (lod === COARSE_LOD ? m.lineCount(features.length) : m.segmentCount(features.length)) +
      lodNote(source, lod) +
      heldBackNote() +
      (features.length >= limit ? m.limitReached : '');
  };

  const request = requester(ctx, 'road', m.roads, refresh);
  for (const input of inputs) input.addEventListener('change', request);
  const setAll = (checked: boolean) => {
    for (const input of inputs) input.checked = checked;
    request();
  };
  document.querySelector('#road-all')!.addEventListener('click', () => setAll(true));
  document.querySelector('#road-none')!.addEventListener('click', () => setAll(false));
  map.on('moveend', request);
  return { request, summary };
}
