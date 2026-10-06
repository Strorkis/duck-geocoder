/**
 * **出典・使う条件・使っている技術** の表示。カタログから組み立てる。
 *
 * どのデータセットを配信するかはカタログ次第なので、ここに書き並べると実際に使っている
 * ものとずれる。表示義務のある出典が抜けるのはライセンス違反になるため、データ側に追随させる。
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Collection, Terms } from '../lib/stac';
import { lang, m } from '../i18n';

/** 外部へのリンク。別タブで開き、参照元を渡さない。 */
export function externalLink(href: string, label: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = label;
  return link;
}

/**
 * 出典表示のリンク (MapLibre の出典表示に渡す HTML)。
 *
 * 国土交通省の利用約款も国土地理院の利用規約も、出典に当該ページのURLを求めている。
 * 表示義務のあるものなので、組み立ては1箇所に置く。
 */
function creditLink(url: string, label: string): string {
  return `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`;
}

/** 出典1つぶん (同じ出典を使うCollectionをまとめたもの)。 */
interface Credit {
  titles: string[];
  attribution: string;
  url: string;
  via: string[];
  vintages: string[];
  terms: Terms | undefined;
  /** サブカタログの題名 (PLATEAU など)。出所の一覧表の見出しに使う。 */
  group: string | undefined;
}

/**
 * 出典の文言に、**それが何のデータの出典なのか**を添える。
 *
 * 出典だけを並べると、どれがどのデータのものか読み取れない
 * (「（国土交通省）をもとに作成」が2つ並ぶ)。カタログの `title` を前置きして、
 * 「建物 (PLATEAU): 「3D都市モデル…」」の形にする。
 *
 * 同じ出典を使うCollectionはまとめる (大字・町丁目と街区は同じ位置参照情報)。
 */
function groupCredits(collections: Collection[]): Credit[] {
  const byAttribution = new Map<string, Omit<Credit, 'attribution'>>();
  for (const collection of collections) {
    const entry = byAttribution.get(collection.attribution) ?? {
      url: collection.attributionUrl,
      titles: [],
      via: [],
      vintages: [],
      // 同じ出典なら同じ規約 (出典と規約はパイプラインで1つの組として持っている)。
      terms: collection.terms,
      group: collection.group?.title,
    };
    // 同じ出典で細かさ違いのCollectionが並ぶことがある (人口メッシュの125mと1km)。
    if (!entry.titles.includes(collection.title)) entry.titles.push(collection.title);
    // 同じ出典でも配布元のページが分かれることがある (Overtureの区域と建物)。
    if (collection.via && !entry.via.includes(collection.via)) entry.via.push(collection.via);
    // 版。**分からないものは足さない** (「不明」と書くより、出さない方が誤解が少ない)。
    if (collection.vintage && !entry.vintages.includes(collection.vintage)) {
      entry.vintages.push(collection.vintage);
    }
    byAttribution.set(collection.attribution, entry);
  }
  // 並べ替えは表示する文言で行う (組み立てたHTMLで並べると、順序がタグの中身に左右される)。
  return [...byAttribution]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([attribution, entry]) => ({ attribution, ...entry }));
}

/** 規約の要約をバッジにする。**「可」と言い切れないものは言い切らない。** */
export function termsBadges(terms: Terms): HTMLElement {
  const box = document.createElement('span');
  box.className = 'terms-badges';
  const badge = (text: string, tone: 'ok' | 'note' | 'warn', title: string) => {
    const el = document.createElement('span');
    el.className = `terms-badge ${tone}`;
    el.textContent = text;
    el.title = title;
    box.append(el);
  };
  if (terms.commercial === 'allowed') badge(m.badgeCommercial, 'ok', m.badgeCommercialTitle);
  else if (terms.commercial === 'allowed_with_notice') {
    badge(m.badgeCommercialNotice, 'note', m.badgeCommercialNoticeTitle);
  } else if (terms.commercial === 'not_restricted') {
    badge(m.badgeCommercialUnstated, 'note', m.badgeCommercialUnstatedTitle);
  } else badge(m.badgeNonCommercial, 'warn', m.badgeNonCommercialTitle);
  if (terms.attribution_required) badge(m.badgeAttribution, 'note', m.badgeAttributionTitle);
  if (terms.note_modification) badge(m.badgeModification, 'note', m.badgeModificationTitle);
  if (terms.share_alike) badge(m.badgeShareAlike, 'warn', m.badgeShareAlikeTitle);
  return box;
}

