/**
 * **画面の言語** (日本語・英語)。
 *
 * - 言語は `?lang=ja|en` があればそれ、無ければブラウザの言語で決める (日本語でなければ英語)。
 *   URL に持つので、読み直しても同じ言語のまま、リンクを渡しても同じ言語で開く
 * - TS の文言は `m` から引く (`m.searchFailed`、数を含むものは `m.rowsSaved(n)`)。
 *   日本語と英語の辞書は同じ形で、**英語が抜けていたら型で落ちる** (messages.ts)
 * - index.html の文言は日本語をそのまま書いておき、`data-i18n*` の付いた要素だけを
 *   英語のときに差し替える (`applyHtmlText`)。HTML に日本語が残るので、読めば何の文言か分かる
 *
 * **訳さないもの:** データの中身 (地名・駅名・用途など)、規約が書き方を指定している出典の文言、
 * カタログの題名と説明 (カタログ側で英語版を持つまでは日本語のまま)。
 */
// 拡張子を付けておく (単体テストが Node から直接読むため。Node は拡張子を補わない)。
import { HTML_EN, MESSAGES, type Messages } from './messages.ts';

export type Lang = 'ja' | 'en';

/** URL の `lang` → ブラウザの言語、の順で決める。 */
export function detectLang(search: string, languages: readonly string[]): Lang {
  const requested = new URLSearchParams(search).get('lang');
  if (requested === 'ja' || requested === 'en') return requested;
  return languages[0]?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export const lang: Lang =
  typeof window === 'undefined' ? 'ja' : detectLang(window.location.search, navigator.languages ?? []);

/** いまの言語の文言。 */
export const m: Messages = MESSAGES[lang];

/**
 * index.html の `data-i18n*` の付いた要素を、いまの言語にする。日本語なら何もしない
 * (HTML に書いてあるのが日本語なので)。**要素を引く前に呼ぶ** (`data-i18n-html` は中身を作り直す)。
 *
 * - `data-i18n`: 文字 (textContent)
 * - `data-i18n-html`: 中身の HTML (太字やリストを含む説明)
 * - `data-i18n-title` / `data-i18n-placeholder` / `data-i18n-aria-label`: 属性
 */
export function applyHtmlText(root: ParentNode = document): void {
  document.documentElement.lang = lang;
  if (lang === 'ja') return;
  const text = (key: string | undefined) => (key ? (HTML_EN[key] ?? null) : null);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const value = text(el.dataset.i18n);
    if (value !== null) el.textContent = value;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) {
    const value = text(el.dataset.i18nHtml);
    if (value !== null) el.innerHTML = value;
  }
  for (const [attribute, dataKey] of [
    ['title', 'i18nTitle'],
    ['placeholder', 'i18nPlaceholder'],
    ['aria-label', 'i18nAriaLabel'],
  ] as const) {
    for (const el of root.querySelectorAll<HTMLElement>(`[data-${attribute === 'aria-label' ? 'i18n-aria-label' : `i18n-${attribute}`}]`)) {
      const value = text(el.dataset[dataKey]);
      if (value !== null) el.setAttribute(attribute, value);
    }
  }
}

/** 言語を切り替えたページの URL (いまの URL の `lang` だけ差し替える)。 */
export function urlWithLang(href: string, next: Lang): string {
  const url = new URL(href);
  url.searchParams.set('lang', next);
  return url.toString();
}
