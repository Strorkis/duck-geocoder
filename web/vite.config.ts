import { createReadStream, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * /data/ 配下のGeoParquetを、オブジェクトストレージ (R2/S3) と同じ流儀で配信する。
 *
 * Viteが内部で使っているsirvのRange処理には穴があり、`Range: bytes=0-0` に対して
 * 206を返しながら Content-Range を付けず、Content-Length にファイル全体のサイズを
 * 返す (`bytes=0-99` は正常)。DuckDB-WASMは部分取得できるかどうかを
 * `bytes=0-0` で確かめるので、ちょうどこの壊れたケースを踏む。
 * また、HEADに `Accept-Ranges` を付けず、HEAD+Rangeにも206を返さない。
 *
 * 中途半端に直すと切り分けにならないので、この配下だけは配信を丸ごと引き取る。
 */
function serveDataLikeObjectStorage(): Plugin {
  const dataRoot = fileURLToPath(new URL('./public/data/', import.meta.url));

  return {
    name: 'serve-data-like-object-storage',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0];
        if (!path?.startsWith('/data/')) return next();

        // 開発サーバーとはいえ、パスを外に出さない。
        const relative = normalize(decodeURIComponent(path.slice('/data/'.length)));
        if (relative.startsWith('..')) return next();

        let size: number;
        try {
          size = statSync(join(dataRoot, relative)).size;
        } catch {
          return next();
        }
        const file = join(dataRoot, relative);

        response.setHeader('Accept-Ranges', 'bytes');
        // 別オリジンに置いたときにDuckDB-WASMがこれらを読めるようにする。
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader(
          'Access-Control-Expose-Headers',
          'Content-Range, Content-Length, Accept-Ranges',
        );

        // "bytes=100-199" / "bytes=100-" の2形だけ扱う (複数レンジは使われない)。
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
        const start = match ? Number(match[1]) : 0;
        const end = match && match[2] !== '' ? Math.min(Number(match[2]), size - 1) : size - 1;

        if (match && (start > end || start >= size)) {
          response.statusCode = 416;
          response.setHeader('Content-Range', `bytes */${size}`);
          return response.end();
        }

        if (match) {
          response.statusCode = 206;
          response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          response.setHeader('Content-Length', end - start + 1);
        } else {
          response.statusCode = 200;
          response.setHeader('Content-Length', size);
        }

        // HEADは本文を返さない。ヘッダはGETと同じものを返す。
        if (request.method === 'HEAD') return response.end();
        createReadStream(file, { start, end }).pipe(response);
      });
    },
  };
}

export default defineConfig({
  plugins: [serveDataLikeObjectStorage()],
  optimizeDeps: {
    // maplibre-glはワーカーのURLを import.meta.url からの相対パスで組み立てる
    // (dist/maplibre-gl-worker.mjs)。Viteの依存事前バンドルに取り込まれると
    // .vite/deps/ 配下にワーカーファイルが並ばず404になり、Workerが起動できないまま
    // GeoJSONSource.setData() が永久にハングする。事前バンドルから外して
    // 実ファイルの場所から配信させる。
    exclude: ['maplibre-gl'],
  },
});
