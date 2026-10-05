/**
 * **周辺検索のパネル** (右上) と、地図への描き方。問い合わせそのものは lib/nearby.ts。
 *
 * 起点は4通り: 検索で選んだもの / 地図上の点 / 地図上の線 / 建物。
 * 地図上のものは ◎ を押してからクリックする。何も無いところなら点、
 * 線や建物の上ならそれを起点にする。
 */
import type * as duckdb from '@duckdb/duckdb-wasm';
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Collection } from '../lib/stac';
import { MESH_SIZE_LABELS } from '../lib/mesh';
import { geometryOf } from '../lib/wkb';
import {
  bboxOverlaps,
  geometryBbox,
  unionBbox,
  type BuildingSource,
  type LineSource,
  type MeshSource,
  type RailwaySource,
  type RoadSource,
  type ViewBounds,
} from '../lib/sources';
import {
  NEARBY_DRAW_LIMIT,
  fetchNearbyBuildings,
  fetchNearbyNames,
  fetchNearbyPopulation,
  fromMeters,
  nearbyFrame,
  type NearbyBuildings,
  type NearbyFrame,
  type NearbyOrigin,
} from '../lib/nearby';

export interface NearbyPanelOptions {
  map: MapLibreMap;
  conn: duckdb.AsyncDuckDBConnection;
  collections: Collection[];
  sources: {
    buildings: BuildingSource[];
    railways: RailwaySource[];
    road: RoadSource | undefined;
    lines: LineSource[];
    meshes: MeshSource[];
  };
  /** 時間のかかる処理を「処理中」の表示で包む。 */
  busy: <T>(label: string, run: () => Promise<T>) => Promise<T>;
  ensureSpatial: () => Promise<void>;
  setSourceData: (sourceId: string, geometry: GeoJSON.Geometry | null) => Promise<void>;
  currentBounds: () => ViewBounds;
  /** 起点を待つ状態が変わった (ポインタの形と、📍 との排他を main が決める)。 */
  onChoosingChange: (on: boolean) => void;
}

export interface NearbyPanel {
  /** 起点を待つ (◎ を押した状態)。 */
  setChoosing: (on: boolean) => void;
  choosing: () => boolean;
  /** 結果 (かパネル) を出しているか。Esc で閉じる順番に使う。 */
  isOpen: () => boolean;
  /** 閉じて、地図から消す。 */
  clear: () => void;
  /** 検索で選んだものを覚えておく。パネルから起点にできる。 */
  remember: (label: string, geometry: GeoJSON.Geometry) => void;
  /** いまの距離 (m)。吹き出しに添える。 */
  distance: () => string;
}

/** 起点に使える地図上のレイヤーと、その呼び名・名前の属性。上ほど優先。 */
const ORIGIN_LAYERS: { layer: string; label: string; nameKey: string | null }[] = [
  { layer: 'buildings-3d', label: '建物', nameKey: null },
  { layer: 'line-power_line', label: '送電線', nameKey: 'name' },
  { layer: 'line-waterway', label: '川', nameKey: 'name' },
  { layer: 'railway-station', label: '駅', nameKey: 'stationName' },
  { layer: 'railway-line', label: '鉄道', nameKey: 'lineName' },
  { layer: 'road-line', label: '道路', nameKey: 'roadName' },
];

// **結果だけを目立たせる。** 周辺検索の結果を出しているあいだ、うちのデータの層を
// 薄くする (消しはしない — 薄く残すと、結果がどこに当たっているかの手がかりになる)。
// 背景地図と周辺検索の層 (起点・範囲・結果) はそのまま。
const NEARBY_KEEP = /^(basemap\/|nearby-|highlight|selected-point)/;
type PaintProperty = Parameters<MapLibreMap['getPaintProperty']>[1];
type PaintValue = Parameters<MapLibreMap['setPaintProperty']>[2];
const DIM_PROPERTIES: Record<string, PaintProperty[]> = {
  fill: ['fill-opacity'],
  line: ['line-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'],
  symbol: ['text-opacity', 'icon-opacity'],
};
const NEARBY_DIM = 0.12;
/** 周辺検索の層。**下から上の順** (範囲 → 当たったもの → 起点)。 */
const NEARBY_LAYERS = [
  'nearby-zone-fill',
  'nearby-zone-line',
  'nearby-hits',
  'nearby-hit-lines',
  'nearby-origin-fill',
  'nearby-origin-casing',
  'nearby-origin-line',
  'nearby-origin-point',
];

