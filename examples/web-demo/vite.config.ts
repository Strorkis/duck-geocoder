import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // maplibre-glはワーカーのURLを import.meta.url からの相対パスで組み立てる
    // (dist/maplibre-gl-worker.mjs)。Viteの依存事前バンドルに取り込まれると
    // .vite/deps/ 配下にワーカーファイルが並ばず404になり、Workerが起動できないまま
    // GeoJSONSource.setData() が永久にハングする。事前バンドルから外して
    // 実ファイルの場所から配信させる。
    exclude: ['maplibre-gl'],
  },
});
