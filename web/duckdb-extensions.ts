import { createRequire } from 'node:module';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** ブラウザで使っているのと同じプラットフォームだけ揃える (COIビルドは使っていない)。 */
const PLATFORMS = ['wasm_eh', 'wasm_mvp'] as const;

/**
 * 自前配信する拡張。
 *
 * spatialは逆ジオコーディングと建物表示のために明示的にLOADしている。
 * parquetは明示的にLOADしていないが、`read_parquet()` を呼んだ時点でDuckDBが
 * 自動で取得する (autoload)。これは初期化の最初の一歩 (行政区域のビュー作成) で
 * 起きるため、本家 (extensions.duckdb.org) に置いたままだと、spatialを自前配信に
 * しても初期化そのものが外部ドメインに依存したままになる。
 */
const EXTENSIONS = ['spatial', 'parquet'] as const;

/**
 * 同梱している duckdb-wasm が積んでいる DuckDB本体のバージョンを実行時に読む。
 *
 * ソースにバージョンを書かないのは `pnpm update` で duckdb-wasm を上げるたびに
 * ずれるため。ずれたまま古いパスの拡張を配ると、DuckDBが起動時に
 * バージョン不一致で拒否するか、最悪 `extensions.duckdb.org` へ黙って
 * フォールバックしてしまう (自前配信にした意味が消える)。
 *
 * duckdb-wasmのNode向けバンドル (node-blocking) をこのビルドスクリプトの中だけで
 * 一度起動して `SELECT version()` を引く。ブラウザで使うWASM本体とバージョンは
 * 同じはずだが、実際にロードして確かめる方が「はず」に頼らずに済む。
 */
export async function resolveDuckDbVersion(): Promise<string> {
  const dist = dirname(
    require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'),
  );
  const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs') as {
    createDuckDB: (
      bundles: unknown,
      logger: unknown,
      runtime: unknown,
    ) => Promise<{
      instantiate: () => Promise<void>;
      connect: () => { query: (sql: string) => { toArray: () => { toJSON: () => unknown }[] } };
    }>;
    VoidLogger: new () => unknown;
    NODE_RUNTIME: unknown;
  };

  const db = await duckdb.createDuckDB(
    {
      mvp: {
        mainModule: join(dist, 'duckdb-mvp.wasm'),
        mainWorker: join(dist, 'duckdb-node-mvp.worker.cjs'),
      },
      eh: {
        mainModule: join(dist, 'duckdb-eh.wasm'),
        mainWorker: join(dist, 'duckdb-node-eh.worker.cjs'),
      },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate();
  const conn = db.connect();
  const [row] = conn.query('SELECT version() AS v;').toArray();
  const { v } = row.toJSON() as { v: string };
  return v;
}

/** 拡張1個の配置先パス。配信 (serveLikeObjectStorage) 側とも共有する形。 */
export function extensionRelativePath(version: string, platform: string, name: string): string {
  return join(version, platform, `${name}.duckdb_extension.wasm`);
}

/**
 * spatialなど拡張のWASM本体を、DuckDBの本家配布元 (extensions.duckdb.org) から
 * `cacheDir` に落としてくる。すでにあるものは飛ばす (1ファイル23.5MB×プラットフォーム数)。
 *
 * ここで拾うのは署名済みの原本そのまま。改変しないので `allowUnsignedExtensions`
 * は要らない。DuckDB-WASM側は `custom_extension_repository` をこの配信元に
 * 向けるだけで、以後は通常のCDNから取るのと同じ手順で検証・読み込みされる。
 *
 * 該当バージョンの拡張が存在しない場合はエラーで止める。黙って古いキャッシュを
 * 使い続けると、実行時にDuckDBが404を踏んで気づきにくい壊れ方をする。
 */
export async function ensureDuckDbExtensions(cacheDir: string): Promise<string> {
  const version = await resolveDuckDbVersion();

  for (const platform of PLATFORMS) {
    for (const name of EXTENSIONS) {
      const relative = extensionRelativePath(version, platform, name);
      const dest = join(cacheDir, relative);

      const existing = await stat(dest).catch(() => null);
      if (existing && existing.size > 0) continue;

      const url = `https://extensions.duckdb.org/${relative}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `DuckDB拡張の取得に失敗: ${url} (${response.status}) — duckdb-wasmのバージョン (${version}) に対応する拡張が無いかもしれない`,
        );
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await response.arrayBuffer()));
    }
  }

  return version;
}

// `node duckdb-extensions.ts` で単体実行できるようにしておく (デバッグ用)。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cacheDir = join(dirname(fileURLToPath(import.meta.url)), '.duckdb-extensions');
  const version = await ensureDuckDbExtensions(cacheDir);
  console.log(`[duckdb-extensions] ${version} を ${cacheDir} に用意した`);
}
