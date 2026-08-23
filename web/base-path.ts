/**
 * アプリを配信するパス。GitHub Pagesはリポジトリ名のサブパスで配信されるため、
 * 外から渡せるようにしてある。
 *
 * ビルド設定 (vite.config.ts) とテスト設定 (playwright.config.ts) の両方が要る。
 * それぞれで環境変数を読むと、片方だけ変えたときに `pnpm test:dist` が
 * 配信していないパスを見に行って全件404になるので、ここに1つだけ置く。
 */
export const BASE_PATH = process.env.VITE_BASE_PATH ?? '/';