/** 地図右下の出典表示 (MapLibre の AttributionControl) に渡す文言。 */
export function buildDataCredits(collections: Collection[]): string[] {
  return groupCredits(collections).map(
    ({ titles, attribution, url }) =>
      `<span class="credit"><b>${titles.join('・')}</b> ${creditLink(url, attribution)}</span>`,
  );
}

/** 一覧表の「商用」の欄。 */
const COMMERCIAL_LABELS: Record<Terms['commercial'], string> = {
  allowed: m.commercialAllowed,
  allowed_with_notice: m.commercialWithNotice,
  not_restricted: m.commercialUnstated,
  non_commercial: m.commercialNo,
};

/**
 * **使うときの条件の一覧表。** 出所ごとに1行で、商用可か・出典表示・加工の明記・継承を並べる。
 * 出典の文言を1つずつ読まなくても、何に使えるかが一目で分かるようにする。
 */
export function renderTermsSummary(container: HTMLElement, collections: Collection[]): void {
  const rows = groupCredits(collections).filter((credit) => credit.terms);
  if (rows.length === 0) {
    container.replaceChildren();
    return;
  }
  const table = document.createElement('table');
  table.className = 'terms-table';
  const head = table.createTHead().insertRow();
  for (const label of m.termsColumns) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  const mark = (value: boolean) => (value ? m.required : '—');
  for (const { titles, group, terms } of rows) {
    const row = body.insertRow();
    row.insertCell().textContent = group ? `${group}: ${titles.join('・')}` : titles.join('・');
    row.insertCell().textContent = COMMERCIAL_LABELS[terms!.commercial];
    row.insertCell().textContent = mark(terms!.attribution_required);
    row.insertCell().textContent = mark(terms!.note_modification);
    row.insertCell().textContent = terms!.share_alike ? m.yes : '—';
    row.insertCell().append(externalLink(terms!.url, terms!.name));
  }
  const note = document.createElement('p');
  note.className = 'terms-note';
  note.textContent = m.termsNote;
  container.replaceChildren(table, note);
}

/**
 * 出典をダイアログにも出す。**地図右下の ⓘ とは別に持つ。**
 *
 * MapLibreは出典の間を `" | "` のテキストで繋ぐので、1件ずつ改行させられない
 * (ブロックにすると区切りだけの行ができる)。結果として ⓘ の中身は1行に詰まり、
 * どれが何の出典なのか目で追いにくい。
 *
 * ⓘ は表示義務を果たす標準の置き場所として残し、**読ませるのはこちら**。
 * 地形 (Mapterhorn) のようにTileJSONから来る出典はカタログに無いので、
 * ⓘ の側が引き続き唯一の出どころになる。
 */
export function renderCredits(container: HTMLElement, collections: Collection[]): void {
  container.replaceChildren();
  for (const { titles, group, attribution, url, via, vintages, terms } of groupCredits(collections)) {
    const term = document.createElement('dt');
    // 上の早見表と同じ書き方 (「出所: データ」) にして、表の行と突き合わせられるようにする。
    term.textContent = group ? `${group}: ${titles.join('・')}` : titles.join('・');
    // **いつ時点のデータか。** 出所だけでは版が分からず、古いものを新しいと
    // 思って使う事故になる。分かっているものだけ添える。
    if (vintages.length > 0) {
      const vintage = document.createElement('span');
      vintage.className = 'vintage';
      vintage.textContent = vintages.join(' / ');
      term.append(' ', vintage);
    }

    const detail = document.createElement('dd');
    detail.append(externalLink(url, attribution));
    // 使うときの条件。バッジと規約の本文へのリンク (要約なので、本文が正本)。
    if (terms) {
      const line = document.createElement('div');
      line.className = 'terms-line';
      line.append(termsBadges(terms), ' ', externalLink(terms.url, terms.name));
      detail.append(line);
    }

    // **配布元へ辿れるようにする。** ここにあるのは変換した複製で、原典は向こうにある。
    // 出典表示のリンク先とは別 (Overtureは出典がガイドページを指す)。
    if (via.length > 0) {
      const sources = document.createElement('div');
      sources.className = 'via';
      sources.append(m.viaLabel);
      for (const [index, href] of via.entries()) {
        if (index > 0) sources.append(' / ');
        sources.append(externalLink(href, new URL(href).hostname));
      }
      detail.append(sources);
    }
    container.append(term, detail);
  }
}

