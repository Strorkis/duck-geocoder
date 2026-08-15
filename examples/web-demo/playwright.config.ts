import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // DuckDB-WASMの初期化とParquetの読み込みに数秒かかるので、既定より長めに取る。
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
