/**
 * **レイヤーの一覧** (左下) と、**カタログから足すダイアログ**。
 *
 * 一覧には**使うものだけを置く。** カタログにあるもの全部を並べると、出所が増えるほど
 * 一覧が伸びて、見たいものを探すのに開け閉めが要った (地理院のベクトルタイルだけで100層を超える)。
 * 足すのはダイアログから、外すのは行の ✕ から。**チェックを外しても一覧からは消えない**
 * (以前は地図タイルを外すと「足す」の中へ戻り、出し直すたびに探し直していた)。
 *
 * 区分はデータ (GeoParquet) と地図タイルの2つ。どちらも**上の行ほど上に重なり**、↑↓ で入れ替える。
 * データは地図タイルより常に上。
 *
 * 置いたもの・順番・出しているかは端末に覚えておく (localStorage)。
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Bbox, CatalogGroup, Collection, VectorLayerInfo } from '../lib/stac';
import type { BuildingCoverage } from '../lib/sources';
import type { VectorOverlay } from '../lib/tiles';

/** 一覧の区分。データ (SQL で引ける GeoParquet) と、見るだけの地図タイル。 */
export type Section = 'data' | 'tile';

/**
 * 一覧の行。**行とCollectionはほぼ1対1** (人口メッシュは細かさ違いを1行に束ね、
 * 地理院のベクトルタイルはテーマごとに1行にする)。
 */
export interface Layer {
  /** 先頭のCollectionのID。**行とCollectionを同じ名前で呼ぶ。** */
  id: string;
  title: string;
  /** どのサブカタログの下か。カタログのダイアログの見出しになる。 */
  group: CatalogGroup | undefined;
  /** この行を作っているCollection。ⓘ で中身を見せる。 */
  collections: Collection[];
  /** 行の2段目に添える版や形式 (出所の名前は一覧が足す)。 */
  vintage?: string;
  /** 収録範囲。**この場所にあるか**の判定に使う。複数Collectionなら和。 */
  bbox: Bbox | null;
  visible: boolean;
  section: Section;
  /** 既定の重なり (小さいほど上)。**データを足したときに入る位置**を決める。 */
  rank: number;
  /** この行を描く地図の層。重ね順を地図に写すのに使う (まだ作っていなければ空)。 */
  mapLayerIds: () => string[];
  /** 出るのに要るズーム。**無ければどの縮尺でも出る。** */
  minZoom?: number;
  /** 絞り込み・色分けの中身。⚙ で行の下に開く。**複数の行で共有することがある。** */
  settings: HTMLElement;
  /** 共有している設定パネルを、この行に向ける。 */
  onOpen?: () => void;
  refresh: () => void;
  /** 整備範囲。あれば「この範囲にあるか」をこれで決める (main が見る)。 */
  coverage?: BuildingCoverage;
  /**
   * **中の層** (外部のベクトルタイルのテーマ)。行を開くと層ごとに入り切りできる。
   * 入り切りの状態は `overlay.visible` が持つ (**ズームでは変えない**)。
   */
  parts?: { overlay: VectorOverlay; layers: VectorLayerInfo[] };
  /** この地図では描けない理由 (3D Tiles)。あれば一覧に足せない。 */
  viewOnly?: string;
}

/** 区分ごとの目印の層 (描かない)。その区分の層は、この直下に重ねる。 */
export const LAYER_ANCHORS: Record<Section, string> = {
  tile: 'anchor/tiles',
  data: 'anchor/data',
};

export interface LayerListOptions {
  map: MapLibreMap;
  layers: Layer[];
  /** 行に出す状態 (件数や「ズーム14から」)。 */
  statusOf: (id: string) => string;
  /** この範囲にあるか (箱と整備範囲で決める)。 */
  isPresent: (layer: Layer) => boolean;
  /** ⓘ (カタログ・使う条件・取得) を開く。 */
  openDetails: (layer: Layer) => void;
  /** サブカタログの JSON を開くボタン。 */
  catalogLink: (path: string | undefined, label: string) => HTMLElement;
}

export interface LayerList {
  /** 一覧 (とカタログのダイアログを開いていればそれも) を描き直す。 */
  render: () => void;
  /** 地図の重ね順を一覧に合わせる。**層をあとから作ったら呼ぶ** (地理院のテーマ)。 */
  applyOrder: () => void;
  /** 一覧に置いているか。 */
  isPlaced: (id: string) => boolean;
}