/**
 * 出典表示が下端から占めている高さを測り、CSS変数 `--attribution-space` に入れる。
 *
 * **出典は出所が増えるほど行が増える。** 人口メッシュ (47都道府県) を足したときに
 * 1行から2行になり、全幅40pxに広がって左下のパネルを覆った (押せなくなった)。
 * パネルの位置を固定値で避けると、出所を足すたびに破れる。
 *
 * **高さではなく「下端からどこまで」を測る。** 出典の箱の下にはMapLibreが
 * 余白を入れるので、高さだけで避けると余白のぶん足りない (実測で2px重なった)。
 *
 * 出典そのものは縮めない。表示義務があるので、避けるのはこちらの役目。
 */
export function watchAttributionHeight(map: MapLibreMap): void {
  const container = map.getContainer();
  const attribution = container.querySelector<HTMLElement>('.maplibregl-ctrl-attrib');
  if (!attribution) return;
  const apply = () => {
    const space = container.getBoundingClientRect().bottom - attribution.getBoundingClientRect().top;
    document.documentElement.style.setProperty('--attribution-space', `${Math.ceil(space)}px`);
  };
  new ResizeObserver(apply).observe(attribution);
  apply();
}

/**
 * 出典をたたんだ状態から始める。
 *
 * MapLibreは `compact` でも**初回だけ広げた状態**で出す。出所が6件あるこのアプリでは
 * 418×230pxの箱になり、右下のパネルを押し上げてしまう。ⓘ を押せば出るので、
 * 最初からたたんでおく。広げ閉じはMapLibreがクラスの付け外しでやっているので、こちらも外して合わせる。
 */
export function collapseAttribution(map: MapLibreMap): void {
  map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
}

// ---- 使っている技術 -----------------------------------------------------------------

/** 使っている技術1つ分。 */
interface TechCredit {
  name: string;
  /** 誰のものか・何者か。ライセンスが分かっていれば添える。 */
  who: string;
  /** **このアプリのどこで使っているか。** 名前を並べるだけだと謝辞にならない。 */
  use: string;
  url: string;
}

/**
 * 使っている技術への謝辞。**データの出典と同じ扱いにする。**
 *
 * 3つに分けるのは、**依存に現れるかどうか**が違うため。ライブラリは
 * `package.json` / `Cargo.toml` を見れば分かるが、考え方や仕様だけを借りたもの
 * (STRの並べ替え、COGPの段の並びなど) はコードのどこにも名前が出ない。
 * ここに書かないと、借りたことが誰にも見えない。
 *
 * 仕様や論文への参照は、実際に設計を左右したものだけを載せる。
 * PLATEAU GIS Converter の README の謝辞 (Planetiler の手法を参考にした旨) に倣った。
 *
 * **リンクはできるだけGitHubのリポジトリにする** (仕様もリポジトリで公開されている)。
 * ただし**実在を確かめたものだけ** (2026-10-03にGitHub APIで確認)。リポジトリの
 * 無いもの (STRの論文・地域メッシュ・SORA) は元の出典のままにする。
 */
