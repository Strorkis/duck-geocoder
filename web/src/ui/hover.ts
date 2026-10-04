/**
 * **吹き出し (ホバーと、指で押したとき)。**
 *
 * **層ごとに「何を出すか」を表にし、地図全体で1つの仕掛けで拾う。** 以前は層ごとに
 * mousemove を登録していて、周辺検索の結果 (上に重ねた別の層) には吹き出しが出なかった
 * (当たった建物の上では元の建物を隠すので、建物の吹き出しも消えていた)。
 * いちばん上に描かれているものの吹き出しを出す。
 *
 * **指で押しても同じものを出す** (スマホにはホバーが無い)。
 */
import { Popup, type Map as MapLibreMap } from 'maplibre-gl';
import type { Collection } from '../lib/stac';
import { LINE_KINDS } from '../lib/sources';
import { MESH_SIZE_LABELS } from '../lib/mesh';
import type { VectorOverlay } from '../lib/tiles';

type Props = Record<string, unknown>;
/** [項目名, 値]。**項目名が空なら見出し**。値が null の行は出さない。 */
type HoverRows = [string, string | null][];
/** 吹き出しの中身と、**同じものか**の鍵 (同じなら作り直さない — 区間の境でちらつくため)。 */
type Hover = { key: string; rows: HoverRows };

export interface HoverOptions {
  map: MapLibreMap;
  collections: Collection[];
  /** 外部のベクトルタイル (地理院)。描画の層が多いので表に書かず、層の対応から引く。 */
  vectorOverlays: VectorOverlay[];
  railwayVintage: string | undefined;
  roadVintage: string | undefined;
  /** 周辺検索の距離 (「起点から○m以内」と添える)。 */
  nearbyDistance: () => string;
  /** 地点を判定している最中 (📍)。そのあいだは吹き出しを出さない。 */
  picking: () => boolean;
  /** 周辺検索の起点を待っている最中 (◎)。押しても吹き出しを出さない (起点を選ぶクリック)。 */
  choosingOrigin: () => boolean;
  /** 吹き出しの出る地物の上にいるか (ポインタの形を変える)。 */
  onHovering: (hovering: boolean) => void;
}

export interface HoverHandle {
  /** 吹き出しを閉じる (判定の吹き出しと並ばないように)。 */
  hide: () => void;
}

/**
 * 吹き出しの中身を組み立てる。
 *
 * **`setText` に改行を渡しても効かない。** テキストノードになるので `\n` は
 * 空白に潰れ、項目が横一列に並んで読めなくなる。かといって `setHTML` は
 * データ由来の文字列 (駅名や事業者名) をそのままHTMLとして解釈するので使わない。
 * 要素を組んで `setDOMContent` に渡す。
 */
function hoverContent(rows: HoverRows): HTMLElement {
  const box = document.createElement('div');
  box.className = 'hover-info';
  for (const [label, value] of rows) {
    if (value === null) continue;
    const line = document.createElement('div');
    if (label) {
      const name = document.createElement('span');
      name.className = 'label';
      name.textContent = label;
      line.append(name, document.createTextNode(value));
    } else {
      line.className = 'title';
      line.textContent = value;
    }
    box.append(line);
  }
  return box;
}

const text = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));

