import { defineConfig } from '@playwright/test';

/**
 * 既定はローカルの開発サーバー。公開したものを検証するときは
 * PLAYWRIGHT_BASE_URL に公開URLを渡す (その場合は開発サーバーを起動しない)。
 *
 * 同じテストを本番に向けて流せるようにしてあるのは、ローカルで通っていても
 * 配信側のヘッダ設定ひとつで部分取得が壊れるため。転送量を見張るテストは、
 * 実際に配信される場所で流してはじめて意味がある。
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL;
const isRemote = Boolean(baseURL);

export default defineConfig({
  testDir: './tests',
  // DuckDB-WASMの初期化とParquetの読み込みに数秒かかるので、既定より長めに取る。
  // 公開URL相手はネットワーク越しなのでさらに余裕を持たせる。
  timeout: isRemote ? 180_000 : 60_000,
  expect: { timeout: isRemote ? 60_000 : 15_000 },
  fullyParallel: false,
  use: {
    baseURL: baseURL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  webServer: isRemote
    ? undefined
    : {
        command: 'pnpm dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
