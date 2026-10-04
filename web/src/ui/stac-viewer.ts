/**
 * **STACの文書をページの中で見せる。** リンクを押すと次の文書へ進める (カタログを歩ける)。
 *
 * 以前は生のJSONを別タブで開いていた。それだと地図から離れるうえ、
 * そこから先 (親・子・Item) へは自分でURLを組み立てないと辿れない。
 *
 * リンクの解決はアプリ本体と同じ規則 (`resolveHref` — その文書からの相対)。
 * 実データ (parquet) は開かない。数十MBあり、開いても読めないため。
 */
import { dataUrl, fetchStac, resolveHref, type StacLink } from '../lib/stac';
import { externalLink } from './credits';

/** STACの文書のうち、見せるのに要るところだけ。種類を問わず読む。 */
interface StacDocument {
  type?: string;
  id?: string;
  title?: string;
  links?: StacLink[];
  features?: unknown[];
}

/**
 * ItemCollectionの `features` を見せる件数。PLATEAUは306件・595KBあり、
 * 全部を整形して出すと1MBを超えて画面が固まる。**全体は生のJSONで見られる。**
 */
const STAC_FEATURE_PREVIEW = 20;

/** ダイアログを用意して、「この文書を開く」関数を返す。 */
export function createStacViewer(dialog: HTMLDialogElement): (path: string) => void {
  const pick = <T extends Element>(selector: string) => dialog.querySelector<T>(selector)!;
  const backButton = pick<HTMLButtonElement>('#stac-back');
  const typeEl = pick<HTMLSpanElement>('#stac-type');
  const titleEl = pick<HTMLElement>('#stac-title');
  const pathEl = pick<HTMLElement>('#stac-path');
  const linksEl = pick<HTMLDListElement>('#stac-links');
  const noteEl = pick<HTMLParagraphElement>('#stac-note');
  const jsonEl = pick<HTMLPreElement>('#stac-json');
  const rawLink = pick<HTMLAnchorElement>('#stac-raw');

  /** 辿ってきた文書 (配信の起点からのパス)。末尾がいま見ているもの。 */
  const trail: string[] = [];

  const linkTarget = (link: StacLink, base: string): Node => {
    // 配布元など、カタログの外を指すもの。
    if (/^[a-z][a-z0-9+.-]*:/i.test(link.href)) return externalLink(link.href, link.title ?? link.href);
    const path = resolveHref(link.href, base);
    if (!path.endsWith('.json')) {
      const code = document.createElement('code');
      code.textContent = path;
      return code;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stac-link';
    button.textContent = link.title ? `${link.title} (${path})` : path;
    button.addEventListener('click', () => go(path));
    return button;
  };

  const render = async (path: string) => {
    backButton.disabled = trail.length < 2;
    typeEl.textContent = '';
    titleEl.textContent = '読み込み中…';
    pathEl.textContent = path;
    linksEl.replaceChildren();
    noteEl.hidden = true;
    jsonEl.textContent = '';
    rawLink.href = dataUrl(path);

    let document_: StacDocument;
    try {
      document_ = await fetchStac<StacDocument>(path);
    } catch (e) {
      titleEl.textContent = '読めませんでした';
      jsonEl.textContent = String(e);
      return;
    }
    // 読んでいる間に別の文書へ進んでいたら、古い方は捨てる。
    if (trail.at(-1) !== path) return;

    typeEl.textContent = document_.type ?? '';
    titleEl.textContent = document_.title ?? document_.id ?? path;

    // `self` は今いる文書なので並べない。
    for (const link of document_.links ?? []) {
      if (link.rel === 'self') continue;
      const dt = document.createElement('dt');
      dt.textContent = link.rel;
      const dd = document.createElement('dd');
      dd.append(linkTarget(link, path));
      linksEl.append(dt, dd);
    }

    const features = document_.features;
    const shown =
      Array.isArray(features) && features.length > STAC_FEATURE_PREVIEW
        ? { ...document_, features: features.slice(0, STAC_FEATURE_PREVIEW) }
        : document_;
    if (shown !== document_) {
      noteEl.textContent =
        `features は ${features!.length.toLocaleString()} 件のうち先頭 ` +
        `${STAC_FEATURE_PREVIEW} 件だけ表示しています。全体は下のリンクから。`;
      noteEl.hidden = false;
    }
    jsonEl.textContent = JSON.stringify(shown, null, 2);
    jsonEl.scrollTop = 0;
  };

  const go = (path: string) => {
    trail.push(path);
    void render(path);
  };

  backButton.addEventListener('click', () => {
    if (trail.length < 2) return;
    trail.pop();
    void render(trail.at(-1)!);
  });
  pick<HTMLButtonElement>('#stac-close').addEventListener('click', () => dialog.close());
  // **背景を押したら閉じる。** 中身は内側の要素に入れてあるので、
  // dialog 自身がクリックの的になるのは背景 (::backdrop) を押したときだけ。
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  return (path: string) => {
    trail.length = 0;
    go(path);
    if (!dialog.open) dialog.showModal();
  };
}