export function createHover(options: HoverOptions): HoverHandle {
  const { map, collections, vectorOverlays, railwayVintage, roadVintage } = options;

  // マウスを追うだけなので閉じるボタンは出さない。
  const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'hover-popup' });

  const originOf = (props: Props) => collections.find((c) => c.id === props.origin);

  /** 建物。**どちらの出所の建物か**も言う (PLATEAUとOvertureは同時に出せて、色だけでは見分けにくい)。 */
  const buildingRows = (props: Props): HoverRows => {
    const origin = originOf(props);
    return [
      ['', text(props.name) ?? '(名称なし)'],
      ['用途', text(props.category)],
      ['高さ', props.height ? `${props.height as number} m` : null],
      ['重要度', (props.tierRank as number | undefined) !== -1 ? text(props.tier) : null],
      ['出所', origin?.group?.title ?? origin?.title ?? null],
    ];
  };

  /** 周辺検索で当たったもの、と分かる1行。 */
  const nearbyRow = (): [string, string] => ['周辺検索', `起点から ${options.nearbyDistance()} m 以内`];

  const railwayHover = (p: Props): Hover => {
    const station = text(p.stationName);
    return {
      key: `rail|${station ?? ''}|${p.lineName}|${p.operator}`,
      rows: [
        // 駅なら駅名を見出しにする。路線には駅名が入っていない。
        ['', station ? `${station}駅` : text(p.lineName)],
        ['路線', station ? text(p.lineName) : null],
        ['事業者', text(p.operator)],
        ['種別', text(p.institutionType)],
        ['区分', text(p.railwayClass)],
        ['時点', railwayVintage ?? null],
      ],
    };
  };

  const HOVER_LAYERS: Record<string, (props: Props) => Hover> = {
    'nearby-hits': (p) => ({
      key: `nearby|${p.origin}|${p.name}|${p.height}|${p.category}`,
      rows: [...buildingRows(p), nearbyRow()],
    }),
    'nearby-hit-lines': (p) => {
      const origin = originOf(p);
      return {
        key: `nearby-line|${p.kind}|${p.name}`,
        rows: [
          ['', text(p.name) ?? '(名前なし)'],
          ['種類', text(p.kind)],
          ['出所', origin?.group?.title ?? null],
          ['時点', origin?.vintage ?? null],
          nearbyRow(),
        ],
      };
    },
    'buildings-3d': (p) => ({
      key: `building|${p.origin}|${p.name}|${p.height}|${p.category}`,
      rows: buildingRows(p),
    }),
    // 整備範囲のメッシュ。**どのメッシュか、どの自治体かが読めること。**
    // 塗りの濃さは埋まり具合しか表さないので、中身はここでしか分からない。
    'buildings-coverage-fill': (p) => {
      const code = p.code as string;
      const cities = (p.cities as string) || '(不明)';
      const filled = p.filled as number;
      const total = p.total as number;
      return {
        key: `cell|${code}`,
        rows: [
          ['', `${MESH_SIZE_LABELS[code.length] ?? `${code.length}桁`}メッシュ`],
          ['メッシュコード', code],
          // **束ねると自治体が増える。** 80kmまで引くと何十も並ぶので、多いときは数だけにする。
          ['自治体', cities.split('、').length > 6 ? `${cities.split('、').length} 市区町村` : cities],
          // **濃淡を数で裏付ける。** 1kmで見ているときは必ず1/1なので出さない。
          [
            'データのある1kmセル',
            total > 1
              ? `${filled.toLocaleString()} / ${total.toLocaleString()} (${Math.round((filled / total) * 100)}%)`
              : null,
          ],
          ['建物', `${(p.buildings as number).toLocaleString()} 棟`],
        ],
      };
    },
    'railway-station': railwayHover,
    'railway-line': railwayHover,
    // 道路は交差点ごとに区間が切れている。名前と路線と等級が同じなら同じ道として扱う。
    'road-line': (p) => {
      const routes = text(p.routeNames) ?? '';
      const name = text(p.roadName);
      return {
        key: `road|${name ?? ''}|${routes}|${p.roadClass}`,
        rows: [
          // 名前が無い区間もある。その場合は路線名を見出しに繰り上げる。
          ['', name || routes || '(名前なし)'],
          // **路線は複数あることがある。** 見出しに使ったものと同じなら繰り返さない。
          ['路線', routes && routes !== name ? routes : null],
          ['種別', text(p.roadClass)],
          ['時点', roadVintage ?? null],
        ],
      };
    },
    ...Object.fromEntries(
      LINE_KINDS.map((kind) => [
        `line-${kind}`,
        (p: Props): Hover => {
          const origin = originOf(p);
          return {
            key: `line|${kind}|${p.name ?? ''}|${p.lineClass}`,
            rows: [
              ['', text(p.name) ?? '(名前なし)'],
              ['種別', text(p.lineClass)],
              ['出所', origin?.group?.title ?? null],
              ['時点', origin?.vintage ?? null],
            ],
          };
        },
      ]),
    ),
  };

  /** うちのデータ (と周辺検索の結果) で、その点のいちばん上にあるもの。 */
  const ownHoverAt = (point: { x: number; y: number }): Hover | null => {
    const ids = Object.keys(HOVER_LAYERS).filter((id) => map.getLayer(id));
    const top = map.queryRenderedFeatures([point.x, point.y], { layers: ids })[0];
    return top ? HOVER_LAYERS[top.layer.id](top.properties) : null;
  };

  /**
   * 外部のベクトルタイル (地理院)。描画の層が123あって表に書ききれないので、
   * その点にある地物から地理院の層のものを探す。**うちのデータが無いときだけ**使う。
   */
  const vectorHoverAt = (point: { x: number; y: number }): Hover | null => {
    if (vectorOverlays.length === 0) return null;
    for (const feature of map.queryRenderedFeatures([point.x, point.y])) {
      const overlay = vectorOverlays.find((o) => o.styleLayers.has(feature.layer.id));
      if (!overlay) continue;
      const sourceLayer = overlay.styleLayers.get(feature.layer.id)!;
      const props = feature.properties;
      const theme = overlay.collection.themes?.find((t) => t.layers.some((l) => l.id === sourceLayer));
      const layer = theme?.layers.find((l) => l.id === sourceLayer);
      return {
        key: `vector|${sourceLayer}|${props.vt_code ?? ''}|${props.vt_text ?? ''}`,
        rows: [
          ['', text(props.vt_text) ?? `${theme?.title ?? ''} › ${layer?.title ?? sourceLayer}`],
          ['層', `${layer?.title ?? sourceLayer} (${sourceLayer})`],
          // 地物の種別のコード。意味は配布元の「地物種別コード一覧」にある。
          ['種別コード', text(props.vt_code)],
          ['出所', `${overlay.collection.group?.title ?? ''} ${overlay.collection.title}`.trim()],
          ['時点', overlay.collection.vintage ?? null],
        ],
      };
    }
    return null;
  };

  let hoveredKey = '';
  const show = (lngLat: { lng: number; lat: number }, hover: Hover) => {
    popup.setLngLat(lngLat).addTo(map);
    if (hover.key === hoveredKey) return;
    hoveredKey = hover.key;
    popup.setDOMContent(hoverContent(hover.rows));
  };
  const hide = () => {
    hoveredKey = '';
    popup.remove();
  };

  map.on('mousemove', (e) => {
    // **判定中はホバーを出さない。** 判定の結果も吹き出しで出すので、
    // 2つ並ぶとどちらが押した場所のものか分からなくなる。
    if (options.picking()) return;
    const own = ownHoverAt(e.point);
    options.onHovering(own !== null);
    const hover = own ?? vectorHoverAt(e.point);
    if (hover) show(e.lngLat, hover);
    else if (hoveredKey) hide();
  });
  map.getCanvas().addEventListener('mouseleave', () => {
    options.onHovering(false);
    if (hoveredKey) hide();
  });

  // **押したときも出す** (スマホ)。📍や◎で押した地点は、そちらが先に受け取って
  // 印を付ける (`preventDefault`)。何も無いところを押したら閉じる。
  map.on('click', (e) => {
    if (e.defaultPrevented || options.picking() || options.choosingOrigin()) return;
    const hover = ownHoverAt(e.point) ?? vectorHoverAt(e.point);
    if (hover) {
      hoveredKey = '';
      show(e.lngLat, hover);
    } else if (hoveredKey) {
      hide();
    }
  });

  return { hide };
}
