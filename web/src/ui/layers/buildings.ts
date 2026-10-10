/**
 * **建物** (PLATEAU と Overture)。一覧では出所ごとに行が分かれ、絞り込みのパネルは共有する。
 *
 * **出所ごとに引いて1つのソースにまとめる。** 地物に `origin` (Collection ID) を
 * 持たせて塗り分けるので、地図のレイヤーは出所が増えても1組のまま。
 * 上限は出所ごとに掛かる (両方出せば最大で2倍描く)。
 *
 * ズームで出し方が変わる: 全部 / 重要な段だけ (間引き) / 整備範囲のメッシュ ([`buildingDepth`])。
 */
import type { ExpressionSpecification, FilterSpecification, GeoJSONSource } from 'maplibre-gl';
import { sourceLodNote, type BuildingSource } from '../../lib/sources';
import { registerPmtiles } from '../../lib/tiles';
import { MESH_SIZE_LABELS, meshDigits } from '../../lib/mesh';
import {
  coverageFeatureCollection,
  fetchBuildingsInView,
  fetchCoverageInView,
  type BuildingFilter,
} from '../../lib/queries';
import {
  BUILDING_COLOR_BY_HEIGHT,
  BUILDING_COLOR_BY_TIER,
  EMPTY_FEATURE_COLLECTION,
  buildingTilesLayerId,
  tileColor,
} from '../map';
import { requester, type DrawContext } from './context';
import { m } from '../../i18n';

export interface BuildingLayers {
  request: () => void;
  /** 共有している絞り込みのパネルを、その出所に向ける (どちらの ⚙ を押したか)。 */
  pointSettings: (source: BuildingSource) => void;
}