const STORAGE_KEY = 'duck-geocoder:layers';

/** 覚えておく1行ぶん。中の層は、出しているもの (隠しているなら、出すときに戻すもの)。 */
interface SavedRow {
  id: string;
  visible: boolean;
  parts?: string[];
}

type Saved = Record<Section, SavedRow[]>;

function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Saved>;
    if (!Array.isArray(value.data) || !Array.isArray(value.tile)) return null;
    return { data: value.data, tile: value.tile };
  } catch {
    // 壊れていたら既定で始める (覚えておくのは便利のためで、無くても使える)。
    return null;
  }
}

const SECTION_TITLES: Record<Section, string> = { data: 'データ', tile: '地図タイル' };

/** 「ズーム14から」。**行は消さない** — 消すと、寄れば出ることが分からない。 */
const fromZoom = (minzoom: number) => `ズーム${minzoom}から`;

export function createLayerList(options: LayerListOptions): LayerList {
  const { map, layers, statusOf, isPresent, openDetails, catalogLink } = options;
  const byId = new Map(layers.map((layer) => [layer.id, layer]));

  const rowsEl: Record<Section, HTMLElement> = {
    data: document.querySelector<HTMLDivElement>('#layer-rows')!,
    tile: document.querySelector<HTMLDivElement>('#tile-rows')!,
  };
  const emptyEl: Record<Section, HTMLElement> = {
    data: document.querySelector<HTMLParagraphElement>('#layer-empty')!,
    tile: document.querySelector<HTMLParagraphElement>('#tile-empty')!,
  };
  const storeEl = document.querySelector<HTMLDivElement>('#layer-settings-store')!;
  const dialog = document.querySelector<HTMLDialogElement>('#layer-catalog-dialog')!;
  const catalogRowsEl = document.querySelector<HTMLDivElement>('#catalog-rows')!;
  const filterEl = document.querySelector<HTMLInputElement>('#layer-filter')!;
  const filterEmptyEl = document.querySelector<HTMLElement>('#layer-filter-empty')!;
  const tabs = [...dialog.querySelectorAll<HTMLButtonElement>('.catalog-tab')];

  /** 一覧に置いている行ID。区分ごとに**先頭がいちばん上**。 */
  const order: Record<Section, string[]> = { data: [], tile: [] };
  /** 隠したテーマの、出していた中の層 (出し直すときに戻す)。 */
  const lastParts = new Map<string, string[]>();
  /** 中の層を開いている行。**描き直しても開いたまま**にする。 */
  const expandedRows = new Set<string>();
  /**
   * 絞り込み・色分けを開いている行。**1つだけ** — 建物 (PLATEAUとOverture) と鉄道
   * (路線と駅) は設定の要素を共有しているので、2行で同時に開けない。
   */
  let settingsRowId: string | null = null;
  let catalogSection: Section = 'data';

  // ---- 出し入れ ----------------------------------------------------------------

  const shownParts = (layer: Layer): string[] =>
    layer.parts?.layers.filter((part) => layer.parts!.overlay.visible.get(part.id)).map((part) => part.id) ??
    [];

  /** 出す / 隠す。テーマは中の層ごと (隠す前に出していた層を覚えておき、出すときに戻す)。 */
  const setVisible = (layer: Layer, visible: boolean, parts?: string[]) => {
    layer.visible = visible;
    const p = layer.parts;
    if (!p) return;
    if (!visible) {
      const shown = shownParts(layer);
      if (shown.length > 0) lastParts.set(layer.id, shown);
    }
    const chosen = parts ?? lastParts.get(layer.id);
    for (const part of p.layers) {
      p.overlay.visible.set(part.id, visible && (!chosen || chosen.length === 0 || chosen.includes(part.id)));
    }
  };

  const save = () => {
    const rows = (section: Section): SavedRow[] =>
      order[section].map((id) => {
        const layer = byId.get(id)!;
        const parts = layer.parts ? (layer.visible ? shownParts(layer) : lastParts.get(id)) : undefined;
        return { id, visible: layer.visible, ...(parts ? { parts } : {}) };
      });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ data: rows('data'), tile: rows('tile') }));
    } catch {
      // 保存できない環境 (プライベートモードなど) でも一覧は使える。
    }
  };

  /**
   * 重ね順を地図に写す。**下から順に、区分の目印の直下へ動かす** (動かすたびにその直下へ
   * 入るので、最後に動かしたものがいちばん上になる)。
   */
  const applyOrder = () => {
    for (const section of ['tile', 'data'] as const) {
      const anchor = LAYER_ANCHORS[section];
      if (!map.getLayer(anchor)) continue;
      for (const id of [...order[section]].reverse()) {
        for (const mapLayer of byId.get(id)?.mapLayerIds() ?? []) {
          if (map.getLayer(mapLayer)) map.moveLayer(mapLayer, anchor);
        }
      }
    }
  };

  /**
   * 一覧に足す (出した状態で)。地図タイルは**いちばん上**に (足したものが見えるように)、
   * データは**既定の重なりの位置**に入れる (人口メッシュを足して建物が塗りの下に沈まないように)。
   */
  const place = (layer: Layer, parts?: string[]) => {
    const list = order[layer.section];
    if (list.includes(layer.id) || layer.viewOnly) return;
    if (layer.section === 'tile') {
      list.unshift(layer.id);
    } else {
      const at = list.findIndex((id) => (byId.get(id)?.rank ?? 0) > layer.rank);
      list.splice(at < 0 ? list.length : at, 0, layer.id);
    }
    setVisible(layer, true, parts);
    layer.refresh();
    applyOrder();
    save();
    render();
  };

  /** 一覧から外す (地図からも消す)。 */
  const remove = (layer: Layer) => {
    order[layer.section] = order[layer.section].filter((id) => id !== layer.id);
    if (settingsRowId === layer.id) settingsRowId = null;
    setVisible(layer, false);
    lastParts.delete(layer.id);
    layer.refresh();
    save();
    render();
  };

  const move = (layer: Layer, delta: -1 | 1) => {
    const list = order[layer.section];
    const index = list.indexOf(layer.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    applyOrder();
    save();
    render();
  };

  // ---- 一覧の行 ------------------------------------------------------------------

  const iconButton = (className: string, text: string, title: string, onClick: () => void) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
  };

  /** 中身のある設定か。送電線・川・地理院のテーマは絞り込みを持たない (⚙ を出さない)。 */
  const hasSettings = (layer: Layer) => layer.settings.childElementCount > 0;

  const row = (layer: Layer): HTMLElement => {
    const present = isPresent(layer);
    const el = document.createElement('div');
    el.className = present ? 'layer-row' : 'layer-row absent';
    el.dataset.layer = layer.id;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = `layer-toggle-${layer.id}`;
    toggle.checked = layer.visible;
    const parts = layer.parts;
    if (parts) {
      // テーマの入り切りは**中の層をまとめて**。一部だけ出しているときは中間の印。
      const on = shownParts(layer).length;
      toggle.checked = on === parts.layers.length;
      toggle.indeterminate = on > 0 && on < parts.layers.length;
      layer.visible = on > 0;
    }
    toggle.addEventListener('change', () => {
      // テーマを中間の印から押したら、覚えている層ではなく全部を出す。
      setVisible(layer, toggle.checked, parts && toggle.checked ? parts.layers.map((p) => p.id) : undefined);
      layer.refresh();
      save();
      if (parts) render();
    });

    const name = document.createElement('label');
    name.className = 'layer-name';
    name.htmlFor = toggle.id;
    name.textContent = layer.title;

    // **いまの位置のまま寄る。** 見たい場所は既に画面にあることが多く、足りないのはズームだけ。
    const zoomIn = iconButton('layer-zoom-button', '🔍', `ズーム${layer.minZoom ?? 0}まで寄る`, () => {
      if (layer.minZoom === undefined) return;
      // 出していなければ一緒に出す。寄っただけで何も出ないのは分かりにくい。
      if (!layer.visible) {
        setVisible(layer, true);
        toggle.checked = true;
        save();
      }
      map.easeTo({ zoom: layer.minZoom, duration: 600 });
      layer.refresh();
    });
    zoomIn.hidden = layer.minZoom === undefined;

    // **ボタンは性格で分ける。** ⚙ = 地図を見ながら動かすもの (絞り込み・色分け・不透明度) を
    // この行の下に開く。ⓘ = 読むもの (カタログ・使う条件・取得) をダイアログで開く。
    const settingsOpen = settingsRowId === layer.id;
    const settings = iconButton(
      'layer-settings-button',
      '⚙',
      settingsOpen ? '絞り込みを閉じる' : `${layer.title}の絞り込み・色分け`,
      () => {
        settingsRowId = settingsRowId === layer.id ? null : layer.id;
        // 共有している設定を、開いた行の出所に向ける (建物ならPLATEAUかOvertureか)。
        if (settingsRowId) layer.onOpen?.();
        render();
      },
    );
    settings.setAttribute('aria-expanded', String(settingsOpen));
    settings.hidden = !hasSettings(layer);

    const detail = iconButton('layer-detail-button', 'ⓘ', `${layer.title}について (カタログ・使う条件・取得)`, () =>
      openDetails(layer),
    );

    const head = document.createElement('div');
    head.className = 'layer-head';
    head.append(toggle, name, zoomIn, settings, detail);

    // 2段目: 出所と版、重ね順 (↑↓) と外す (✕)。状態はその下に折り返す。
    // **1段目に詰めない** — ボタンが6つ並ぶと名前が潰れる (17.5remのパネル)。
    const source = document.createElement('span');
    source.className = 'layer-source';
    source.textContent = [layer.group?.title, layer.vintage, present ? null : 'この範囲には無い']
      .filter(Boolean)
      .join(' · ');
    const list = order[layer.section];
    const index = list.indexOf(layer.id);
    const up = iconButton('layer-move-button', '↑', '上へ (上に重ねる)', () => move(layer, -1));
    up.disabled = index <= 0;
    const down = iconButton('layer-move-button', '↓', '下へ (下に重ねる)', () => move(layer, 1));
    down.disabled = index === list.length - 1;
    const removeButton = iconButton('layer-remove-button', '✕', '一覧から外す', () => remove(layer));

    // 状態 (件数や「拡大すると出ます」) は**行に出す**。設定の中に置くと開かない限り読めない。
    const status = document.createElement('span');
    status.className = 'layer-status';
    status.dataset.layerStatus = layer.id;
    status.textContent = statusOf(layer.id);

    const sub = document.createElement('div');
    sub.className = 'layer-sub';
    sub.append(source, up, down, removeButton, status);

    el.append(head, sub);
    if (parts) appendParts(el, head, status, layer, parts);
    if (settingsOpen && hasSettings(layer)) {
      // 共有の要素を**この行へ移す** (作り直した行にも同じ要素が付いて回る)。
      const slot = document.createElement('div');
      slot.className = 'layer-settings-slot';
      layer.settings.hidden = false;
      slot.append(layer.settings);
      el.append(slot);
    }
    return el;
  };

  /**
   * テーマの行に、中の層を開く仕掛けと層ごとの行を足す。
   *
   * **ズームで行を出し入れしない。** いまのズームで描かれない層も行は残し、
   * 「ズーム16から」と添える。入り切りの状態もズームでは変えない
   * (地理院地図Vectorはズームで出る層が変わり、絞り込みが戻ってしまう)。
   */
  const appendParts = (
    el: HTMLElement,
    head: HTMLElement,
    status: HTMLElement,
    layer: Layer,
    parts: NonNullable<Layer['parts']>,
  ) => {
    const zoom = map.getZoom();
    const shown = parts.layers.filter((part) => parts.overlay.visible.get(part.id));
    // 出しているのに、いまのズームでは1つも描かれないなら、いつから描かれるかを言う。
    if (shown.length > 0 && shown.every((part) => zoom < part.minzoom)) {
      status.textContent = `${fromZoom(Math.min(...shown.map((part) => part.minzoom)))}描かれます`;
    }

    // 中が1層だけなら開く意味が無い (注記・建物・送電線)。
    if (parts.layers.length < 2) return;
    const open = expandedRows.has(layer.id);
    const expander = iconButton(
      'layer-expander',
      open ? '▾' : '▸',
      open ? '中の層をたたむ' : `中の層を開く (${parts.layers.length})`,
      () => {
        if (expandedRows.has(layer.id)) expandedRows.delete(layer.id);
        else expandedRows.add(layer.id);
        render();
      },
    );
    expander.setAttribute('aria-expanded', String(open));
    // 名前の右に置く。頭に置くと、開けない行とチェックボックスの位置がずれる。
    head.querySelector('.layer-name')?.after(expander);
    if (!open) return;

    const list = document.createElement('div');
    list.className = 'layer-parts';
    for (const part of parts.layers) {
      const item = document.createElement('label');
      item.className = zoom < part.minzoom ? 'layer-part later' : 'layer-part';
      item.dataset.part = part.id;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = parts.overlay.visible.get(part.id) ?? false;
      box.addEventListener('change', () => {
        parts.overlay.visible.set(part.id, box.checked);
        layer.visible = parts.layers.some((p) => parts.overlay.visible.get(p.id));
        layer.refresh();
        save();
        render();
      });
      const title = document.createElement('span');
      title.textContent = part.title;
      const note = document.createElement('span');
      note.className = 'layer-part-zoom';
      note.textContent = zoom < part.minzoom ? fromZoom(part.minzoom) : '';
      item.append(box, title, note);
      list.append(item);
    }
    el.append(list);
  };

  const renderList = () => {
    // 設定はいったん置き場へ戻す。開いている行があれば、作るときにまたそこへ移す
    // (戻さないと、閉じたときに作り直す前の行と一緒にDOMから外れたままになる)。
    for (const layer of layers) storeEl.append(layer.settings);
    for (const section of ['data', 'tile'] as const) {
      const rows = order[section].map((id) => byId.get(id)).filter((l): l is Layer => l !== undefined);
      rowsEl[section].replaceChildren(...rows.map(row));
      emptyEl[section].hidden = rows.length > 0;
    }
  };

  // ---- カタログから足す (ダイアログ) ------------------------------------------------
  //
  // **出所の並びは崩さずに、同じ種類のものを横断して探す。** 「送電」と打てば
  // Overture の送電線と地理院の送電線が並ぶ。中の層の名前でも当たる (「水部」)。

  /** 空白で区切った語が**全部**入っていれば当たり。大文字小文字は見ない。 */
  const matcher = (): ((text: string) => boolean) | undefined => {
    const words = filterEl.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return undefined;
    return (text) => {
      const lower = text.toLowerCase();
      return words.every((word) => lower.includes(word));
    };
  };

  /** 行を探すときに見る文字。出所・行の名前・Collection・中の層の名前。 */
  const haystack = (layer: Layer) =>
    [
      layer.group?.title,
      layer.title,
      ...layer.collections.map((c) => c.title),
      ...(layer.parts?.layers.map((part) => part.title) ?? []),
    ]
      .filter(Boolean)
      .join(' ');

  /** テーマの名前ではなく、中の層の名前に当たったなら、その層 (足すときはそれだけ出す)。 */
  const matchedParts = (layer: Layer, matches: ((text: string) => boolean) | undefined) =>
    matches && layer.parts && !matches(`${layer.group?.title ?? ''} ${layer.title}`)
      ? layer.parts.layers.filter((part) => matches(part.title))
      : [];

  const catalogRow = (layer: Layer, matches: ((text: string) => boolean) | undefined): HTMLElement => {
    const present = isPresent(layer);
    const el = document.createElement('div');
    el.className = present ? 'catalog-row' : 'catalog-row absent';
    el.dataset.catalogLayer = layer.id;

    const body = document.createElement('div');
    body.className = 'catalog-body';
    const name = document.createElement('span');
    name.className = 'catalog-name';
    name.textContent = layer.title;
    const meta = document.createElement('span');
    meta.className = 'catalog-meta';
    meta.textContent = [
      layer.vintage,
      present ? null : 'この範囲には無い',
      layer.minZoom !== undefined ? fromZoom(layer.minZoom) : null,
      layer.viewOnly ?? null,
    ]
      .filter(Boolean)
      .join(' · ');
    body.append(name, meta);

    // 中の層。絞り込みが層に当たったら、その層を言う (足すとその層だけを出す)。
    const hits = matchedParts(layer, matches);
    if (layer.parts && layer.parts.layers.length > 1) {
      const partsEl = document.createElement('span');
      partsEl.className = 'catalog-parts';
      const titles = (hits.length > 0 ? hits : layer.parts.layers).map((part) => part.title);
      const shown = titles.slice(0, 8).join('、') + (titles.length > 8 ? ` ほか${titles.length - 8}` : '');
      partsEl.textContent = hits.length > 0 ? `当たった層: ${shown}` : `${titles.length}層: ${shown}`;
      body.append(partsEl);
    }

    const detail = iconButton('layer-detail-button', 'ⓘ', `${layer.title}について`, () => openDetails(layer));

    const placed = order[layer.section].includes(layer.id);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'catalog-add';
    if (layer.viewOnly) {
      add.textContent = '描けません';
      add.disabled = true;
    } else if (placed) {
      add.textContent = '追加済み';
      add.disabled = true;
    } else {
      add.textContent = hits.length > 0 ? `${hits.length}層を追加` : '追加';
      add.addEventListener('click', () => {
        place(layer, hits.length > 0 ? hits.map((part) => part.id) : undefined);
      });
    }
    el.append(body, detail, add);
    return el;
  };

  const catalogHeading = (group: CatalogGroup): HTMLElement => {
    const heading = document.createElement('div');
    heading.className = 'catalog-group';
    heading.dataset.group = group.id;
    const title = document.createElement('span');
    title.className = 'catalog-group-title';
    title.textContent = group.title;
    const description = document.createElement('span');
    description.className = 'catalog-group-description';
    description.textContent = group.description;
    heading.append(title, catalogLink(group.path, 'Catalog'), description);
    return heading;
  };

  const renderCatalog = () => {
    const matches = matcher();
    const hit = (layer: Layer) => !matches || matches(haystack(layer));
    for (const tab of tabs) {
      const section = tab.dataset.section as Section;
      tab.setAttribute('aria-selected', String(section === catalogSection));
      const count = layers.filter((layer) => layer.section === section && hit(layer)).length;
      tab.textContent = `${SECTION_TITLES[section]} (${count})`;
    }
    const rows = layers.filter((layer) => layer.section === catalogSection && hit(layer));
    const nodes: HTMLElement[] = [];
    let previous: string | undefined;
    for (const layer of rows) {
      if (layer.group && layer.group.id !== previous) {
        nodes.push(catalogHeading(layer.group));
        previous = layer.group.id;
      }
      nodes.push(catalogRow(layer, matches));
    }
    catalogRowsEl.replaceChildren(...nodes);
    filterEmptyEl.hidden = rows.length > 0;
  };

  const openCatalog = (section: Section) => {
    catalogSection = section;
    renderCatalog();
    dialog.showModal();
  };

  for (const button of document.querySelectorAll<HTMLButtonElement>('.layer-add-button')) {
    button.addEventListener('click', () => openCatalog(button.dataset.section as Section));
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      catalogSection = tab.dataset.section as Section;
      renderCatalog();
    });
  }
  filterEl.addEventListener('input', renderCatalog);
  // 語が入っていれば Esc はまず語を消す (ダイアログは閉じない)。
  filterEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !filterEl.value) return;
    e.preventDefault();
    filterEl.value = '';
    renderCatalog();
  });

  // ---- 既定と、覚えている一覧 ------------------------------------------------------

  /** 既定で出しているもの (カタログの `duck:default` と、先頭の建物)。 */
  const defaults = layers.filter((layer) => layer.visible).map((layer) => layer.id);

  const placeDefaults = () => {
    for (const section of ['data', 'tile'] as const) {
      order[section] = layers
        .filter((layer) => layer.section === section && defaults.includes(layer.id))
        .sort((a, b) => (section === 'data' ? a.rank - b.rank : 0))
        .map((layer) => layer.id);
    }
    for (const layer of layers) setVisible(layer, defaults.includes(layer.id));
  };

  const restore = (saved: Saved) => {
    for (const layer of layers) setVisible(layer, false);
    lastParts.clear();
    for (const section of ['data', 'tile'] as const) {
      order[section] = [];
      for (const entry of saved[section]) {
        const layer = byId.get(entry.id);
        // カタログから消えたもの・区分が変わったもの・描けないものは捨てる。
        if (!layer || layer.section !== section || layer.viewOnly || order[section].includes(layer.id)) continue;
        order[section].push(layer.id);
        if (entry.parts && entry.parts.length > 0) lastParts.set(layer.id, entry.parts);
        setVisible(layer, entry.visible, entry.parts);
      }
    }
  };

  // 「一覧を既定に戻す」。覚えている一覧を捨てて、既定で出すものだけにする。
  document.querySelector('#layer-reset')!.addEventListener('click', () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 消せなくても既定には戻す。
    }
    settingsRowId = null;
    placeDefaults();
    for (const layer of layers) layer.refresh();
    applyOrder();
    render();
  });

  const saved = loadSaved();
  if (saved) {
    restore(saved);
    // 既定と違うものを出しているかもしれないので、全部の行に描き直させる。
    for (const layer of layers) layer.refresh();
  } else {
    placeDefaults();
  }
  for (const layer of layers) storeEl.append(layer.settings);
  applyOrder();

  const render = () => {
    renderList();
    if (dialog.open) renderCatalog();
  };

  return { render, applyOrder, isPlaced: (id) => order.data.includes(id) || order.tile.includes(id) };
}
