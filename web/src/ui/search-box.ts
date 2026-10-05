/**
 * **検索欄** と、選んだ結果の見せ方 (ハイライト・寄せ方・吹き出し)。
 *
 * 地名・行政区域・駅・鉄道路線・道路の路線を1つの欄で引く (問い合わせは lib/search.ts)。
 * 📍 で地図から選んだ地点 (逆ジオコーディング) も、結果の見せ方は同じなのでここで持つ。
 */
import type * as duckdb from '@duckdb/duckdb-wasm';
import { Popup, type LngLat, type Map as MapLibreMap } from 'maplibre-gl';
import {
  MAX_RESULTS,
  ROUTE_SUGGESTIONS,
  fetchAdminPolygon,
  fetchLineGeometry,
  fetchRouteGeometry,
  reverseGeocode,
  searchAddress,
  searchLines,
  searchRoutes,
  searchStations,
  toMultiLineString,
  type SearchResult,
} from '../lib/search';
import type { Bbox } from '../lib/stac';
import { ROAD_STYLES } from './map';

export interface SearchBoxOptions {
  map: MapLibreMap;
  conn: duckdb.AsyncDuckDBConnection;
  busy: <T>(label: string, run: () => Promise<T>) => Promise<T>;
  showFailure: (message: string) => void;
  setSourceData: (sourceId: string, geometry: GeoJSON.Geometry | null) => Promise<void>;
  ensureOaza: () => Promise<void>;
  ensureSpatial: () => Promise<void>;
  /** 駅・路線・道路は配信されていないこともある。無ければ地名と行政区域だけで引く。 */
  ensureStations: (() => Promise<void>) | undefined;
  ensureSections: (() => Promise<void>) | undefined;
  ensureRoutes: (() => Promise<void>) | undefined;
  /** 選んだもの (周辺検索の起点として覚える)。 */
  onSelect: (label: string, geometry: GeoJSON.Geometry) => void;
}

export interface SearchBox {
  /** 検索欄と、出している結果 (ハイライト・吹き出し) を消す。 */
  clear: () => void;
  /** 地図で選んだ地点がどの行政区域かを引き、結果として出す (📍)。 */
  pickAt: (lngLat: LngLat) => void;
}

const BADGES: Record<SearchResult['kind'], string> = {
  admin: '行政区域',
  oaza: '地名',
  station: '駅',
  line: '路線',
  route: '道路',
};

