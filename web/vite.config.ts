import { copyFileSync, createReadStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { BASE_PATH } from './base-path.ts';
import { ensureDuckDbExtensions } from './duckdb-extensions.ts';

/**
 * spatial拡張などのキャッシュ置き場。gitには入れない (23.5MB×プラットフォーム数)。
 * DuckDB本体のバージョンでディレクトリが切られる (`duckdb-extensions.ts` を参照)。
 */
const DUCKDB_EXTENSIONS_CACHE = fileURLToPath(new URL('./.duckdb-extensions/', import.meta.url));

/** DuckDB-WASM本体の在り処。開発時の配信元と、ビルド時のコピー元を兼ねる。 */
const DUCKDB_DIST = './node_modules/@duckdb/duckdb-wasm/dist/';

/**
 * DuckDB-WASM本体のうち、ビルド成果物にそのままコピーするファイル。
 *
 * バンドラには通さない。1ファイル35〜40MBあり、取り込むとホスティングの
 * ファイルサイズ制限に当たる (Cloudflare Pagesは25MiBまで)。
 * コピー元がアプリのバンドルと同じ node_modules なので、
 * `pnpm update` してもJSのAPIとWASMバイナリがずれない。
 *
 * mvp と eh の両方を置く。selectBundle() がブラウザを見て一方だけを
 * ダウンロードするので、利用者の転送量は片方 (現行ブラウザなら eh の35MB) だけ。
 * mvp を削ると古いブラウザで「遅い」ではなく「動かない」になる。
 */
const DUCKDB_FILES = [
  'duckdb-eh.wasm',
  'duckdb-browser-eh.worker.js',
  'duckdb-mvp.wasm',
  'duckdb-browser-mvp.worker.js',
];

const CONTENT_TYPES: Record<string, string> = {
  // instantiateStreaming がこのContent-Typeを要求する。
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.parquet': 'application/octet-stream',
};

/**
 * 指定したディレクトリを、オブジェクトストレージ (R2/S3) と同じ流儀で配信する。
 * 開発サーバー (`vite`) と、ビルド成果物の確認用サーバー (`vite preview`) の両方で効く。
 * preview でも配るのは、本番と同じバンドルを手元で通しで検証できるようにするため。
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
function serveLikeObjectStorage(urlPath: string, directory: string): Plugin {
  const root = fileURLToPath(new URL(directory, import.meta.url));
  // ベースパス配下で配信されることがあるので、解決後の base を前置きしてマウントする。
  let mountPath = urlPath;

  const handle: Connect.NextHandleFunction = (request, response, next) => {
    // マウントした接頭辞は取り除かれた状態で渡ってくるので、残りがファイル名。
    const path = (request.url ?? '').split('?')[0].replace(/^\//, '');
    // 開発サーバーとはいえ、指定したディレクトリの外は出さない。
    const relative = normalize(decodeURIComponent(path));
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
  };

  return {
    name: `serve-like-object-storage${urlPath.replace(/\//g, '-')}`,
    configResolved(config) {
      mountPath = `${config.base.replace(/\/$/, '')}${urlPath}`;
    },
    configureServer(server) {
      server.middlewares.use(mountPath, handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(mountPath, handle);
    },
  };
}

/**
 * コピー元とサイズ・更新日時が同じならコピーを飛ばす。
 * DuckDB本体・拡張とも合計100MB超あり、変わっていないものまで毎回コピーすると遅い
 * (node_modules 側もキャッシュ側も、更新されるのは `pnpm update` や
 * バージョン変更のときだけ)。
 */
function copyFileIfChanged(from: string, to: string): void {
  const original = statSync(from);
  const copied = statSync(to, { throwIfNoEntry: false });
  if (copied?.size === original.size && copied.mtimeMs >= original.mtimeMs) return;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

/** ディレクトリを再帰的にコピーする。拡張のキャッシュは version/platform の階層を持つため。 */
function copyDirIfChanged(source: string, destination: string): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirIfChanged(from, to);
    } else {
      copyFileIfChanged(from, to);
    }
  }
}

/** DuckDB-WASM本体をビルド成果物の `duckdb/` に置く。 */
function copyDuckDbRuntime(): Plugin {
  const source = fileURLToPath(new URL(DUCKDB_DIST, import.meta.url));

  return {
    name: 'copy-duckdb-runtime',
    apply: 'build',
    writeBundle(options) {
      const destination = join(options.dir ?? 'dist', 'duckdb');
      for (const file of DUCKDB_FILES) {
        copyFileIfChanged(join(source, file), join(destination, file));
      }
    },
  };
}

/** spatialなど拡張のWASM本体をビルド成果物の `duckdb/extensions/` に置く。 */
function copyDuckDbExtensions(cacheDir: string): Plugin {
  return {
    name: 'copy-duckdb-extensions',
    apply: 'build',
    writeBundle(options) {
      copyDirIfChanged(cacheDir, join(options.dir ?? 'dist', 'duckdb', 'extensions'));
    },
  };
}

export default defineConfig(async () => {
  // ビルド・開発サーバー起動のどちらでも、設定を解決する前に揃えておく。
  // 配信を始めた後に用意すると、間に合わなかったリクエストが404になる窓ができる。
  await ensureDuckDbExtensions(DUCKDB_EXTENSIONS_CACHE);

  return {
    base: BASE_PATH,
    plugins: [
      serveLikeObjectStorage('/data', '../data/output/'),
      // node_modules 由来のパスと衝突しないよう、拡張のキャッシュを先にマウントする。
      serveLikeObjectStorage('/duckdb/extensions', DUCKDB_EXTENSIONS_CACHE),
      // 開発時はDuckDB-WASM本体を node_modules から配る (ビルド時はコピーする)。
      serveLikeObjectStorage('/duckdb', DUCKDB_DIST),
      copyDuckDbRuntime(),
      copyDuckDbExtensions(DUCKDB_EXTENSIONS_CACHE),
    ],
  };
});
