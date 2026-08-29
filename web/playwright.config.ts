import { defineConfig } from '@playwright/test';
import { BASE_PATH } from './base-path';

/**
 * 同じテストを3つの対象に流せるようにしてある。
 *
 * | 対象 | 起動方法 | 何を確かめるためか |
 * | --- | --- | --- |
 * | 開発サーバー (既定) | `pnpm test` | 普段の回帰確認 |
 * | 本番ビルド | `pnpm test:dist` | バンドル後だけ壊れるものを、デプロイ前に捕まえる |
 * | 公開URL | `PLAYWRIGHT_BASE_URL=... pnpm test` | 配信側の設定が絡むものを実測する |
 *
 * 3つに分けているのは、実際にどちらも起きたため。MapLibreのワーカーは
 * バンドル後だけ読み込みに失敗してGeoJSONが一切描画されなくなり、
 * 部分取得はサーバーのヘッダ設定ひとつで静かに全件取得へ落ちる。
 * どちらも開発サーバーでは再現しない。
 */
const DEV_PORT = 5173;
const PREVIEW_PORT = 4173;

const local =
  process.env.PLAYWRIGHT_TARGET === 'dist'
    ? {
        url: `http://localhost:${PREVIEW_PORT}${BASE_PATH}`,
        command: `pnpm exec vite preview --port ${PREVIEW_PORT}`,
        // ビルドし直したものを見たいので、動いているものは使い回さない。
        reuseExistingServer: false,
        timeout: 60_000,
      }
    : {
        url: `http://localhost:${DEV_PORT}`,
        command: 'pnpm dev',
        reuseExistingServer: true,
        timeout: 60_000,
      };

const remoteURL = process.env.PLAYWRIGHT_BASE_URL;

// 待ち時間を決めるのはアプリの置き場所ではなく、データの置き場所。
// 初期化だけで数十回のRangeリクエストが走るので、データが別オリジンにあると
// 往復の遅延が積み上がって数十秒かかる (実測で約24秒)。
// アプリを手元の preview で動かしていても、データがR2なら同じだけ待つ。
const readsRemoteData =
  Boolean(remoteURL) || /^https?:/.test(process.env.VITE_DATA_BASE_URL ?? '');

export default defineConfig({
  testDir: './tests',
  // DuckDB-WASMの初期化とParquetの読み込みには時間がかかるので、既定より長く取る。
  timeout: readsRemoteData ? 180_000 : 60_000,
  expect: { timeout: readsRemoteData ? 60_000 : 15_000 },
  fullyParallel: false,
  // CIはネットワーク越しにデータを読むので、1回だけやり直す。
  // 再実行でトレースが残るため、ヘッドレスでの失敗を後から追える。
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: remoteURL ?? local.url,
    trace: 'on-first-retry',
  },
  webServer: remoteURL ? undefined : local,
});
