/**
 * **データの描き方** (建物・人口メッシュ・鉄道・道路・送電線と川) が共通に使う道具。
 *
 * どの描き方も同じ形をしている:
 * 1. **世代 (token) を最初に進める** — 外したあとに、読み込み中だった前の結果を描かないように
 *    (全部外したときの早期 return より前でないといけない。実際に起きた)
 * 2. 一覧で出していなければ空にして終わる (既に空なら `setData` しない — 地図の Worker を
 *    建物の描画と取り合うため)
 * 3. 表示範囲で引き (lib/queries.ts)、世代が変わっていなければ描いて、一覧の行に状態を書く
 */
import type * as duckdb from '@duckdb/duckdb-wasm';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { DetailSettings } from '../../lib/detail';
import type { ViewBounds } from '../../lib/sources';

export interface DrawContext {
  map: MapLibreMap;
  conn: duckdb.AsyncDuckDBConnection;
  /** 時間のかかる処理を「処理中」の表示で包む。 */
  busy: <T>(label: string, run: () => Promise<T>) => Promise<T>;
  /** 失敗を画面にも出す (コンソールだけだと「何も起きない」としか見えない)。 */
  showFailure: (message: string) => void;
  /** 一覧の行の状態 (件数や「ズーム14から」)。行IDは Collection ID。 */
  setStatus: (id: string, text: string) => void;
  statusOf: (id: string) => string;
  /** 一覧で出しているか。 */
  isVisible: (id: string) => boolean;
  currentBounds: () => ViewBounds;
  /** いまの表示量 (上限とズームの閾値)。切り替えられるので関数で読む。 */
  detail: () => DetailSettings;
}

/** 描き直しを頼む関数にする。失敗はコンソールと画面に出し、投げない (moveend から呼ばれる)。 */
export function requester(ctx: DrawContext, name: string, label: string, run: () => Promise<void>): () => void {
  return () => {
    run().catch((e: unknown) => {
      console.error(`[${name}] failed`, e);
      ctx.showFailure(`${label}の読み込みに失敗しました`);
    });
  };
}
