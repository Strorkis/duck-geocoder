// STAC Browser の Vite の設定を包み、束ねた依存のライセンスを1つのファイルに書き出す。
// build.sh が STAC Browser のソースの中へ写して使う (元の vite.config.js を読むため)。
//
// **配るものにライセンスの表示を入れるため。** STAC Browser は ISC、束ねている Vue などは
// MIT ほかで、どれも「複製に著作権表示と許諾表示を含める」ことが条件。
// 縮めた JS からは注記が消えるので、別のファイルとして置く。
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.js';

export default defineConfig(async (env) =>
  mergeConfig(await (typeof base === 'function' ? base(env) : base), {
    // 隠しディレクトリ (既定の .vite/) にしない。開いて読めるところに置く。
    build: { license: { fileName: 'THIRD-PARTY-LICENSES.md' } },
  }),
);