const TECH_CREDITS: { heading: string; items: TechCredit[] }[] = [
  {
    heading: '画面で使っているライブラリ',
    items: [
      {
        name: 'DuckDB-WASM',
        who: 'DuckDB · MIT',
        use: 'ブラウザの中で GeoParquet を SQL で読んでいます。HTTP の部分取得で、要る行グループだけを取りに行きます',
        url: 'https://github.com/duckdb/duckdb-wasm',
      },
      {
        name: 'DuckDB spatial',
        who: 'DuckDB · MIT',
        use: '指した場所の市区町村を調べるところと、周辺検索の距離の判定に使っています',
        url: 'https://github.com/duckdb/duckdb-spatial',
      },
      {
        name: 'MapLibre GL JS',
        who: 'MapLibre · BSD-3-Clause',
        use: '地図と建物の立体を描いています',
        url: 'https://github.com/maplibre/maplibre-gl-js',
      },
      {
        name: 'STAC Browser',
        who: 'Radiant Earth Foundation · ISC',
        use: 'カタログを地図ではなくページで辿る画面 (/catalog/) です。項目一覧の不具合を直すパッチを1つ当ててビルドしています',
        url: 'https://github.com/radiantearth/stac-browser',
      },
      {
        name: 'PMTiles (JavaScript)',
        who: 'Protomaps · BSD-3-Clause',
        use: '国土地理院のベクトルタイル (1つの PMTiles ファイル) から、要るタイルだけを部分取得で読んでいます',
        url: 'https://github.com/protomaps/PMTiles',
      },
    ],
  },
  {
    heading: 'データの変換で使っているライブラリ',
    items: [
      {
        name: 'PLATEAU GIS Converter (nusamai)',
        who: 'MIERUNE · MIT',
        use: 'PLATEAU の CityGML を読むところと、用途などのコードを日本語にするところを任せています',
        url: 'https://github.com/MIERUNE/plateau-gis-converter',
      },
      {
        name: 'DuckDB',
        who: 'DuckDB · MIT',
        use: 'Overture からの取り出しと、道路・鉄道の簡略化 (粗い段) に使っています',
        url: 'https://github.com/duckdb/duckdb',
      },
      {
        name: 'Apache Arrow / Parquet (arrow-rs)',
        who: 'Apache Software Foundation · Apache-2.0',
        use: 'GeoParquet の書き出しに使っています',
        url: 'https://github.com/apache/arrow-rs',
      },
      {
        name: 'PROJ',
        who: 'OSGeo · MIT',
        use: '座標系の変換に使っています',
        url: 'https://github.com/OSGeo/PROJ',
      },
      {
        name: 'GeoRust (geo-types / wkb / geojson)',
        who: 'GeoRust · MIT / Apache-2.0',
        use: 'ジオメトリの扱いと WKB の書き出しに使っています',
        url: 'https://github.com/georust',
      },
    ],
  },
  {
    heading: '考え方・仕様を借りているもの (ライブラリは使っていません)',
    items: [
      {
        name: 'STAC',
        who: '仕様',
        use: 'データの目録の形 (Catalog → Collection → Item) です。一覧の見出しと行は、この階層のとおりに並べています',
        url: 'https://github.com/radiantearth/stac-spec',
      },
      {
        name: 'GeoParquet',
        who: '仕様 (OGC)',
        use: '配っているファイルの形です。bbox の列を使って、表示範囲の外の行グループを読み飛ばしています',
        url: 'https://github.com/opengeospatial/geoparquet',
      },
      {
        // **参考にしたのは Kanahiro さんの発表資料** (2026-08-24 CNG Japan「Spatial sort for well-packed
        // GeoParquet」。COGP の README の発表一覧にある)。論文は手法の元として添える。
        // 論文を読んで一から実装したわけではない (利用者の指摘、2026-10-06)。
        name: 'STR (Sort-Tile-Recursive) で並べる',
        who: 'Kanahiro (CNG Japan 2026 の発表資料) · 手法の元は Leutenegger ら (ICDE 1997)',
        use: '空間的に近い地物を同じ行グループに詰める並べ替えです。発表資料「Spatial sort for well-packed GeoParquet」を参考にしています',
        url: 'https://drive.google.com/file/d/1ZkRvXv9Ryak_jiZZqL-QAxGl--TBw668/view?usp=sharing',
      },
      {
        name: 'Cloud Optimized GeoParquet (COGP)',
        who: 'Kanahiro',
        use: '粗い段を行グループの先頭に置き、細かい段を後ろに続ける並びです。将来乗り換えられるよう、配置を合わせています',
        url: 'https://github.com/Kanahiro/cloud-optimized-geoparquet',
      },
      {
        name: 'PMTiles (考え方)',
        who: 'Protomaps',
        use: '解像度ごとにファイルを分けず、1つのファイルに収める考え方です。GeoParquet の粗い段を別のファイルにしなかったのは、これに倣っています',
        url: 'https://github.com/protomaps/PMTiles',
      },
      {
        name: 'Portolan',
        who: '仕様',
        use: 'オブジェクトストレージに STAC と GeoParquet を置くだけで配る構成です。項目名を借りています (準拠はまだです)',
        url: 'https://github.com/portolan-sdi/portolan-spec',
      },
      {
        name: '地域メッシュ (JIS X 0410)',
        who: '日本産業規格',
        use: '整備範囲と人口メッシュのセルです。緯度経度から計算で決まるので、境界のデータが要りません',
        url: 'https://www.stat.go.jp/data/mesh/m_tuite.html',
      },
      {
        name: 'SORA 2.5',
        who: 'JARUS',
        use: '人口密度の凡例 (地上リスクの区分) に使っています',
        url: 'http://jarus-rpas.org/',
      },
    ],
  },
];

/**
 * 謝辞の英語。**項目名 (日本語の `name`) で引く** (PMTiles はライブラリと考え方の2項目でリンク先が同じ)。
 * 無い項目は日本語のまま出る。見出しは並びの順。
 */