export function createBuildingLayers(ctx: DrawContext, sources: BuildingSource[]): BuildingLayers {
  const { map } = ctx;
  const filtersEl = document.querySelector<HTMLDivElement>('#building-filters')!;
  const heightField = document.querySelector<HTMLDivElement>('#height-field')!;
  const usageField = document.querySelector<HTMLDivElement>('#usage-field')!;
  const minHeightInput = document.querySelector<HTMLInputElement>('#min-height')!;
  const minHeightValue = document.querySelector<HTMLOutputElement>('#min-height-value')!;
  const usageOptionsEl = document.querySelector<HTMLDivElement>('#usage-options')!;
  const tierField = document.querySelector<HTMLDivElement>('#tier-field')!;
  const tierOptionsEl = document.querySelector<HTMLDivElement>('#tier-options')!;
  const tierColorToggle = document.querySelector<HTMLInputElement>('#tier-color')!;
  const usageAllButton = document.querySelector<HTMLButtonElement>('#usage-all')!;
  const usageNoneButton = document.querySelector<HTMLButtonElement>('#usage-none')!;
  const countEl = document.querySelector<HTMLParagraphElement>('#building-count')!;

  let token = 0;
  /**
   * 設定パネルを向けている出所。**描く出所とは別。**
   * 描くのは一覧で出しているもの全部 (PLATEAUとOvertureを同時に出せる)。
   * ここが決めるのは、共有している設定パネルの中身をどちらに向けるかだけ。
   */
  let settingsSource: BuildingSource | undefined = sources[0];
  /**
   * 絞り込み。**出所ごとに持つ。** 用途の語彙が出所ごとに違う
   * (PLATEAUは「商業施設」、Overtureは `commercial`) ので、共有すると意味が変わる。
   */
  const filters = new Map<string, BuildingFilter>(
    sources.map((source) => [source.id, { minHeight: 0, usages: null, tiers: null }]),
  );
  const filterOf = (source: BuildingSource): BuildingFilter => filters.get(source.id)!;

  // ---- 引いた表示のタイル ----------------------------------------------------------
  //
  // **段で間引くズームでは、GeoParquet を読まずにタイル (PMTiles) を描く。** DuckDB は1回ずつ順に
  // 読むので、都市ごとのファイルを十数個開くと R2 では1分近くかかった。MapLibre はタイルを並列に取る
  // (東京駅 z13 で 39秒 → 10秒)。**タイルは数えられない**ので、件数は寄った表示でだけ出す。
  // 層は出所ごとに1つ。塗りは GeoJSON の層と同じ規則から作る (`tileColor`)。
  const colorFor = (byTier: boolean) => (byTier ? BUILDING_COLOR_BY_TIER : BUILDING_COLOR_BY_HEIGHT);
  for (const [palette, source] of sources.entries()) {
    if (!source.tiles) continue;
    registerPmtiles();
    const id = buildingTilesLayerId(source.id);
    map.addSource(id, { type: 'vector', url: `pmtiles://${source.tiles.url}` });
    map.addLayer(
      {
        id,
        type: 'fill-extrusion',
        source: id,
        'source-layer': source.tiles.layer,
        layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': tileColor(colorFor(tierColorToggle.checked), palette),
          'fill-extrusion-height': ['coalesce', ['get', 'height'], 3],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.9,
        },
      },
      // GeoJSON の建物の層のすぐ下 (一覧の重ね順を変えても、main.ts が一緒に動かす)。
      'buildings-3d',
    );
  }

  /** このズームの段をタイルで描けるか (タイルに入っている段まで)。 */
  const drawsWithTiles = (source: BuildingSource, depth: 'all' | number | null | undefined): depth is number =>
    typeof depth === 'number' && source.tiles !== undefined && depth <= source.tiles.lodMax;

  /**
   * タイルの絞り込み。問い合わせ (`fetchBuildingsInView`) と同じ条件を、スタイルの式で書く。
   * 用途の列はタイルでは `category` にそろえてある (build_building_tiles)。段の順位は `lod`。
   */
  const tileFilter = (source: BuildingSource, depth: number): FilterSpecification => {
    const filter = filterOf(source);
    const conditions: ExpressionSpecification[] = [['<=', ['get', 'lod'], depth]];
    if (source.hasHeight && filter.minHeight > 0) {
      // 問い合わせの `height >= x` と同じく、高さの無い建物は外す。
      conditions.push(['>=', ['coalesce', ['get', 'height'], -1], filter.minHeight]);
    }
    if (source.categoryColumn && filter.usages) {
      conditions.push(['in', ['get', 'category'], ['literal', filter.usages]]);
    }
    if (source.tiers && filter.tiers) {
      const ranks = source.tiers.tiers.flatMap((tier, rank) => (filter.tiers!.includes(tier.id) ? [rank] : []));
      conditions.push(['in', ['get', 'lod'], ['literal', ranks]]);
    }
    return ['all', ...conditions];
  };

  /** タイルの層を出し入れする。`depth` が数でタイルに入っている段なら出し、それ以外は隠す。 */
  const showTiles = (source: BuildingSource, depth: 'all' | number | null | undefined) => {
    const id = buildingTilesLayerId(source.id);
    if (!map.getLayer(id)) return;
    if (drawsWithTiles(source, depth)) {
      map.setFilter(id, tileFilter(source, depth));
      map.setLayoutProperty(id, 'visibility', 'visible');
    } else {
      map.setLayoutProperty(id, 'visibility', 'none');
    }
  };

  /** 行の状態に書き、パネルを向けている出所なら件数の欄にも出す。 */
  const showStatus = (source: BuildingSource, text: string) => {
    ctx.setStatus(source.id, text);
    if (source === settingsSource) countEl.textContent = text;
  };

  /**
   * このズームで建物をどこまで出すか。`'all'` = 全部、数字 = その順位の段まで (間引き)、
   * `null` = 建物は出さない (整備範囲を出すか、寄れと言う)。
   *
   * **1ズーム引くごとに1段減らす。** 画面の面積は1ズームで4倍になるので、
   * 段を1つ落とすことで読む量を抑える。実測 (東京駅・1280×720):
   * z13 で公共施設だけなら1.0万棟・1.9MB (全部なら22万棟・31MB)、
   * z14 で商業・業務までなら1.7万棟・2.5MB。
   * 段の列 (`lod_column`) を持たない出所は間引けないので、全部か無しか。
   */
  const buildingDepth = (source: BuildingSource, zoom: number): 'all' | number | null => {
    const steps = Math.ceil(ctx.detail().buildingsMinZoom - zoom);
    if (steps <= 0) return 'all';
    const tiers = source.tiers;
    if (!tiers?.lod_column) return null;
    const rank = tiers.tiers.length - 1 - steps;
    return rank >= 0 ? rank : null;
  };

  /** その出所の建物が出始めるズーム (間引いた段を含む)。 */
  const firstVisibleZoom = (source: BuildingSource): number =>
    source.tiers?.lod_column
      ? ctx.detail().buildingsMinZoom - (source.tiers.tiers.length - 1)
      : ctx.detail().buildingsMinZoom;

  const refresh = async () => {
    const mapSource = map.getSource('buildings') as GeoJSONSource | undefined;
    const coverage = map.getSource('buildings-coverage') as GeoJSONSource | undefined;
    if (!mapSource || sources.length === 0) return;
    // **世代は最初に進める。** 全部外したときの早期 return の前でないと、読み込み中だった
    // 前の要求が「まだ最新」のまま終わり、外したあとに建物を描いてしまう (実際に起きた)。
    const mine = ++token;

    const visible = sources.filter((source) => ctx.isVisible(source.id));
    // 取得を始める前に件数表示を空にする。引いていたときの「拡大すると建物が出ます」が
    // 残っていると、すでに寄っている利用者に拡大しろと言い続けることになる。
    for (const source of sources) showStatus(source, '');

    const zoom = map.getZoom();
    const depths = new Map(visible.map((source) => [source, buildingDepth(source, zoom)]));
    // **タイルはすぐ出し入れする** (読むのは MapLibre。下の問い合わせを待たない)。外した出所は隠す。
    for (const source of sources) showTiles(source, depths.get(source));

    if (visible.length === 0) {
      await coverage?.setData(EMPTY_FEATURE_COLLECTION);
      await mapSource.setData(EMPTY_FEATURE_COLLECTION);
      return;
    }

    const bounds = ctx.currentBounds();
    const detail = ctx.detail();

    // 状態は最後にまとめて出す。途中で打ち切ったとき (地図が動いた) に
    // 片方の出所だけ新しい件数が出る、という食い違いを作らない。
    const statuses: [BuildingSource, string][] = [];

    // **引いた表示では整備範囲を出す** (段で間引いても出せないほど引いたとき)。
    const coverageFeatures: GeoJSON.Feature[] = [];
    for (const source of visible) {
      if (depths.get(source) !== null) continue;
      if (!source.coverage) {
        // 整備範囲を持たない出所は、引いた表示では何も描かない。
        // **どこまで寄れば出るかを数字で言う。**
        statuses.push([source, m.zoomInToShow(firstVisibleZoom(source))]);
        continue;
      }
      const area = source.coverage;
      // 配られているより細かくはできない。引くほど粗く束ねる。
      const digits = Math.min(meshDigits(zoom), area.meshDigits);
      const cells = await ctx.busy(m.loadingNamed(m.coverage), async () => {
        await area.ensure();
        return fetchCoverageInView(ctx.conn, area, bounds, digits);
      });
      if (mine !== token) return;
      coverageFeatures.push(...coverageFeatureCollection(cells).features);
      const buildings = cells.reduce((total, cell) => total + cell.buildings, 0);
      statuses.push([
        source,
        m.coverageSummary(
          cells.length,
          MESH_SIZE_LABELS[digits] ?? m.meshDigits(digits),
          buildings,
          firstVisibleZoom(source),
        ),
      ]);
    }
    await coverage?.setData({ type: 'FeatureCollection', features: coverageFeatures });

    const features: GeoJSON.Feature[] = [];
    for (const source of visible) {
      const depth = depths.get(source);
      if (depth === null || depth === undefined) continue;
      if (drawsWithTiles(source, depth)) {
        // **タイルは数えられない。** どこまで出しているか (段) だけを言い、件数は寄ったときに出す。
        statuses.push([
          source,
          m.shownAsTiles +
            m.thinnedTiers(
              source.tiers!.tiers.slice(0, depth + 1).map((t) => t.title),
              detail.buildingsMinZoom,
            ),
        ]);
        continue;
      }
      const rows = await ctx.busy(m.loadingNamed(m.buildings), async () => {
        await source.ensure();
        return fetchBuildingsInView(
          ctx.conn,
          source,
          bounds,
          filterOf(source),
          detail.buildingsLimit,
          depth === 'all' ? undefined : depth,
        );
      });
      if (mine !== token) return;

      for (const row of rows) {
        features.push({
          type: 'Feature',
          properties: {
            name: row.name,
            category: row.category,
            height: row.height,
            // **どの出所の建物か。** ホバーの「出所」に使う。
            origin: source.id,
            // 塗り分けの番号。IDを塗りの式に書くと出所が増えたときに直す場所が
            // 分かれるので、カタログに並んだ順番で渡す。
            palette: sources.indexOf(source),
            // **重要度の段。** 名前はホバー用、順位は色分け用 (0がいちばん重要)。
            // 段の無い出所では -1 にして、色分けでも既定の塗りに落とす。
            tier: source.tiers?.tiers.find((t) => t.id === row.tier)?.title ?? null,
            tierRank: source.tiers?.tiers.findIndex((t) => t.id === row.tier) ?? -1,
          },
          geometry: row.geojson,
        });
      }
      const count =
        rows.length >= detail.buildingsLimit ? m.atLeastItemsCapped(detail.buildingsLimit) : m.itemCount(rows.length);
      // **間引いているときは、どこまで出しているかを言う。** 黙って減らすと
      // 「住宅が無い」と読まれてしまう。
      const thinned =
        depth === 'all'
          ? ''
          : m.thinnedTiers(
              source.tiers!.tiers.slice(0, depth + 1).map((t) => t.title),
              detail.buildingsMinZoom,
            );
      statuses.push([source, count + thinned + sourceLodNote(source, bounds)]);
    }
    await mapSource.setData({ type: 'FeatureCollection', features });
    for (const [source, text] of statuses) showStatus(source, text);
  };

  const request = requester(ctx, 'buildings', m.buildings, refresh);

  // ---- 絞り込みのパネル (共有) ------------------------------------------------------

  /** チェック状態を条件に反映する。全部入っていれば「絞っていない」= null。 */
  const syncUsageFilter = (all: string[]) => {
    if (!settingsSource) return;
    const checked = [...usageOptionsEl.querySelectorAll<HTMLInputElement>('input:checked')];
    filterOf(settingsSource).usages = checked.length === all.length ? null : checked.map((c) => c.value);
    request();
  };

  // 選択肢はカタログに入っているので、**ここでデータを読まない**。
  // 以前はここで全ファイルの用途の列を走査していて、起動のたびに
  // ファイルの数だけ往復していた。
  const showFilters = (source: BuildingSource) => {
    const filter = filterOf(source);
    heightField.hidden = !source.hasHeight;
    usageField.hidden = source.categoryColumn === null;
    filtersEl.hidden = !source.hasHeight && source.categoryColumn === null;

    // **その出所の絞り込みを戻す。** パネルは共有なので、開き直すたびに
    // 前に開いていた出所の値が残っている。
    minHeightInput.value = String(filter.minHeight);
    minHeightValue.textContent = `${filter.minHeight} m`;

    // **重要度の段。** 段の規則はカタログから来るので、出所ごとに作り直す
    // (題名は同じでも、何がどの段に入るかは出所の語彙で違う)。
    tierField.hidden = !source.tiers;
    tierOptionsEl.replaceChildren();
    for (const tier of source.tiers?.tiers ?? []) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = tier.id;
      checkbox.checked = filter.tiers === null || filter.tiers.includes(tier.id);
      checkbox.addEventListener('change', () => {
        const all = source.tiers!.tiers.map((t) => t.id);
        const checked = [...tierOptionsEl.querySelectorAll<HTMLInputElement>('input:checked')];
        filter.tiers = checked.length === all.length ? null : checked.map((c) => c.value);
        request();
      });
      // 何が入るのかを添える。段の名前だけでは「業務」に工場が入るのか分からない。
      label.title = tier.values.length > 0 ? tier.values.join('・') : m.noTier;
      label.append(checkbox, document.createTextNode(tier.title));
      tierOptionsEl.append(label);
    }

    if (source.categoryColumn === null) return;
    const usages = source.usages;

    // 出所ごとに語彙が違うので、切り替えのたびに作り直す。
    usageOptionsEl.replaceChildren();
    for (const usage of usages) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = usage;
      checkbox.checked = filter.usages === null || filter.usages.includes(usage);
      checkbox.addEventListener('change', () => syncUsageFilter(usages));
      label.append(checkbox, document.createTextNode(usage));
      usageOptionsEl.append(label);
    }

    // 1つだけ見たいときに13個外させない。「なし」→目的の1つ、で済むようにする。
    const setAll = (checked: boolean) => {
      for (const input of usageOptionsEl.querySelectorAll<HTMLInputElement>('input')) {
        input.checked = checked;
      }
      syncUsageFilter(usages);
    };
    usageAllButton.onclick = () => setAll(true);
    usageNoneButton.onclick = () => setAll(false);
  };

  const pointSettings = (source: BuildingSource) => {
    settingsSource = source;
    showFilters(source);
    countEl.textContent = ctx.statusOf(source.id);
  };

  if (settingsSource) {
    map.on('moveend', request);

    // **重要度で色分けする。** 重要な段を目立たせ、住宅・その他を退かせる。
    // 引き直さず塗りだけを替える (段は既に地物に入っている)。出所をまたいで効く。
    tierColorToggle.addEventListener('change', () => {
      map.setPaintProperty('buildings-3d', 'fill-extrusion-color', colorFor(tierColorToggle.checked));
      // タイルの層も同じ規則で塗り替える。
      for (const [palette, source] of sources.entries()) {
        const id = buildingTilesLayerId(source.id);
        if (map.getLayer(id)) {
          map.setPaintProperty(id, 'fill-extrusion-color', tileColor(colorFor(tierColorToggle.checked), palette));
        }
      }
    });

    showFilters(settingsSource);

    // スライダーは動かすたびにイベントが飛ぶので、少し待ってからクエリする。
    let heightTimer: ReturnType<typeof setTimeout> | undefined;
    minHeightInput.addEventListener('input', () => {
      if (!settingsSource) return;
      const filter = filterOf(settingsSource);
      filter.minHeight = Number(minHeightInput.value);
      minHeightValue.textContent = `${filter.minHeight} m`;
      clearTimeout(heightTimer);
      heightTimer = setTimeout(request, 200);
    });
  }

  return { request, pointSettings };
}
