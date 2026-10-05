/**
 * **出典・使う条件・使っている技術** の表示。カタログから組み立てる。
 *
 * どのデータセットを配信するかはカタログ次第なので、ここに書き並べると実際に使っている
 * ものとずれる。表示義務のある出典が抜けるのはライセンス違反になるため、データ側に追随させる。
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Collection, Terms } from '../lib/stac';

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
  if (terms.commercial === 'allowed') badge('商用可', 'ok', '規約が商用利用を認めている');
  else if (terms.commercial === 'not_restricted') {
    badge('商用の制限の記載なし', 'note', '規約に商用を認めるとも禁じるとも書いていない。本文を確かめること');
  } else badge('非商用のみ', 'warn', '商用には使えない');
  if (terms.attribution_required) badge('出典表示が必要', 'note', '使うときは出典を表示する');
  if (terms.note_modification) badge('加工したら明記', 'note', '加工したデータを使うときは、加工した旨を書く');
  if (terms.share_alike) {
    badge('継承あり', 'warn', '派生したデータを配るときは同じライセンスにする (別ファイルとして並べるだけなら及ばない)');
  }
  return box;
}

/** 地図右下の出典表示 (MapLibre の AttributionControl) に渡す文言。 */
export function buildDataCredits(collections: Collection[]): string[] {
  return groupCredits(collections).map(
    ({ titles, attribution, url }) =>
      `<span class="credit"><b>${titles.join('・')}</b> ${creditLink(url, attribution)}</span>`,
  );
}

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
  for (const label of ['データ', '商用', '出典表示', '加工したら明記', '継承', '規約']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  const mark = (value: boolean) => (value ? '要' : '—');
  for (const { titles, group, terms } of rows) {
    const row = body.insertRow();
    row.insertCell().textContent = group ? `${group}: ${titles.join('・')}` : titles.join('・');
    row.insertCell().textContent =
      terms!.commercial === 'allowed' ? '可' : terms!.commercial === 'non_commercial' ? '不可' : '記載なし';
    row.insertCell().textContent = mark(terms!.attribution_required);
    row.insertCell().textContent = mark(terms!.note_modification);
    row.insertCell().textContent = terms!.share_alike ? 'あり' : '—';
    row.insertCell().append(externalLink(terms!.url, terms!.name));
  }
  const note = document.createElement('p');
  note.className = 'terms-note';
  note.textContent =
    '規約を読んだ結果の要約です。正本は各規約の本文です。「記載なし」は、規約が商用を認めるとも禁じるとも書いていないものです。';
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
  for (const { titles, attribution, url, via, vintages, terms } of groupCredits(collections)) {
    const term = document.createElement('dt');
    term.textContent = titles.join('・');
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
      sources.append('配布元: ');
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
        use: 'ブラウザの中でGeoParquetをSQLで読む。HTTPの部分取得で、要る行グループだけを取りに行く',
        url: 'https://github.com/duckdb/duckdb-wasm',
      },
      {
        name: 'DuckDB spatial',
        who: 'DuckDB · MIT',
        use: '指した場所がどの市区町村かを調べる空間関数と、周辺検索の距離の判定',
        url: 'https://github.com/duckdb/duckdb-spatial',
      },
      {
        name: 'MapLibre GL JS',
        who: 'MapLibre · BSD-3-Clause',
        use: '地図と建物の立体の描画',
        url: 'https://github.com/maplibre/maplibre-gl-js',
      },
      {
        name: 'STAC Browser',
        who: 'Radiant Earth Foundation · ISC',
        use: 'カタログを地図ではなくページで辿る画面 (/catalog/)。項目一覧の不具合を直すパッチを1つ当ててビルドしている',
        url: 'https://github.com/radiantearth/stac-browser',
      },
      {
        name: 'PMTiles (JavaScript)',
        who: 'Protomaps · BSD-3-Clause',
        use: '国土地理院のベクトルタイル (1つのPMTilesファイル) から、要るタイルだけを部分取得で読む',
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
        use: 'PLATEAUのCityGMLを読む。用途などのコードを日本語に解決するところまで任せている',
        url: 'https://github.com/MIERUNE/plateau-gis-converter',
      },
      {
        name: 'DuckDB',
        who: 'DuckDB · MIT',
        use: 'Overtureの取り出しと、道路・鉄道の簡略化 (粗い段) の作成',
        url: 'https://github.com/duckdb/duckdb',
      },
      {
        name: 'Apache Arrow / Parquet (arrow-rs)',
        who: 'Apache Software Foundation · Apache-2.0',
        use: 'GeoParquetの書き出し',
        url: 'https://github.com/apache/arrow-rs',
      },
      {
        name: 'PROJ',
        who: 'OSGeo · MIT',
        use: '座標系の変換',
        url: 'https://github.com/OSGeo/PROJ',
      },
      {
        name: 'GeoRust (geo-types / wkb / geojson)',
        who: 'GeoRust · MIT / Apache-2.0',
        use: 'ジオメトリの扱いとWKBの書き出し',
        url: 'https://github.com/georust',
      },
    ],
  },
  {
    heading: '考え方・仕様を借りているもの (ライブラリは使っていない)',
    items: [
      {
        name: 'STAC',
        who: '仕様',
        use: 'データの目録の形 (Catalog → Collection → Item)。一覧の見出しと行はこの階層そのもの',
        url: 'https://github.com/radiantearth/stac-spec',
      },
      {
        name: 'GeoParquet',
        who: '仕様 (OGC)',
        use: '配るファイルの形。bboxの列で、表示範囲の外の行グループを読み飛ばす',
        url: 'https://github.com/opengeospatial/geoparquet',
      },
      {
        name: 'STR (Sort-Tile-Recursive)',
        who: 'Leutenegger, Lopez, Edgington (ICDE 1997)',
        use: '空間的に近い地物を同じ行グループに詰める並べ替え。論文を読んで自前で実装した',
        url: 'https://doi.org/10.1109/ICDE.1997.582015',
      },
      {
        name: 'Cloud Optimized GeoParquet (COGP)',
        who: 'Kanahiro',
        use: '粗い段を行グループの先頭に置き、細かい段を後ろに続ける並び。将来乗り換えられるよう、配置を合わせてある',
        url: 'https://github.com/Kanahiro/cloud-optimized-geoparquet',
      },
      {
        name: 'PMTiles (考え方)',
        who: 'Protomaps',
        use: '解像度ごとにファイルを分けず、1つのファイルに収める考え方。GeoParquetの粗い段を別ファイルにしなかったのはこれに倣った',
        url: 'https://github.com/protomaps/PMTiles',
      },
      {
        name: 'Portolan',
        who: '仕様',
        use: 'オブジェクトストレージにSTACとGeoParquetを置くだけで配る構成。項目名を借りている (準拠はまだ)',
        url: 'https://github.com/portolan-sdi/portolan-spec',
      },
      {
        name: '地域メッシュ (JIS X 0410)',
        who: '日本産業規格',
        use: '整備範囲と人口メッシュのセル。緯度経度から計算で決まるので境界データが要らない',
        url: 'https://www.stat.go.jp/data/mesh/m_tuite.html',
      },
      {
        name: 'SORA 2.5',
        who: 'JARUS',
        use: '人口密度の凡例 (地上リスクの区分)',
        url: 'http://jarus-rpas.org/',
      },
    ],
  },
];

/** 使っている技術の謝辞を出す。出典 (`renderCredits`) と同じ見た目にする。 */
export function renderTechCredits(container: HTMLElement): void {
  container.replaceChildren();
  for (const { heading, items } of TECH_CREDITS) {
    const title = document.createElement('p');
    title.className = 'tech-heading';
    title.textContent = heading;
    const list = document.createElement('dl');
    list.className = 'tech-list';
    for (const { name, who, use, url } of items) {
      const term = document.createElement('dt');
      term.append(externalLink(url, name));
      const by = document.createElement('span');
      by.className = 'vintage';
      by.textContent = who;
      term.append(' ', by);
      const detail = document.createElement('dd');
      detail.textContent = use;
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
      'ライセンスの全文: ',
      externalLink(`${import.meta.env.BASE_URL}THIRD-PARTY-LICENSES.md`, '画面のライブラリ'),
      ' · ',
      externalLink(`${import.meta.env.BASE_URL}duckdb/LICENSES.md`, 'DuckDB と拡張'),
    );
    container.append(note);
  }
}