const TECH_HEADINGS_EN = [
  'Libraries used in the app',
  'Libraries used to convert the data',
  'Ideas and specifications borrowed (no library used)',
];
const TECH_CREDITS_EN: Record<string, { use: string; name?: string; who?: string }> = {
  'DuckDB-WASM': {
    use: 'Reads GeoParquet with SQL inside the browser. HTTP range requests fetch only the row groups needed',
  },
  'DuckDB spatial': { use: 'Finds the municipality at a clicked point and measures distances for nearby search' },
  'MapLibre GL JS': { use: 'Draws the map and the 3D buildings' },
  'STAC Browser': {
    use: 'A page for browsing the catalog without a map (/catalog/). Built with one patch that fixes the item list',
  },
  'PMTiles (JavaScript)': {
    use: 'Reads only the tiles needed from GSI’s vector tiles (a single PMTiles file) with range requests',
  },
  'PLATEAU GIS Converter (nusamai)': {
    use: 'Reads PLATEAU’s CityGML and resolves codes such as usage into Japanese names',
  },
  DuckDB: { use: 'Extracts Overture data and simplifies roads and railways (coarse levels)' },
  'Apache Arrow / Parquet (arrow-rs)': { use: 'Writes GeoParquet' },
  PROJ: { use: 'Transforms coordinate systems' },
  'GeoRust (geo-types / wkb / geojson)': { use: 'Handles geometries and writes WKB' },
  STAC: {
    who: 'Specification',
    use: 'The shape of the data catalog (Catalog → Collection → Item). The list headings and rows follow this hierarchy',
  },
  GeoParquet: {
    who: 'Specification (OGC)',
    use: 'The format of the distributed files. The bbox column lets row groups outside the view be skipped',
  },
  'STR (Sort-Tile-Recursive) で並べる': {
    name: 'Sorting with STR (Sort-Tile-Recursive)',
    who: 'Kanahiro (CNG Japan 2026 talk) · method by Leutenegger et al. (ICDE 1997)',
    use: 'Sorts nearby features into the same row group, following the talk “Spatial sort for well-packed GeoParquet”',
  },
  'Cloud Optimized GeoParquet (COGP)': {
    use: 'Puts coarse levels at the start of the row groups and finer levels after them. The layout is kept compatible so we can switch later',
  },
  'PMTiles (考え方)': {
    name: 'PMTiles (the idea)',
    use: 'Keeping all resolutions in one file. The coarse levels of GeoParquet are not split into separate files for this reason',
  },
  Portolan: {
    who: 'Specification',
    use: 'Distributing data just by putting STAC and GeoParquet on object storage. Field names are borrowed (not yet compliant)',
  },
  '地域メッシュ (JIS X 0410)': {
    name: 'Japanese grid squares (JIS X 0410)',
    who: 'Japanese Industrial Standards',
    use: 'Cells for coverage and the population mesh. Computed from latitude and longitude, so no boundary data is needed',
  },
  'SORA 2.5': { use: 'The population density legend (ground risk classes)' },
};

/** 使っている技術の謝辞を出す。出典 (`renderCredits`) と同じ見た目にする。 */
export function renderTechCredits(container: HTMLElement): void {
  container.replaceChildren();
  for (const [index, { heading, items }] of TECH_CREDITS.entries()) {
    const title = document.createElement('p');
    title.className = 'tech-heading';
    title.textContent = lang === 'en' ? (TECH_HEADINGS_EN[index] ?? heading) : heading;
    const list = document.createElement('dl');
    list.className = 'tech-list';
    for (const item of items) {
      const en = lang === 'en' ? TECH_CREDITS_EN[item.name] : undefined;
      const term = document.createElement('dt');
      term.append(externalLink(item.url, en?.name ?? item.name));
      const by = document.createElement('span');
      by.className = 'vintage';
      by.textContent = en?.who ?? item.who;
      term.append(' ', by);
      const detail = document.createElement('dd');
      detail.textContent = en?.use ?? item.use;
      list.append(term, detail);
    }
    container.append(title, list);
  }
  // **ライセンスの全文へ辿れるようにする。** 上はライセンスの名前だけで、MIT や BSD が求める
  // 著作権表示と許諾文はビルドで書き出したファイルにある (vite.config.ts)。開発中は無い。
  if (import.meta.env.PROD) {
    const note = document.createElement('p');
    note.className = 'tech-licenses';
    note.append(
      m.fullLicenses,
      externalLink(`${import.meta.env.BASE_URL}THIRD-PARTY-LICENSES.md`, m.appLibraries),
      ' · ',
      externalLink(`${import.meta.env.BASE_URL}duckdb/LICENSES.md`, m.duckdbAndExtensions),
    );
    container.append(note);
  }
}
