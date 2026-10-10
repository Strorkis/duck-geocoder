// ソースから「目印の行」の前後を切り出す。読み物 (docs/tour.html) のコードの抜き出しに使う。
//
// 目印の行の直前にある説明のコメント (`///` `//` `/** … */`) から始め、目印の行で開いた波かっこが
// 閉じるところまでを取る。長いものは maxLines で切る。**手で貼らない**のは、コードを変えたときに
// 読み物だけ古くなるのを防ぐため (作り直せば追いつく)。
import { readFileSync } from 'node:fs';

/**
 * @param {string} root リポジトリの起点
 * @param {{ file: string, anchor: string, until?: string, maxLines?: number }} spec
 *   `until` があれば、目印のあとで最初にそれを含む行まで (波かっこは数えない)
 * @returns {{ file: string, start: number, end: number, lines: string[], truncated: boolean }}
 */
export function extract(root, { file, anchor, until, maxLines = 45 }) {
  const lines = readFileSync(`${root}/${file}`, 'utf8').split('\n');
  const at = lines.findIndex((line) => line.includes(anchor));
  if (at < 0) throw new Error(`目印が見つかりません: ${file}: ${anchor}`);

  if (until !== undefined) {
    const stop = lines.findIndex((line, i) => i > at && line.includes(until));
    if (stop < 0) throw new Error(`終わりの目印が見つかりません: ${file}: ${until}`);
    const truncated = stop - at + 1 > maxLines;
    const last = truncated ? at + maxLines - 1 : stop;
    return { file, start: at + 1, end: last + 1, lines: lines.slice(at, last + 1), truncated };
  }

  // 直前の説明のコメントと属性 (#[...]) を含める。
  let start = at;
  while (start > 0) {
    const prev = lines[start - 1].trim();
    if (/^(\/\/\/|\/\/|\*|\/\*\*|\*\/|#\[)/.test(prev)) start--;
    else break;
  }

  // 目印の行から、波かっこの対応が閉じるまで。文字列の中の波かっこも数えるが、
  // このリポジトリのコードでは対になっているので足りる。
  // **数え始めるのは、行末が `{` で終わる行 (本体の始まり) から。** 引数の型の `{ files: … }` のような
  // 波かっこで閉じたと思わないため。
  let depth = 0;
  let opened = false;
  let end = at;
  for (let i = at; i < lines.length; i++) {
    const text = lines[i].trimEnd();
    if (!opened && text.endsWith('{')) opened = true;
    if (opened) {
      for (const ch of lines[i]) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
    }
    end = i;
    if (opened && depth <= 0) break;
    // 波かっこの無い宣言 (`const x = …;`) は、文の終わりで止める。
    if (!opened && text.endsWith(';')) break;
  }

  const truncated = end - start + 1 > maxLines;
  const last = truncated ? start + maxLines - 1 : end;
  return { file, start: start + 1, end: last + 1, lines: lines.slice(start, last + 1), truncated };
}
