/**
 * 一覧の **地形の行**。
 *
 * **1つだけ選ぶ。** 出すか (チェック) と、どの標高か (選択) を1行で。地図右上の
 * 地形ボタン (TerrainControl) と同じものを切るので、どちらで切っても追随する。
 * 標高の候補はカタログの地形の Collection (Mapterhorn・Re:Earth・地理院…)。
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Collection } from '../lib/stac';
import { TERRAIN_SOURCE, defaultOf, terrainSource } from '../lib/tiles';
import { sliderSettings } from './layer-list';

export interface TerrainRowOptions {
  map: MapLibreMap;
  /** 地形に使える標高。空なら行を隠す。 */
  collections: Collection[];
  /** ⓘ (いま選んでいる標高のカード) を開く。 */
  openDetails: (collection: Collection) => void;
}

export function createTerrainRow({ map, collections, openDetails }: TerrainRowOptions): void {
  const rowEl = document.querySelector<HTMLDivElement>('#terrain-row')!;
  const toggle = document.querySelector<HTMLInputElement>('#terrain-toggle')!;
  const select = document.querySelector<HTMLSelectElement>('#terrain-source')!;
  const settingsButton = document.querySelector<HTMLButtonElement>('#terrain-settings')!;
  const detailButton = document.querySelector<HTMLButtonElement>('#terrain-detail')!;
  const slotEl = document.querySelector<HTMLDivElement>('#terrain-slot')!;
  let exaggeration = 1;
  let choice = defaultOf(collections, 'terrain');
  /** 標高を差し替えている最中 (その間の「地形が外れた」通知は、チェックに写さない)。 */
  let switching = false;

  rowEl.hidden = collections.length === 0;
  for (const collection of collections) {
    const option = document.createElement('option');
    option.value = collection.id;
    option.textContent = `${collection.title} (${collection.group?.title ?? ''})`;
    select.append(option);
  }
  if (choice) select.value = choice.id;
  toggle.checked = map.getTerrain() !== null;

  const apply = () =>
    map.setTerrain(toggle.checked && choice ? { source: TERRAIN_SOURCE, exaggeration } : null);
  toggle.addEventListener('change', apply);
  select.addEventListener('change', () => {
    const next = collections.find((c) => c.id === select.value);
    if (!next || next === choice) return;
    choice = next;
    // **ソースごと差し替える** (URL もエンコードも範囲も標高ごとに違う)。差し替えのために
    // いったん外すが、その通知でチェックを外さない (外すと、付け直されずに地形が消えた)。
    switching = true;
    map.setTerrain(null);
    if (map.getSource(TERRAIN_SOURCE)) map.removeSource(TERRAIN_SOURCE);
    map.addSource(TERRAIN_SOURCE, terrainSource(next));
    switching = false;
    apply();
  });
  // 起伏の強調は ⚙ で行の下に開く (地図を見ながら動かすもの)。
  slotEl.append(
    sliderSettings('起伏の強調', 1, 3, 0.5, 1, (v) => `×${v}`, (v) => {
      exaggeration = v;
      if (map.getTerrain()) apply();
    }),
  );
  settingsButton.addEventListener('click', () => {
    slotEl.hidden = !slotEl.hidden;
    settingsButton.setAttribute('aria-expanded', String(!slotEl.hidden));
  });
  detailButton.addEventListener('click', () => {
    if (choice) openDetails(choice);
  });
  // 地図右上の地形ボタンで切られたら、一覧のチェックを追随させる。
  map.on('terrain', () => {
    if (switching) return;
    toggle.checked = map.getTerrain() !== null;
  });
}