// `['==', 1, 1]` だと MapLibre が古い書き方の filter とも読めてしまい、式と混ぜたと警告する。
const TRUE: ExpressionSpecification = ['boolean', true];
const FALSE: ExpressionSpecification = ['boolean', false];

/** 種類ごとの名前の結果 [種類, 結果, 出所のCollection ID]。出所は当たったものの吹き出しに使う。 */
type NamedHits = [string, { names: string[]; total: number; features: GeoJSON.Feature[] }, string];

interface NearbyResult {
  zoneGeometry: GeoJSON.Geometry;
  buildings: NearbyBuildings[];
  names: NamedHits[];
  population: { population: number; cells: number; label: string } | null;
}

export function createNearbyPanel(options: NearbyPanelOptions): NearbyPanel {
  const { map, conn, collections, sources, busy, ensureSpatial, setSourceData, currentBounds } = options;

  const button = document.querySelector<HTMLButtonElement>('#nearby-button')!;
  const panel = document.querySelector<HTMLDivElement>('#nearby-panel')!;
  const distanceSelect = document.querySelector<HTMLSelectElement>('#nearby-distance')!;
  const originEl = document.querySelector<HTMLParagraphElement>('#nearby-origin')!;
  const resultsEl = document.querySelector<HTMLDivElement>('#nearby-results')!;
  const fromSearchButton = document.querySelector<HTMLButtonElement>('#nearby-from-search')!;
  const focusInput = document.querySelector<HTMLInputElement>('#nearby-focus')!;

  let choosing = false;
  let lastSelection: NearbyOrigin | null = null;
  let currentOrigin: NearbyOrigin | null = null;
  let token = 0;

  /**
   * 結果の見せ方。**種類ごとに地図への表示を切り替え** (`hidden`)、**名前を押すとそれだけを
   * 残して寄る** (`focus`)。「当たった川はどこか」「当たった駅だけ見たい」に答えるため。
   *
   * `hidden` の鍵は種類の名前 (「鉄道」「駅」…)、建物全体は「建物」、建物の段は `段:公共施設`。
   */
  let view: { hidden: Set<string>; focus: { kind: string; name: string } | null } = {
    hidden: new Set(),
    focus: null,
  };
  /** 最後に描いた結果 (名前を押したときに寄る先を探す)。 */
  let drawn: { buildings: GeoJSON.Feature[]; lines: GeoJSON.Feature[] } = { buildings: [], lines: [] };

  const setChoosing = (on: boolean) => {
    choosing = on;
    button.setAttribute('aria-pressed', String(on));
    // **押したらパネルを出して、何をすればいいかを言う。** 検索で選んだものがあれば、
    // 地図をクリックせずにそれを起点にもできる。
    if (on) {
      panel.hidden = false;
      originEl.textContent = '地図の点・線・建物をクリックしてください';
      resultsEl.replaceChildren();
      fromSearchButton.hidden = lastSelection === null;
    }
    options.onChoosingChange(on);
  };
  button.addEventListener('click', () => setChoosing(!choosing));

  /** 見せ方を地図の絞り込み (filter) に写す。 */
  const applyView = () => {
    const { hidden, focus } = view;
    const tiers = [...hidden].filter((key) => key.startsWith('段:')).map((key) => key.slice(2));
    const onlyName = (kind: string): ExpressionSpecification =>
      focus ? (focus.kind === kind ? ['==', ['get', 'name'], focus.name] : FALSE) : TRUE;
    if (map.getLayer('nearby-hits')) {
      map.setFilter('nearby-hits', [
        'all',
        hidden.has('建物') ? FALSE : TRUE,
        ['!', ['in', ['get', 'tier'], ['literal', tiers]]],
        onlyName('建物'),
      ]);
    }
    if (map.getLayer('nearby-hit-lines')) {
      map.setFilter('nearby-hit-lines', [
        'all',
        ['!', ['in', ['get', 'kind'], ['literal', [...hidden]]]],
        focus ? ['all', ['==', ['get', 'kind'], focus.kind], ['==', ['get', 'name'], focus.name]] : TRUE,
      ]);
    }
  };

  /** 名前を押したとき: それだけを残し、そこへ寄る。もう一度押すと戻す。 */
  const focusOn = (kind: string, name: string) => {
    const same = view.focus?.kind === kind && view.focus.name === name;
    view.focus = same ? null : { kind, name };
    applyView();
    if (same) return;
    const pool = kind === '建物' ? drawn.buildings : drawn.lines;
    const matched = pool.filter(
      (f) => f.properties?.name === name && (kind === '建物' || f.properties?.kind === kind),
    );
    const box = unionBbox(matched.map((f) => geometryBbox(f.geometry)));
    if (box) {
      map.fitBounds(
        [
          [box[0], box[1]],
          [box[2], box[3]],
        ],
        { padding: 80, maxZoom: 17, duration: 600 },
      );
    }
  };

  /**
   * クリックした場所の起点を決める。**線は同じ名前の区間をまとめて起点にする**
   * (川や送電線は区間に切れているので、1区間だけだと「川沿い」にならない)。
   * 名前は表示中のデータから集めるので、画面に出ている範囲の分になる。
   */
  const originAt = async (
    point: { x: number; y: number },
    lngLat: { lng: number; lat: number },
  ): Promise<NearbyOrigin> => {
    const layers = ORIGIN_LAYERS.filter(({ layer }) => map.getLayer(layer));
    const hit = map.queryRenderedFeatures([point.x, point.y], { layers: layers.map(({ layer }) => layer) })[0];
    const spec = hit && layers.find(({ layer }) => layer === hit.layer.id);
    if (!hit || !spec) {
      return {
        label: `地図上の点 (${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)})`,
        geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] },
      };
    }
    if (spec.nameKey === null) {
      return {
        label: `${spec.label} ${(hit.properties.name as string | null) ?? '(名称なし)'}`,
        geometry: hit.geometry,
        height: (hit.properties.height as number | null | undefined) ?? null,
      };
    }
    const name = hit.properties[spec.nameKey] as string | null;
    if (!name) return { label: `${spec.label} (名前なし)`, geometry: hit.geometry };
    const data = await (map.getSource(hit.source) as GeoJSONSource).getData();
    const lines: GeoJSON.Position[][] = [];
    if (data.type === 'FeatureCollection') {
      for (const feature of data.features) {
        if (feature.properties?.[spec.nameKey] !== name) continue;
        const g = feature.geometry;
        if (g.type === 'LineString') lines.push(g.coordinates);
        if (g.type === 'MultiLineString') lines.push(...g.coordinates);
      }
    }
    return {
      label: `${spec.label} ${name}`,
      geometry: lines.length > 0 ? { type: 'MultiLineString', coordinates: lines } : hit.geometry,
    };
  };

  map.on('click', (e) => {
    if (!choosing) return;
    // このクリックは起点を選ぶもの。吹き出し (ui/hover.ts の click) には渡さない。
    e.preventDefault();
    setChoosing(false);
    void originAt(e.point, e.lngLat).then(run);
  });

  /** 薄くした層と、元の値 (戻すため)。元が既定値なら undefined で、戻すと既定に戻る。 */
  const dimmed = new Map<string, [PaintProperty, PaintValue][]>();
  /** 隠した立体の層 (戻すため)。 */
  const hiddenExtrusions = new Set<string>();

  const setFocusMode = (on: boolean) => {
    if (!on) {
      for (const [id, properties] of dimmed) {
        if (!map.getLayer(id)) continue;
        for (const [property, value] of properties) map.setPaintProperty(id, property, value);
      }
      dimmed.clear();
      for (const id of hiddenExtrusions) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
      }
      hiddenExtrusions.clear();
      return;
    }
    for (const layer of map.getStyle().layers) {
      if (NEARBY_KEEP.test(layer.id) || dimmed.has(layer.id) || hiddenExtrusions.has(layer.id)) continue;
      // **立体は薄くせず隠す。** 当たった建物を同じ場所に立体で重ねるので、薄くした元の
      // 建物と壁が重なって縞模様にちらついた。薄い立体は手がかりとしても読みにくい。
      if (layer.type === 'fill-extrusion') {
        if (layer.layout?.visibility === 'none') continue;
        hiddenExtrusions.add(layer.id);
        map.setLayoutProperty(layer.id, 'visibility', 'none');
        continue;
      }
      const properties = DIM_PROPERTIES[layer.type];
      if (!properties) continue;
      dimmed.set(
        layer.id,
        properties.map((property) => [property, map.getPaintProperty(layer.id, property)]),
      );
      for (const property of properties) map.setPaintProperty(layer.id, property, NEARBY_DIM);
    }
  };
  focusInput.addEventListener('change', () => setFocusMode(focusInput.checked && currentOrigin !== null));

  const clear = () => {
    if (choosing) setChoosing(false);
    token++;
    currentOrigin = null;
    panel.hidden = true;
    setFocusMode(false);
    Promise.all(
      ['nearby-zone', 'nearby-hits', 'nearby-hit-lines', 'nearby-origin'].map((id) => setSourceData(id, null)),
    ).catch((e: unknown) => console.error('[nearby] clear failed', e));
  };

  /** カタログにあるデータ全部に聞く (画面に出していないものも数える)。 */
  const query = async (frame: NearbyFrame, distance: number): Promise<NearbyResult> => {
    await ensureSpatial();
    const zone = await conn.query(
      `SELECT ${fromMeters(frame, `ST_Buffer(${frame.origin}, ${distance})`)} AS geometry;`,
    );
    const zoneGeometry = geometryOf((zone.toArray()[0].toJSON() as { geometry: unknown }).geometry);

    const buildings: NearbyBuildings[] = [];
    for (const source of sources.buildings) {
      await source.ensure();
      const found = await fetchNearbyBuildings(conn, source, frame);
      if (found) buildings.push(found);
    }
    const names: NamedHits[] = [];
    for (const source of sources.railways) {
      await source.ensure();
      const expression =
        source.kind === 'railway_station'
          ? `station_name || '駅 (' || line_name || ')'`
          : `line_name || ' (' || operator || ')'`;
      names.push([
        source.kind === 'railway_station' ? '駅' : '鉄道',
        await fetchNearbyNames(conn, source, frame, expression),
        source.id,
      ]);
    }
    if (sources.road) {
      await sources.road.ensure();
      names.push([
        '道路',
        await fetchNearbyNames(
          conn,
          sources.road,
          frame,
          `coalesce(nullif(array_to_string(route_names, '・'), ''), road_name)`,
        ),
        sources.road.id,
      ]);
    }
    for (const source of sources.lines) {
      await source.ensure();
      names.push([source.title, await fetchNearbyNames(conn, source, frame, 'name'), source.id]);
    }
    // 人口は**いちばん細かいメッシュ**で数える (粗いと範囲からはみ出す分が増える)。
    let population: NearbyResult['population'] = null;
    for (const source of [...sources.meshes].sort((a, b) => b.digits - a.digits)) {
      if (!source.bbox || !bboxOverlaps(source.bbox, frame.bounds)) continue;
      await source.ensure();
      const found = await fetchNearbyPopulation(conn, source, frame);
      if (found && found.cells > 0) {
        population = { ...found, label: MESH_SIZE_LABELS[source.digits] ?? `${source.digits}桁` };
        break;
      }
    }
    return { zoneGeometry, buildings, names, population };
  };

  /** 周辺を調べて、パネルと地図に出す。 */
  const run = async (origin: NearbyOrigin) => {
    // 起点が変わったら、種類ごとの表示の切り替えと絞り込みを戻す
    // (距離を変えただけなら、選んでいた見せ方を保つ)。
    if (origin !== currentOrigin) view = { hidden: new Set(), focus: null };
    currentOrigin = origin;
    panel.hidden = false;
    fromSearchButton.hidden = lastSelection === null;
    const distance = Number(distanceSelect.value);
    originEl.textContent = `起点: ${origin.label} (${distance} m 以内)`;
    resultsEl.textContent = '調べています…';
    const mine = ++token;
    const frame = nearbyFrame(origin, distance, currentBounds());
    // **押したものをすぐ強調する** (結果を待たずに、何を起点にしたかが分かるように)。
    void (map.getSource('nearby-origin') as GeoJSONSource | undefined)?.setData({
      type: 'Feature',
      properties: { height: origin.height ?? null },
      geometry: origin.geometry,
    });
    // 周辺検索の層を**いちばん上へ**。データの層は一覧の順に積み直すので、その上に出す。
    // 下から 範囲 → 結果 → 起点 の順。
    for (const id of NEARBY_LAYERS) if (map.getLayer(id)) map.moveLayer(id);

    try {
      const result = await busy('周辺を調べています…', () => query(frame, distance));
      if (mine !== token) return;

      await setSourceData('nearby-zone', result.zoneGeometry);
      // 建物は1棟ずつ段の色で塗るので、属性ごと FeatureCollection で渡す。
      drawn = {
        buildings: result.buildings.flatMap((b) => b.features),
        // 線は種類 (駅・鉄道・道路・送電線・川) で塗り分け、種類ごとに切り替える。
        lines: result.names.flatMap(([kind, found, sourceId]) =>
          found.features.map((feature) => ({
            ...feature,
            properties: { ...feature.properties, kind, origin: sourceId },
          })),
        ),
      };
      await (map.getSource('nearby-hits') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: drawn.buildings,
      });
      await (map.getSource('nearby-hit-lines') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: drawn.lines,
      });
      applyView();
      setFocusMode(focusInput.checked);
      render(result, frame);
    } catch (e) {
      console.error('[nearby] failed', e);
      if (mine === token) resultsEl.textContent = '調べられませんでした';
    }
  };

  const render = (result: NearbyResult, frame: NearbyFrame) => {
    const list = document.createElement('dl');
    /**
     * 1種類ぶんの行。見出しに**地図に出すかのチェック** (`key` があるとき)、中身に件数と名前。
     * 件数は数字を大きく出して、名前は押せる札にする (押すとそれだけを残して寄る)。
     */
    const row = (term: string, key: string | null, ...value: (string | Node)[]) => {
      const dt = document.createElement('dt');
      if (key) {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !view.hidden.has(key);
        box.dataset.nearbyKind = key;
        box.title = '地図に出す';
        box.addEventListener('change', () => {
          if (box.checked) view.hidden.delete(key);
          else view.hidden.add(key);
          applyView();
        });
        label.append(box, term);
        dt.append(label);
      } else {
        dt.textContent = term;
      }
      const dd = document.createElement('dd');
      dd.append(...value);
      list.append(dt, dd);
    };
    const count = (n: number, unit: string) => {
      const strong = document.createElement('strong');
      strong.className = 'nearby-count';
      strong.textContent = `${n.toLocaleString()} ${unit}`;
      return strong;
    };
    /** 押せる名前の札。押すとそれだけを残して寄る (もう一度で戻る)。 */
    const chips = (kind: string, names: string[], rest: number): HTMLElement => {
      const box = document.createElement('div');
      box.className = 'nearby-chips';
      for (const name of names) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'nearby-chip';
        chip.textContent = name;
        chip.title = 'これだけを地図に残して寄る';
        const pressed = view.focus?.kind === kind && view.focus.name === name;
        chip.setAttribute('aria-pressed', String(pressed));
        chip.addEventListener('click', () => {
          focusOn(kind, name);
          // 名前の札だけを戻す (段の札は出し入れの印なので触らない)。
          for (const other of resultsEl.querySelectorAll('.nearby-chip:not(.tier)')) {
            other.setAttribute('aria-pressed', 'false');
          }
          chip.setAttribute('aria-pressed', String(view.focus !== null));
        });
        box.append(chip);
      }
      if (rest > 0) {
        const more = document.createElement('span');
        more.className = 'nearby-more';
        more.textContent = `ほか${rest}件`;
        box.append(more);
      }
      return box;
    };
    /** 建物の段ごとの件数。押すと、その段を地図に出すかを切り替える。 */
    const tierToggles = (counts: [string, number][]): HTMLElement => {
      const box = document.createElement('div');
      box.className = 'nearby-chips';
      counts.forEach(([title, n], rank) => {
        if (n === 0) return;
        const key = `段:${title}`;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'nearby-chip tier';
        chip.dataset.rank = String(rank);
        chip.textContent = `${title} ${n.toLocaleString()}`;
        chip.title = 'この段を地図に出す / 隠す';
        chip.setAttribute('aria-pressed', String(!view.hidden.has(key)));
        chip.addEventListener('click', () => {
          if (view.hidden.has(key)) view.hidden.delete(key);
          else view.hidden.add(key);
          chip.setAttribute('aria-pressed', String(!view.hidden.has(key)));
          applyView();
        });
        box.append(chip);
      });
      return box;
    };

    if (result.buildings.length === 0 && sources.buildings.length > 0) row('建物', null, 'なし');
    for (const found of result.buildings) {
      const group = collections.find((c) => c.id === found.source.id)?.group?.title;
      const total = found.counts.reduce((sum, [, n]) => sum + n, 0);
      const shown = found.named.slice(0, 10);
      row(
        `建物${group ? ` (${group})` : ''}`,
        '建物',
        count(total, '棟'),
        tierToggles(found.counts),
        ...(shown.length > 0 ? [chips('建物', shown, found.named.length - shown.length)] : []),
      );
    }
    for (const [label, { names, total }] of result.names) {
      if (total === 0) {
        row(label, null, 'なし');
        continue;
      }
      row(label, label, count(total, '件'), chips(label, names, total - names.length));
    }
    if (result.population) {
      row(
        '人口',
        null,
        count(Math.round(result.population.population), '人'),
        ` (概算。${result.population.label}メッシュ ${result.population.cells.toLocaleString()} 個の合計)`,
      );
    }
    const notes: string[] = [];
    if (result.population) {
      notes.push('人口は範囲に掛かるメッシュの値の合計なので、範囲より広い分を含みます。');
    }
    if (frame.clipped) {
      notes.push('起点が画面より大きいので、表示範囲の中だけを数えています。');
    }
    if (result.buildings.some((b) => b.features.length >= NEARBY_DRAW_LIMIT)) {
      notes.push(`地図に描く建物は${NEARBY_DRAW_LIMIT.toLocaleString()}件までです (数は全部)。`);
    }
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = notes.join(' ');
    resultsEl.replaceChildren(list, ...(notes.length > 0 ? [note] : []));
  };

  distanceSelect.addEventListener('change', () => {
    if (currentOrigin) void run(currentOrigin);
  });
  fromSearchButton.addEventListener('click', () => {
    if (!lastSelection) return;
    setChoosing(false);
    void run(lastSelection);
  });
  document.querySelector('#nearby-close')!.addEventListener('click', clear);

  return {
    setChoosing,
    choosing: () => choosing,
    isOpen: () => !panel.hidden,
    clear,
    remember: (label, geometry) => {
      lastSelection = { label, geometry };
      fromSearchButton.hidden = false;
    },
    distance: () => distanceSelect.value,
  };
}
