# DuckDB-WASM と拡張のライセンス

このサイトは DuckDB-WASM の本体 (`duckdb/*.wasm`) と拡張 (`duckdb/extensions/`、spatial と parquet) を
**そのまま写して配っている** (外部のドメインに頼らないため)。中身は変えていない。
版は `web/pnpm-lock.yaml` の `@duckdb/duckdb-wasm` が積んでいる DuckDB に合わせている
(拡張は `duckdb/extensions/<DuckDB の版>/` の下)。

JavaScript に束ねた依存のライセンスは、サイトの直下の [THIRD-PARTY-LICENSES.md](../THIRD-PARTY-LICENSES.md) にある。

## DuckDB・DuckDB-WASM・spatial 拡張 (MIT)

- DuckDB: <https://github.com/duckdb/duckdb>
- DuckDB-WASM: <https://github.com/duckdb/duckdb-wasm>
- spatial 拡張: <https://github.com/duckdb/duckdb-spatial>

DuckDB 本体に含まれる第三者のコードは、DuckDB のソースの `third_party/` にライセンスごとに置かれている。

```
Copyright 2018-2025 Stichting DuckDB Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## spatial 拡張が中に持っているライブラリ

spatial 拡張の WASM には、次のライブラリが静的にリンクされている (配っているファイルの中の
版の文字列で確かめた。2026-10-05、DuckDB v1.5.4 用)。

| ライブラリ | 版 | ライセンス | ソース |
| --- | --- | --- | --- |
| GEOS | 3.14 | **LGPL-2.1** (本文は [LGPL-2.1.txt](LGPL-2.1.txt)) | <https://github.com/libgeos/geos> |
| PROJ | 9.1.1 | MIT。座標系の定義に EPSG Dataset (IOGP の利用条件) を含む | <https://github.com/OSGeo/PROJ> |
| GDAL | — | MIT | <https://github.com/OSGeo/gdal> |
| SQLite | 3.49.1 | パブリックドメイン | <https://sqlite.org/> |

**GEOS (LGPL-2.1) について。** このサイトは GEOS を変えていない。拡張をビルドし直す (GEOS を差し替える)
のに要るものは、spatial 拡張のソース (MIT) と GEOS のソースとして、上のリンクから誰でも手に入る。