export function createSearchBox(options: SearchBoxOptions): SearchBox {
  const { map, conn, busy, showFailure, setSourceData, ensureOaza, ensureSpatial, onSelect } = options;
  const { ensureStations, ensureSections, ensureRoutes } = options;
  const input = document.querySelector<HTMLInputElement>('#search-input')!;
  const resultsEl = document.querySelector<HTMLUListElement>('#results')!;
  const clearButton = document.querySelector<HTMLButtonElement>('#clear-button')!;

  // 逆ジオコーディングの結果を出すポップアップ。1つを使い回す。
  //
  // closeOnClick を切ってあるのは、建物を見るつもりのクリックで結果が消えると、
  // 📍ボタン化して消したはずの「勝手に変わる」感覚が戻ってくるため。
  // 消すのは×かEscだけにする。
  // **判定の結果はホバーと見分けられるようにする。** 2つとも吹き出しなので、
  // クラスが無いと「どちらが押した場所のものか」が中身を読むまで分からない
  // (テストからも区別できない)。
  const popup = new Popup({ closeButton: true, closeOnClick: false, className: 'result-popup' });

  // ハイライトとポップアップは1つの結果なので、片方を閉じたら両方消す。
  const clearHighlight = () => {
    Promise.all([setSourceData('highlight', null), setSourceData('selected-point', null)]).catch(
      (e: unknown) => console.error('[clearHighlight] failed', e),
    );
  };
  popup.on('close', clearHighlight);

  const clear = () => {
    input.value = '';
    resultsEl.innerHTML = '';
    clearButton.hidden = true;
    // 開いていれば close が飛んで clearHighlight も走るが、開いていないときの
    // ために自分でも消す (どちらも繰り返して困らない)。
    popup.remove();
    clearHighlight();
    input.focus();
  };

  /** 路線の端から端まで入るように寄せる。鉄道と道路で同じ。 */
  const fitToBbox = ([west, south, east, north]: Bbox) => {
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      // パネルが左下と右下にあるので、下側を多めに空ける。
      { padding: { top: 60, bottom: 120, left: 60, right: 60 }, duration: 1500 },
    );
  };

  const showResult = async (result: SearchResult) => {
    // 路線は点ではなく**範囲**。端から端まで入るように寄せる。
    //
    // **線そのものをハイライトする。** 範囲へ動かすだけだと、鉄道レイヤーを
    // 出しているときに「どれが選んだ路線か」が分からない。
    if (result.kind === 'line') {
      await setSourceData('selected-point', null);
      if (ensureSections) {
        await busy('路線を読み込み中…', async () => {
          await ensureSections();
          const parts = await fetchLineGeometry(conn, result.lineName, result.operator, result.bbox);
          const geometry = toMultiLineString(parts);
          await setSourceData('highlight', geometry);
          if (geometry) onSelect(result.label, geometry);
        });
      }
      fitToBbox(result.bbox);
      return;
    }

    // 道路の路線も同じ扱い。**出所は違うが見せ方は変わらない** ので、
    // ハイライトも寄せ方も鉄道と揃える。
    if (result.kind === 'route') {
      await setSourceData('selected-point', null);
      if (ensureRoutes) {
        await busy('道路を読み込み中…', async () => {
          await ensureRoutes();
          const parts = await fetchRouteGeometry(conn, result.routeName, result.bbox);
          const geometry = toMultiLineString(parts);
          await setSourceData('highlight', geometry);
          if (geometry) onSelect(result.label, geometry);
        });
      }
      fitToBbox(result.bbox);
      return;
    }

    // 地名(代表点しか無い)と駅はその地点へ飛ぶ。ポリゴンは消す。
    if (result.kind === 'oaza' || result.kind === 'station') {
      const point: GeoJSON.Point = { type: 'Point', coordinates: [result.lon, result.lat] };
      await Promise.all([setSourceData('highlight', null), setSourceData('selected-point', point)]);
      onSelect(result.label, point);
      map.flyTo({ center: [result.lon, result.lat], zoom: 16, duration: 1500 });
      return;
    }

    // 行政区域は面をハイライトして全体が入るように寄る。
    // ポリゴン取得を待たずにカメラを動かすと、後から呼ぶ fitBounds が
    // アニメーションを横取りしてしまうので、取得を終えてから1回だけ動かす。
    //
    // 逆ジオコーディングでは名前が先に出るので、ここが無言だと
    // 「地名だけ出てポリゴンが出ない」ように見える。大きい自治体ほど重い
    // (対馬市で70,848頂点) ので、待っていることを知らせる。
    const polygon = await busy('範囲を読み込み中…', async () => {
      await ensureSpatial();
      return fetchAdminPolygon(conn, result.adminId);
    });
    if (!polygon) {
      console.warn('admin polygon not found for admin_id', result.adminId);
      showFailure('範囲を取得できませんでした');
      return;
    }

    await Promise.all([setSourceData('highlight', polygon.geojson), setSourceData('selected-point', null)]);
    onSelect(result.label, polygon.geojson);
    map.fitBounds(
      [
        [polygon.bbox[0], polygon.bbox[1]],
        [polygon.bbox[2], polygon.bbox[3]],
      ],
      { padding: 40, duration: 1500 },
    );
  };

  const renderResults = (rows: SearchResult[]) => {
    resultsEl.innerHTML = '';

    // 何も出さないと一覧ごと消えて (#results:empty)、読み込み中と区別がつかない。
    // 地名は収録した都道府県の分しか無いので、この状態には普通に到達する。
    if (rows.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '該当する地名がありません';
      resultsEl.appendChild(li);
      return;
    }

    for (const row of rows) {
      const li = document.createElement('li');
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = BADGES[row.kind];
      li.append(badge, row.label);
      // **会社名と路線名は2段目に置く。**1行に詰めると
      //「東京駅 (東日本旅客鉄道 東北新幹線)」のように長くなって読みにくい。
      if ('detail' in row && row.detail) {
        const detail = document.createElement('span');
        detail.className = 'result-detail';
        detail.textContent = row.detail;
        li.append(detail);
      }
      li.addEventListener('click', () => {
        resultsEl.innerHTML = '';
        input.value = row.label;
        showResult(row).catch((e: unknown) => console.error('[showResult] failed', e));
      });
      resultsEl.appendChild(li);
    }
  };

  let debounceTimer: number | undefined;
  const runSearch = (debounceMs: number) => {
    window.clearTimeout(debounceTimer);
    const keyword = input.value.trim();
    clearButton.hidden = keyword.length === 0;
    if (keyword.length === 0) {
      resultsEl.innerHTML = '';
      return;
    }
    debounceTimer = window.setTimeout(() => {
      // 初回は ensureOaza の読み込みを待つので、ここだけ数秒かかることがある。
      busy('検索中…', async () => {
        await Promise.all([ensureOaza(), ensureStations?.(), ensureRoutes?.()]);
        const [places, stations, lines, routes] = await Promise.all([
          searchAddress(conn, keyword),
          ensureStations ? searchStations(conn, keyword) : Promise.resolve([]),
          ensureStations ? searchLines(conn, keyword) : Promise.resolve([]),
          ensureRoutes
            ? searchRoutes(conn, keyword, (cls) => ROAD_STYLES[cls]?.label ?? cls)
            : Promise.resolve([]),
        ]);
        // **打った語がそのものを指しているものを先に出す。**
        // 「山手線」で駅ばかり並ぶと、路線を見たい人の役に立たない。
        // 「東京」なら東京駅が先に来てほしい。
        const exactLines = lines.filter((l) => l.label.includes(keyword));
        const exactStations = stations.filter((s) => s.label.startsWith(`${keyword}駅`));
        const rest = stations.filter((s) => !exactStations.includes(s));
        // **道路は数が多いので、打った語そのもの以外は後ろに回して上限を掛ける。**
        // 「東京」には109路線が当たり、候補10件を道路が埋めて
        // 東京駅も東京都も消えた。「国道13号」のように語そのものを指すものは先頭。
        const exactRoutes = routes.filter((r) => r.label === keyword);
        const otherRoutes = routes.filter((r) => r.label !== keyword).slice(0, ROUTE_SUGGESTIONS);
        return [...exactRoutes, ...exactLines, ...exactStations, ...places, ...otherRoutes, ...rest].slice(
          0,
          MAX_RESULTS,
        );
      })
        .then(renderResults)
        .catch((e: unknown) => {
          console.error('[searchAddress] failed', e);
          showFailure('検索に失敗しました');
        });
    }, debounceMs);
  };

  /**
   * 「検索に使用」を出すかどうか。**打っている間だけ出す。**
   *
   * 常時出しておくと検索欄が200pxまで伸びて左上の地図を覆い、
   * クリックが届かなくなる (実測156px)。かといってフォーカスだけを条件にすると、
   * **起動時に検索欄へ自動でフォーカスが当たる**ので結局出っぱなしになる。
   */
  input.addEventListener('input', () => runSearch(200));
  // 候補を選ぶと一覧を閉じるので、再びフォーカスしたときに候補を出し直す。
  // (入力を変えないと候補が出ないのは分かりにくい)
  input.addEventListener('focus', () => runSearch(0));
  input.addEventListener('blur', () => {
    resultsEl.innerHTML = '';
  });
  // 候補のクリックは blur より先に mousedown が走る。既定動作を止めて
  // フォーカスを外させないと、click が発火する前に一覧が消えてしまう。
  resultsEl.addEventListener('mousedown', (e) => e.preventDefault());

  clearButton.addEventListener('click', clear);

  // 逆ジオコーディング: クリックした地点がどの行政区域かを引き、
  // その区域をハイライトしてポップアップで名前を出す。
  const pickAt = (lngLat: LngLat) => {
    popup.setLngLat(lngLat).setText('判定中…').addTo(map);
    busy('地点を判定中…', async () => {
      await ensureSpatial();
      return reverseGeocode(conn, lngLat.lng, lngLat.lat);
    })
      .then(async (hit) => {
        if (!hit) {
          popup.setText('該当する行政区域はありません (海上など)');
          return;
        }
        popup.setText(hit.label);
        input.value = hit.label;
        clearButton.hidden = false;
        await showResult({ kind: 'admin', label: hit.label, adminId: hit.adminId });
      })
      .catch((err: unknown) => {
        console.error('[reverseGeocode] failed', err);
        popup.setText('判定に失敗しました');
      });
  };

  return { clear, pickAt };
}
