import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const CONTENT_TYPES: Record<string, string> = {
  // instantiateStreaming がこのContent-Typeを要求する。
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.parquet': 'application/octet-stream',
};

/**
 * 指定したディレクトリを、オブジェクトストレージ (R2/S3) と同じ流儀で配信する
 * 開発サーバー用のプラグイン。
 *
 * Viteが内部で使っているsirvのRange処理には穴があり、`Range: bytes=0-0` に対して
 * 206を返しながら Content-Range を付けず、Content-Length にファイル全体のサイズを
 * 返す (`bytes=0-99` は正常)。DuckDB-WASMは部分取得できるかどうかを
 * `bytes=0-0` で確かめるので、ちょうどこの壊れたケースを踏む。
 * また、HEADに `Accept-Ranges` を付けず、HEAD+Rangeにも206を返さない。
 * 中途半端に直すと切り分けにならないので、この配下だけは配信を丸ごと引き取る。
 *
 * 公開時はここで配るものをすべてオブジェクトストレージに置き、URLを
 * VITE_DATA_BASE_URL / VITE_DUCKDB_BASE_URL で渡す。ビルド成果物には含めない。
 */
function serveLikeObjectStorage(urlPrefix: string, directory: string): Plugin {
  const root = fileURLToPath(new URL(directory, import.meta.url));

  return {
    name: `serve-like-object-storage${urlPrefix.replace(/\//g, '-')}`,
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0];
        if (!path?.startsWith(urlPrefix)) return next();

        // 開発サーバーとはいえ、指定したディレクトリの外は出さない。
        const relative = normalize(decodeURIComponent(path.slice(urlPrefix.length)));
        if (relative.startsWith('..')) return next();
        const file = join(root, relative);

        let size: number;
        try {
          size = statSync(file).size;
        } catch {
          return next();
        }

        response.setHeader('Accept-Ranges', 'bytes');
        // 別オリジンに置いたときにDuckDB-WASMがこれらを読めるようにする。
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader(
          'Access-Control-Expose-Headers',
          'Content-Range, Content-Length, Accept-Ranges',
        );
        const contentType = CONTENT_TYPES[extname(file)];
        if (contentType) response.setHeader('Content-Type', contentType);

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
  plugins: [
    serveLikeObjectStorage('/data/', '../data/output/'),
    // DuckDB-WASM本体はバンドルしない (1ファイル35〜40MBあり、
    // Cloudflare Pagesの25MB制限を超えるため)。開発時はここから配る。
    serveLikeObjectStorage('/duckdb/', './node_modules/@duckdb/duckdb-wasm/dist/'),
  ],
  optimizeDeps: {
    // maplibre-glはワーカーのURLを import.meta.url からの相対パスで組み立てる
    // (dist/maplibre-gl-worker.mjs)。Viteの依存事前バンドルに取り込まれると
    // .vite/deps/ 配下にワーカーファイルが並ばず404になり、Workerが起動できないまま
    // GeoJSONSource.setData() が永久にハングする。事前バンドルから外して
    // 実ファイルの場所から配信させる。
    exclude: ['maplibre-gl'],
  },
});
