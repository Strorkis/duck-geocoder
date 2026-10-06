/**
 * **STACの文書をページの中で見せる。** リンクを押すと次の文書へ進める (カタログを歩ける)。
 *
 * 以前は生のJSONを別タブで開いていた。それだと地図から離れるうえ、
 * そこから先 (親・子・Item) へは自分でURLを組み立てないと辿れない。
 *
 * リンクの解決はアプリ本体と同じ規則 (`resolveHref` — その文書からの相対)。
 * 実データ (parquet) は開かない。数十MBあり、開いても読めないため。
 *
 * **Item は stac-geoparquet にある** (全 Collection で1つ)。Collection のアセット
 * (roles に `stac-items`) を押すと、その Collection の行だけを DuckDB で読んで見せる。
 * 行き先は `items.parquet#<Collection ID>` という、このビューアの中だけの道しるべで表す。
 */
import {
  dataUrl,
  fetchStac,
  isAbsoluteUrl,
  readItems,
  resolveHref,
  type StacAsset,
  type StacLink,
} from '../lib/stac';
import { externalLink } from './credits';
import { m } from '../i18n';

/** STACの文書のうち、見せるのに要るところだけ。種類を問わず読む。 */
interface StacDocument {
  type?: string;
  id?: string;
  title?: string;
  links?: StacLink[];
  assets?: Record<string, StacAsset>;
  features?: unknown[];
}

/**
 * Item の一覧を見せる件数。PLATEAUは306件あり、
 * 全部を整形して出すと1MBを超えて画面が固まる。
 */
const STAC_FEATURE_PREVIEW = 20;

/** `items.parquet#plateau-buildings` → ファイルと Collection ID。それ以外は undefined。 */
const itemsTarget = (path: string) => {
  const match = /^(.+\.parquet)#(.+)$/.exec(path);
  return match ? { file: match[1], collection: match[2] } : undefined;
};

/** stac-geoparquet から、1つの Collection の Item を ItemCollection の形にして読む。 */
async function readItemCollection(file: string, collection: string): Promise<StacDocument> {
  const features = await readItems(file, collection);
  return {
    type: 'FeatureCollection',
    title: collection,
    // Collection へ戻れるように。Item の links は Collection 文書を指している。
    links: features[0]?.links?.filter((link) => link.rel === 'collection') ?? [],
    features,
  };
}

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
  /** 「JSONをそのまま開く」の文言 (画面の言語に合わせたもの)。Item のときだけ差し替える。 */
  const rawLabel = rawLink.textContent;

  const linkTarget = (link: StacLink, base: string): Node => {
    const path = resolveHref(link.href, base);
    // カタログの外を指すもの。**JSON (公開元の STAC など) はここで開く** — 置き場所によっては
    // ブラウザで開くとダウンロードになる。それ以外 (配布元のページなど) は別タブ。
    if (isAbsoluteUrl(path)) {
      const json = link.type?.includes('json') || new URL(path).pathname.endsWith('.json');
      if (!json) return externalLink(path, link.title ?? path);
    } else if (!path.endsWith('.json')) {
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
    titleEl.textContent = m.loading;
    pathEl.textContent = path;
    linksEl.replaceChildren();
    noteEl.hidden = true;
    jsonEl.textContent = '';
    const items = itemsTarget(path);
    // Item は Parquet なので、開くのではなく保存させる (中身は全 Collection 分)。
    rawLink.href = items ? dataUrl(items.file) : isAbsoluteUrl(path) ? path : dataUrl(path);
    rawLink.textContent = items ? m.stacSaveItems : rawLabel;
    if (items) rawLink.download = '';
    else rawLink.removeAttribute('download');

    let document_: StacDocument;
    try {
      document_ = items
        ? await readItemCollection(items.file, items.collection)
        : await fetchStac<StacDocument>(path);
    } catch (e) {
      titleEl.textContent = m.couldNotRead;
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
    // Item の stac-geoparquet (アセット)。リンクと同じ並びに置き、押せばこの Collection の行を読む。
    for (const [key, asset] of Object.entries(document_.assets ?? {})) {
      if (!asset.roles?.includes('stac-items') || !document_.id) continue;
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'stac-link';
      const file = resolveHref(asset.href, path);
      button.textContent = asset.title ? `${asset.title} (${file})` : file;
      const target = `${file}#${document_.id}`;
      button.addEventListener('click', () => go(target));
      dd.append(button);
      linksEl.append(dt, dd);
    }

    const features = document_.features;
    const shown =
      Array.isArray(features) && (items || features.length > STAC_FEATURE_PREVIEW)
        ? { ...document_, features: features.slice(0, STAC_FEATURE_PREVIEW) }
        : document_;
    if (shown !== document_) {
      noteEl.textContent = items
        ? m.stacItemsPreview(features!.length, STAC_FEATURE_PREVIEW)
        : m.stacFeaturesPreview(features!.length, STAC_FEATURE_PREVIEW);
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
