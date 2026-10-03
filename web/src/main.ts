import './style.css';
import * as duckdb from '@duckdb/duckdb-wasm';
import {
  MapLibreMap,
  GeoJSONSource,
  Popup,
  AttributionControl,
  NavigationControl,
  TerrainControl,
  setWorkerUrl,
  type ExpressionSpecification,
  type RasterTileSource,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibreは既定では new URL(`./${名前}`, import.meta.url) でワーカーを探すが、
// 名前が変数なのでバンドラが静的に検出できず、ビルド成果物に出力されない。
// 結果、本番だけGeoJSONソースが一切描画されなくなる (地図タイルもポップアップも
// 動くので気付きにくい)。?worker&url で Vite にワーカーとしてバンドルさせ、
// 解決済みのURLを setWorkerUrl で明示する。
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(maplibreWorkerUrl);

/**
 * カタログは [STAC 1.1.0](https://github.com/radiantearth/stac-spec)。
 * Rust側の build_catalog がGeoParquetのメタデータから生成するので、
 * 変換したファイルが増えればUIは自動で追随する。
 *
 * ```text
 * catalog.json                      ← Catalog。出所ごとのサブカタログへの child リンク
 * estat/catalog.json                ← Catalog (サブカタログ)。「国勢調査」
 * estat/estat-mesh-pop.json         ← Collection。何があるか。件数で増えない
 * estat/estat-mesh-pop-items.json   ← ItemCollection。ファイル1つずつの href と bbox
 * ```
 *
 * **起動時に読むのは Catalog と Collection だけ。** Item は使う段になって読む。
 * 1ファイルに全部入れていた頃は、人口メッシュ47件で72KBまで膨らんでいた。
 *
 * **レイヤーの一覧はこの階層で組む。** サブカタログが見出し、Collectionが行。
 * 画面を読むことがそのままカタログを歩くことになるようにしてある。
 */
interface StacLink {
  rel: string;
  href: string;
  type?: string;
  title?: string;
}

type DatasetKind =
  | 'admin'
  | 'admin_names'
  | 'oaza'
  | 'block'
  | 'buildings'
  | 'plateau_buildings'
  | 'building_coverage'
  | 'population_mesh'
  | 'railway'
  | 'railway_station'
  | 'road'
  | 'road_route'
  | 'power_line'
  | 'waterway';

/** STAC Catalog。ルートと、出所ごとのサブカタログ。 */
interface StacCatalog {
  type: 'Catalog';
  id: string;
  title?: string;
  description?: string;
  links: StacLink[];
}

/** STAC Collection。`duck:` の付いたものはSTACに無い独自項目。 */
interface StacCollection {
  type: 'Collection';
  id: string;
  title?: string;
  description?: string;
  /** SPDX識別子か "other"。 */
  license?: string;
  providers?: { name: string; roles?: string[]; url?: string }[];
  /** 種別。UIが扱いを切り替えるのに使う。STACにこの概念は無い。 */
  'duck:kind': DatasetKind;
  /** 地図に出す出典の文言。**表示義務があるので縮めない。** */
  'duck:attribution': string;
  'duck:attribution_url': string;
  /** 地域メッシュの細かさ (メッシュコードの桁数)。メッシュ以外には無い。 */
  'duck:mesh_digits'?: number;
  /**
   * **粗い段の簡略化の許容誤差 (メートル)。** 段を持つファイルにだけ付く。
   *
   * 付いていれば、引いた表示で `lod = 0` の行 (統合して簡略化したもの) を引ける。
   * どのズームまで粗い段で足りるかは [`coarseLodUntilZoom`] が誤差から決めるので、
   * **ズーム閾値をここに書かない。**
   */
  'duck:coarse_lod_tolerance_m'?: number;
  /**
   * **どのCollectionの整備範囲か** (`"plateau-buildings"`)。
   *
   * 整備範囲のメッシュだけが持つ。これを見て建物に結び付ける。
   * 「PLATEAUのものだ」とここで決め打ちすると、出所が増えたときに
   * 書き足す場所が分かれる。
   */
  'duck:covers'?: string;
  /**
   * **建物の重要度の段の規則。** 建物のCollectionだけが持つ。
   *
   * 段はデータの列ではなく、既存の列 (用途・名前) からの規則として載っている。
   * UIはこれを読んで問い合わせの `CASE` を組み立てる ([`tierExpression`])。
   */
  'duck:tiers'?: Tiers;
  /** 規約の要約 (商用可か・出典表示・改変・継承)。 */
  'duck:terms'?: Terms;
  /**
   * **いつ時点のデータか。** 配布元が名乗っている形 (`N02-25 (2026-03-06)` など)。
   *
   * ファイルごとに版が違うCollection (PLATEAUは都市ごとに更新年度が揃っていない)
   * には入っていない。**古いものを新しいと思って使う事故を防ぐためのもの**なので、
   * 揃っていないものを代表値で1つに丸めない。
   */
  'duck:vintage'?: string;
  extent: { spatial: { bbox: (number | null)[][] } };
  /**
   * 列がとりうる値。列名 → 値 (件数の多い順)。語彙を持たない列は入っていない。
   *
   * **絞り込みの選択肢はここから作る。** データを走査して作ると、
   * 表示範囲で絞れない (範囲外にしか無い用途を落とすと、その建物が
   * 絞り込みから消える) ため、ファイルの数だけ往復することになる。
   */
  summaries?: Record<string, string[]>;
  item_assets?: { data?: { 'table:columns'?: { name: string; type: string }[] } };
  links: StacLink[];
}

/** 建物の重要度の段の規則 (`duck:tiers`)。パイプラインの `catalog::Tiers` と同じ形。 */
interface Tiers {
  /** どの列の値で分けるか (PLATEAUは `usage`、Overtureは `class`)。 */
  column: string;
  /** 名前のある建物を先頭の段に上げるか。 */
  named_first: boolean;
  /** 上ほど重要。**最後の段は「残り全部」で値を持たない。** */
  tiers: { id: string; title: string; values: string[] }[];
  /**
   * **段で間引くための列** (段の順位、0がいちばん重要)。全ファイルが持つときだけ付く。
   * あれば引いた表示で `lod <= 段` の行グループだけを読める。
   */
  lod_column?: string;
}

/**
 * 重要度の段を求めるSQLの式。値は段のID (`'public'` など)。
 *
 * 規則をそのまま `CASE` にする: 名前があれば先頭の段 (`named_first` のとき)、
 * そうでなければ上の段から順に値で当て、どれにも当たらなければ最後の段。
 * **段をデータの列に書き込まない**ので、規則を変えても配信物を作り直さずに済む。
 */
function tierExpression(tiers: Tiers): string {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const last = tiers.tiers.at(-1)!;
  const whens: string[] = [];
  if (tiers.named_first && tiers.tiers.length > 0) {
    whens.push(`WHEN name IS NOT NULL THEN ${quote(tiers.tiers[0].id)}`);
  }
  for (const tier of tiers.tiers.slice(0, -1)) {
    if (tier.values.length === 0) continue;
    whens.push(
      `WHEN ${tiers.column} IN (${tier.values.map(quote).join(', ')}) THEN ${quote(tier.id)}`,
    );
  }
  return `CASE ${whens.join(' ')} ELSE ${quote(last.id)} END`;
}

/** STAC Item。1つのGeoParquetに対応する。 */
interface StacItem {
  id: string;
  bbox?: number[];
  /** `via` (このファイルの配布元) など。PLATEAUは都市ごとのzipを指す。 */
  links?: StacLink[];
  properties: {
    'table:row_count'?: number;
    /** 原典にあるLOD ("1,2,3")。**配信しているものより細かいものが原典にある**ときだけ付く。 */
    'duck:source_lod'?: string;
  };
  assets: { data: { href: string } };
}

/**
 * Itemと、それを載せていた文書の位置。
 *
 * **アセットのhrefはその文書からの相対**なので、解決するには文書の位置が要る。
 */
interface LocatedItem {
  feature: StacItem;
  /** ItemCollectionの、配信の起点からのパス。 */
  base: string;
}

/**
 * 出所のまとまり (サブカタログ)。**レイヤー一覧の見出しになる。**
 *
 * 「PLATEAU」「Overture Maps」をここで決め打ちしない。カタログが名乗っている
 * ものをそのまま出すので、出所が増えればパイプライン側で1行足すだけで済む。
 */
interface CatalogGroup {
  id: string;
  title: string;
  description: string;
  /** この文書の、配信の起点からのパス。JSONそのものを見せるのに使う。 */
  path: string;
}

/** Collectionを扱いやすい形にしたもの。Itemは呼ばれるまで読まない。 */
interface Collection {
  id: string;
  kind: DatasetKind;
  title: string;
  description: string;
  /** SPDX識別子か "other"。 */
  license: string;
  /** 組織名 (STACの `providers[].name`)。 */
  provider: string | undefined;
  /**
   * どのサブカタログの下にあるか。**ルート直下に置かれたCollectionは undefined**
   * (サブカタログを挟む前の平らなカタログもそう読める)。
   */
  group: CatalogGroup | undefined;
  /** Collection文書の、配信の起点からのパス。 */
  path: string;
  /** ItemCollection文書の、配信の起点からのパス。無ければ undefined。 */
  itemsPath: string | undefined;
  attribution: string;
  attributionUrl: string;
  /**
   * 配布元。**ここにあるのは変換した複製で、原典は配布元にある。**
   * 実物が欲しくなった人が辿れるようにする (STACの `rel: "via"`)。
   */
  via: string | undefined;
  /** 収録範囲 (Item全部の和)。Itemを読まずに分かる。 */
  bbox: Bbox | null;
  summaries: Record<string, string[]>;
  /** 列名。何で絞れるかをこれで決める。 */
  columns: Set<string>;
  /** 地域メッシュの細かさ (メッシュコードの桁数)。メッシュ以外は undefined。 */
  meshDigits: number | undefined;
  /** 粗い段の許容誤差 (メートル)。段が無ければ undefined。 */
  coarseLodToleranceM: number | undefined;
  /** どのCollectionの整備範囲か。整備範囲のメッシュ以外は undefined。 */
  covers: string | undefined;
  /** 重要度の段の規則。建物以外は undefined。 */
  tiers: Tiers | undefined;
  /** 規約の要約。古いカタログには無い。 */
  terms: Terms | undefined;
  /** いつ時点のデータか。**ファイルごとに版が違うものには入っていない。** */
  vintage: string | undefined;
  /** Itemを読む。**Collectionごとに1回だけ**通信する。 */
  items: () => Promise<LocatedItem[]>;
}

/**
 * GeoParquetの置き場所。
 *
 * 開発時は同一オリジンの /data/ (vite.config.ts が data/output/ を配信する)。
 * 公開時はオブジェクトストレージのURLを VITE_DATA_BASE_URL で渡す。
 * 別オリジンになるので、置き場所側のCORSで
 * `Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges`
 * を返すこと。これが無いとDuckDB-WASMがファイルサイズを取得できず、
 * 部分取得に失敗して黙って全件ダウンロードに落ちる。
 */
const DATA_BASE_URL = (
  import.meta.env.VITE_DATA_BASE_URL ?? `${import.meta.env.BASE_URL}data`
).replace(/\/$/, '');

function dataUrl(file: string): string {
  return new URL(`${DATA_BASE_URL}/${file}`, window.location.href).toString();
}

/** 配信の起点にある唯一のファイル。ここから全部を辿る。 */
const CATALOG_PATH = 'catalog.json';

/**
 * STACの相対リンクを、配信の起点からのパスに直す。
 *
 * **STACの相対リンクは「その文書からの相対」。** `overture/roads.json` の中の
 * `roads-items.json` は `overture/roads-items.json` を指す。
 * ここが配信の起点からの相対だと思って読むと、階層を作った瞬間に壊れる。
 *
 * 起点からのパスに正規化して返すのは、**この文字列がDuckDBの登録名を兼ねる**ため
 * (`registerFileURL`)。同じファイルを別の文字列で二重登録しないよう、
 * どの文書から辿っても同じ形にする。
 *
 * `base` は参照元の文書の、起点からのパス (`catalog.json` や `overture/roads.json`)。
 */
function resolveHref(href: string, base: string): string {
  // 絶対URLはそのまま通す (配布元へのリンクなど、起点の外を指すものがある)。
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  // URLの解決規則に任せる。起点は実在しなくてよいので固定の土台を置く。
  const root = 'https://duck.invalid/';
  return new URL(href, new URL(base, root)).href.slice(root.length);
}

/** E2Eテストのために公開するもの。アプリ本体はこれを参照しない。 */
interface TestHooks {
  __map?: MapLibreMap;
  __dataUrl?: (file: string) => string;
}

// データの実際のURLは、テストがデータの有無を確かめるのに要る。
// 初期化に失敗した場合でも参照できるよう、ここで公開しておく
// (データが無くて初期化できないこと自体が、判定したい状態のひとつなので)。
(window as unknown as TestHooks).__dataUrl = dataUrl;

/**
 * DuckDB-WASM本体の置き場所。
 *
 * バンドルには含めず、アプリと同じオリジンの /duckdb/ から配る。
 * duckdb-eh.wasm が35MB、duckdb-mvp.wasm が40MBあり、バンドラに通すと
 * ホスティングのファイルサイズ制限に当たるため (Cloudflare Pagesは25MiBまで)。
 * 開発時は vite.config.ts が node_modules から配信し、ビルド時は同じ場所から
 * dist/duckdb/ にコピーされる。別の場所に置きたい場合は
 * VITE_DUCKDB_BASE_URL で上書きできる。
 */
const DUCKDB_BASE_URL = (
  import.meta.env.VITE_DUCKDB_BASE_URL ?? `${import.meta.env.BASE_URL}duckdb`
).replace(/\/$/, '');

function duckdbUrl(file: string): string {
  return new URL(`${DUCKDB_BASE_URL}/${file}`, window.location.href).toString();
}

/**
 * spatialなど拡張の置き場所。DuckDB本体と同じく自前配信にしてある
 * (`web/duckdb-extensions.ts` が実行時にDuckDB本体のバージョンへ合わせて取得し、
 * `web/vite.config.ts` が `duckdb/extensions/` として配る)。
 *
 * 本家 (extensions.duckdb.org) にあるのと同じ署名済みファイルをそのまま
 * 置いているだけなので、`allowUnsignedExtensions` は要らない。
 */
const DUCKDB_EXTENSIONS_URL = duckdbUrl('extensions');

async function fetchStac<T>(path: string): Promise<T> {
  const response = await fetch(dataUrl(path));
  if (!response.ok) {
    throw new Error(
      `${path} が読めません (${response.status})。` +
        '`cargo run --bin build_catalog -- ../data/output` を実行してください。',
    );
  }
  return (await response.json()) as T;
}

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

/**
 * STACの文書をページの中で見せる。**リンクを押すと次の文書へ進める。**
 *
 * 以前は生のJSONを別タブで開いていた。それだと地図から離れるうえ、
 * そこから先 (親・子・Item) へは自分でURLを組み立てないと辿れない。
 * ここでは `links` をボタンにしてあるので、**画面の中でカタログを歩ける**。
 *
 * リンクの解決はアプリ本体と同じ規則 ([`resolveHref`] — その文書からの相対)。
 * 実データ (parquet) は開かない。数十MBあり、開いても読めないため。
 */
function createStacViewer(dialog: HTMLDialogElement): (path: string) => void {
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

/**
 * Catalogから全Collectionを読む。**カタログに書かれた順に返す** (一覧の並びになる)。
 *
 * Collectionは**ファイルが増えても大きくならない** (収録範囲は全体の1件だけ、
 * 列構成と語彙は出所ごとに1つ) ので、起動時に全部読んでよい。
 * ファイル1つずつの情報を持つItemは、使う段になってから読む。
 */
async function fetchCollections(): Promise<Collection[]> {
  const catalog = await fetchStac<StacCatalog>(CATALOG_PATH);
  return walkCatalog(catalog, CATALOG_PATH, undefined);
}

/**
 * Catalogの子を辿る。**子がCatalogなら降り、Collectionならそこで止まる。**
 *
 * STACはどちらも子にできる。種類はリンクではなく**文書の `type`** で見分ける
 * (リンクの `type` はメディアタイプで、どちらも `application/json`)。
 *
 * 兄弟は並べて取る。サブカタログを挟んだぶん往復は1段増えるが、
 * 1段の中は並列なので、起動の待ちは1往復ぶんしか伸びない。
 */
async function walkCatalog(
  catalog: StacCatalog,
  path: string,
  group: CatalogGroup | undefined,
): Promise<Collection[]> {
  const children = catalog.links.filter((link) => link.rel === 'child');
  const nested = await Promise.all(
    children.map(async (link) => {
      // **文書の位置を持ち回る。** 中のリンクはその文書からの相対なので、
      // どこにある文書だったかを知らないと解決できない。
      const childPath = resolveHref(link.href, path);
      const document = await fetchStac<StacCatalog | StacCollection>(childPath);
      if (document.type === 'Collection') return [toCollection(document, childPath, group)];
      return walkCatalog(document, childPath, {
        id: document.id,
        title: document.title ?? document.id,
        description: document.description ?? '',
        path: childPath,
      });
    }),
  );
  return nested.flat();
}

function toCollection(
  document: StacCollection,
  path: string,
  group: CatalogGroup | undefined,
): Collection {
  // 空間範囲は「先頭が全体」。ジオメトリを持たないデータセットは null が並ぶ。
  const [extent] = document.extent.spatial.bbox;
  const bbox =
    extent?.length === 4 && extent.every((value) => typeof value === 'number')
      ? (extent as Bbox)
      : null;

  const itemsHref = document.links.find((link) => link.rel === 'items')?.href;
  const itemsPath = itemsHref ? resolveHref(itemsHref, path) : undefined;
  let items: Promise<LocatedItem[]> | undefined;

  return {
    id: document.id,
    kind: document['duck:kind'],
    title: document.title ?? document.id,
    description: document.description ?? '',
    license: document.license ?? 'other',
    provider: document.providers?.[0]?.name,
    group,
    path,
    itemsPath,
    attribution: document['duck:attribution'],
    attributionUrl: document['duck:attribution_url'],
    via: document.links.find((link) => link.rel === 'via')?.href,
    meshDigits: document['duck:mesh_digits'],
    coarseLodToleranceM: document['duck:coarse_lod_tolerance_m'],
    covers: document['duck:covers'],
    tiers: document['duck:tiers'],
    terms: document['duck:terms'],
    vintage: document['duck:vintage'],
    bbox,
    summaries: document.summaries ?? {},
    columns: new Set(
      (document.item_assets?.data?.['table:columns'] ?? []).map((column) => column.name),
    ),
    items: () =>
      (items ??= itemsPath
        ? fetchStac<{ features: StacItem[] }>(itemsPath).then((collection) =>
            // Itemのアセットは**ItemCollectionの文書からの相対**。
            collection.features.map((feature) => ({ feature, base: itemsPath })),
          )
        : Promise.resolve([])),
  };
}

/** Itemのアセットを、配信の起点からのパスに直す。 */
function itemFile(item: LocatedItem): string {
  return resolveHref(item.feature.assets.data.href, item.base);
}

/** Itemを配信パスと収録範囲の組にする。 */
function itemFiles(items: LocatedItem[]): ItemFile[] {
  return items.map(({ feature, base }) => ({
    file: resolveHref(feature.assets.data.href, base),
    bbox: feature.bbox?.length === 4 ? (feature.bbox as Bbox) : null,
    sourceLod: parseSourceLod(feature.properties['duck:source_lod']),
  }));
}

/** ファイル1つ分。収録範囲と、原典がどこまで細かいか。 */
interface ItemFile {
  file: string;
  bbox: Bbox | null;
  /** 原典にあるLOD (昇順)。無ければ空。 */
  sourceLod: number[];
}

/**
 * "1,2,3" を [1,2,3] にする。
 *
 * **読めない値は捨てる。** 配信側の形が変わっても、LODの表示が消えるだけで
 * 建物そのものは出る。
 */
function parseSourceLod(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((lod) => Number.isFinite(lod))
    .sort((a, b) => a - b);
}

/**
 * 検索結果は2種類ある。
 * - admin: 行政区域。面を持つので選択するとポリゴンをハイライトする。
 * - oaza:  大字・町丁目(位置参照情報)。代表点しか無いのでその地点へ飛ぶ。
 */
type SearchResult =
  | { kind: 'admin'; label: string; adminId: string }
  | { kind: 'oaza'; label: string; lon: number; lat: number }
  // 駅。**人が実際に検索する語**なので、地名と並べて出す。
  | { kind: 'station'; label: string; detail: string; lon: number; lat: number }
  // 路線。点ではなく**範囲**なので、飛び先は fitBounds になる。
  // 線そのものは選んだときに読んでハイライトする (`lineName` / `operator` で引く)。
  | { kind: 'line'; label: string; detail: string; bbox: Bbox; lineName: string; operator: string }
  | { kind: 'route'; label: string; detail: string; bbox: Bbox; routeName: string };

/** 範囲 [xmin, ymin, xmax, ymax] (WGS84)。 */
type Bbox = [number, number, number, number];

/** 地図の表示範囲。 */
interface ViewBounds {
  west: number;
  south: number;
  east: number;
  north: number;
  /** 画面中心。傾けると bounds の中心とはずれるので、地図から直接もらう。 */
  centerLon: number;
  centerLat: number;
}

/**
 * 初回に一度だけ実行し、以降は同じ結果を返す。
 * 並行して呼ばれても実行は1回で、両方とも完了を待てる。
 */
function once(run: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | undefined;
  return () => (started ??= run());
}

/** 範囲を、地図に描ける矩形のポリゴンにする。 */
/**
 * この桁のメッシュ1つに入る1kmセルの数。
 *
 * JIS X 0410 は 4桁 (80km) → 6桁 (10km) → 8桁 (1km) で、
 * 4→6 は緯度経度それぞれ8分割 (8×8)、6→8 は10分割 (10×10)。
 */
function meshCellCapacity(digits: number): number {
  if (digits >= 8) return 1;
  if (digits === 6) return 100;
  if (digits === 4) return 64 * 100;
  throw new Error(`想定していないメッシュの桁数: ${digits}`);
}

/**
 * 整備範囲のメッシュをGeoJSONにする。
 *
 * **矩形はメッシュコードから計算する** (人口メッシュと同じ)。配られた
 * ジオメトリを使わないのは、コードを前から切って束ねたあとの大きさで
 * 描きたいため。
 *
 * **濃淡は充足率で付ける。** 建物の数で濃くすると人口密集部が濃くなるだけで、
 * 「整備されているか」とは別のものを見せてしまう。代わりに
 * **束ねたセルのうち何割にデータがあるか**で塗る。1つでも子があれば塗る形だと、
 * 日本全体が見えるまで引いたときにほぼ全国が埋まって見えてしまうため。
 *
 * **沿岸のセルは決して100%にならない** — 海の子セルは元々データを持てない。
 * つまりこれは「整備率」ではなく**このセルの面積のうちデータがある割合**。
 */
function coverageFeatureCollection(cells: CoverageCell[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cells.map(({ code, buildings, filled, cities }) => {
      const [west, south, east, north] = meshBounds(code);
      const total = meshCellCapacity(code.length);
      return {
        type: 'Feature',
        properties: {
          code,
          buildings,
          filled,
          total,
          ratio: filled / total,
          cities: cities.join('、'),
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
      };
    }),
  };
}

/** 複数の範囲を包む範囲。データセットが分割されていても1つに畳める。 */
function unionBbox(boxes: Bbox[]): Bbox | null {
  return boxes.reduce<Bbox | null>(
    (union, box) =>
      union === null
        ? box
        : [
            Math.min(union[0], box[0]),
            Math.min(union[1], box[1]),
            Math.max(union[2], box[2]),
            Math.max(union[3], box[3]),
          ],
    null,
  );
}

/**
 * 建物データの出所。出所ごとに別のビューを持つ。
 *
 * OvertureとPLATEAUは列構成が違うので、1つのビューに束ねられない
 * (`read_parquet([a, b])` はスキーマが揃っていることを前提にする)。
 *
 * **何で絞れるかは列の有無から決める。** 出所ごとに決め打ちすると、
 * 「高さがあるのに立体では見えるのに絞れない」といった食い違いが起きる。
 * カタログはGeoParquetの実際のメタデータから作られているので、そちらに従う。
 */
interface BuildingSource {
  /** Collectionの識別子。**一覧の行IDも兼ねる。** 名前はカタログ (サブカタログの題名) が持つ。 */
  id: string;
  /**
   * このデータセットを構成するファイルと、それぞれの収録範囲。
   *
   * **`ensure()` を呼ぶまで空。** Itemを読まないと分からないため。
   * 収録範囲の枠 (`bbox`) と絞り込みの選択肢はCollectionだけで作れるので、
   * 寄って実際に引くまでItemを取りに行かずに済む。
   */
  files: ItemFile[];
  /** 収録範囲 (ファイル全部の和)。Collectionが持っているので最初から分かる。 */
  bbox: Bbox | null;
  /** 高さの列があるか。あれば高さで絞れるし、立体の高さにも使える。 */
  hasHeight: boolean;
  /** 用途・種別を表す列。無ければ null。出所によって列名が違う。 */
  categoryColumn: string | null;
  /** 用途の選択肢 (件数の多い順)。カタログの語彙をそのまま使う。 */
  usages: string[];
  /** 引く前に呼ぶ (Itemの読み込み・ファイル登録・空間関数の読み込み)。 */
  ensure: () => Promise<void>;
  /**
   * **引いた表示で出す整備範囲。** 無ければ引いた表示では何も出さない。
   *
   * 建物そのものを引いた表示で出す道は無い — 簡略化はズーム12でフットプリントが
   * 1px未満になって効かず、高さで選ぶのは基準に意味を持たせられなかった
   * (2Dなら面積、3Dなら高さで見たいものが違い、「引きで見たい施設」は
   * そのどちらとも別の概念)。**代わりに「どこまで整備されているか」を出す。**
   */
  coverage: BuildingCoverage | undefined;
  /** 重要度の段の規則 (カタログの `duck:tiers`)。無ければ段で絞れない。用途を問わない部品。 */
  tiers: Tiers | undefined;
}

/**
 * 整備範囲のメッシュ。[`BuildingSource.coverage`] が持つ。
 *
 * **1kmで配られている。** 粗くするのはコードを前から切るだけで済む
 * (人口メッシュと同じ仕組み)。
 */
interface BuildingCoverage {
  files: ItemFile[];
  /** 配られている細かさ (メッシュコードの桁数)。これより細かくはできない。 */
  meshDigits: number;
  ensure: () => Promise<void>;
}

/**
 * 人口メッシュの出所。**SORAの地上リスクを見るためのもの。**
 *
 * 建物と違って「引いた状態で見たい」データなので、ズームに応じて
 * メッシュを粗くして出す ([`meshDigits`])。
 */
/**
 * 鉄道 (国土数値情報 N02)。路線と駅で列構成が違うので別のCollectionになっている。
 *
 * **駅のジオメトリも線**。原典がホームの延長を線で持っているので、点ではない。
 */
interface RailwaySource {
  id: string;
  /** 路線か駅か。描き分けと、駅名を引くかどうかに使う。 */
  kind: 'railway' | 'railway_station';
  bbox: Bbox | null;
  files: ItemFile[];
  /** 粗い段の許容誤差 (メートル)。段が無ければ undefined。 */
  coarseLodToleranceM: number | undefined;
  ensure: () => Promise<void>;
}

/**
 * 道路 (Overture)。**国のデータには路線名が無い**ので、名前で引けるのはこれだけ
 * (詳細は docs/data-sources.md)。`class` ごとにファイルが分かれている。
 */
interface RoadSource {
  id: string;
  bbox: Bbox | null;
  files: ItemFile[];
  /** 粗い段の許容誤差 (メートル)。段が無ければ undefined。 */
  coarseLodToleranceM: number | undefined;
  ensure: () => Promise<void>;
}

/**
 * 名前と種別だけを持つ線 (送電線・川)。**道路と違って等級の絞り込みを持たない。**
 * 粗い段の切り替え・一覧の行・ホバーは道路と同じ仕組みを使う。
 */
interface LineSource {
  id: string;
  kind: LineKind;
  title: string;
  bbox: Bbox | null;
  files: ItemFile[];
  /** 粗い段の許容誤差 (メートル)。段が無ければ undefined。 */
  coarseLodToleranceM: number | undefined;
  ensure: () => Promise<void>;
}

type LineKind = 'power_line' | 'waterway';
const LINE_KINDS: readonly LineKind[] = ['power_line', 'waterway'];

/** 線の見せ方。川は水色の実線、送電線は紫の破線 (道路・鉄道と見分けるため)。 */
const LINE_STYLES: Record<LineKind, { color: string; width: number; dash: number[] | null }> = {
  power_line: { color: '#7b4fa0', width: 1.6, dash: [2, 1.5] },
  waterway: { color: '#3a8fd6', width: 1.8, dash: null },
};

/** 線の種別 (`class`) の呼び名。Overture の値はOSM由来の英語なので言い直す。 */
const LINE_CLASS_LABELS: Record<string, string> = {
  power_line: '送電線',
  cable: '地中・海底線',
  river: '川',
  canal: '運河',
};

interface LineFeature {
  geojson: GeoJSON.Geometry;
  name: string | null;
  lineClass: string;
}

/**
 * 表示範囲の線を引く。道路 ([`fetchRoadsInView`]) と同じく、中心に近い順に上限まで。
 */
async function fetchLinesInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: LineSource,
  bounds: ViewBounds,
  limit: number,
  lod: number | undefined,
): Promise<LineFeature[]> {
  const files = filesInView(source, bounds);
  if (files.length === 0) return [];
  const list = files.map((file) => `'${file}'`).join(', ');
  const lonScale = Math.cos((bounds.centerLat * Math.PI) / 180);
  const result = await conn.query(`
    SELECT ST_AsGeoJSON(geometry) AS geojson, name, class
    FROM read_parquet([${list}])
    WHERE ${lodFilter(lod)}
      bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}
      AND bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}
    ORDER BY
      pow(((bbox.xmin + bbox.xmax) / 2 - ${bounds.centerLon}) * ${lonScale}, 2)
      + pow((bbox.ymin + bbox.ymax) / 2 - ${bounds.centerLat}, 2)
    LIMIT ${limit};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as { geojson: string; name: string | null; class: string };
    return { geojson: JSON.parse(r.geojson) as GeoJSON.Geometry, name: r.name, lineClass: r.class };
  });
}

/**
 * 道路の等級ごとの色と呼び名。**語彙はカタログから来る**ので、ここには
 * 見せ方だけを持つ (鉄道の事業者種別と同じ)。
 *
 * Overtureの `class` はOSM由来で、日本の制度とは1対1で対応しない。
 * 「おおよそ」と分かる書き方にしてある。
 */
const ROAD_STYLES: Record<string, { label: string; color: string; width: number }> = {
  motorway: { label: '高速道路', color: '#2f7d32', width: 3 },
  trunk: { label: '国道', color: '#c2410c', width: 2.4 },
  primary: { label: '都道府県道', color: '#8a6d3b', width: 1.8 },
};

/** 道路1件分の表示用データ。 */
interface RoadFeature {
  geojson: GeoJSON.Geometry;
  /** Overtureの `names.primary`。無いこともある。 */
  roadName: string | null;
  /** 道路等級。色と太さはこれで決める。 */
  roadClass: string;
  /**
   * 属する路線の名前。**1つの区間が複数の路線に属する**
   * (実測で首都圏の約半分が2本以上、最大10本) のでリストで持つ。
   */
  routeNames: string[];
}

/**
 * 事業者種別ごとの色。**語彙はカタログから来る**ので、ここには色だけを持つ。
 *
 * 種別を選んだのは、5つしかなくて凡例に収まり、かつ
 * 「新幹線か在来線か」「公営か民営か」という運航側が気にする区別に近いため。
 * 鉄道区分 (普通鉄道/軌道/モノレールなど11種) は細かすぎて色では読めない。
 */
const RAILWAY_COLORS: Record<string, string> = {
  JRの新幹線: '#c2185b',
  JR在来線: '#1565c0',
  公営鉄道: '#2e7d32',
  民営鉄道: '#ef6c00',
  第三セクター: '#6a1b9a',
};

/** 語彙に無い種別が来たときの色。カタログが増えても消えないようにする。 */
const RAILWAY_FALLBACK_COLOR = '#616161';

interface MeshSource {
  id: string;
  /** このデータの細かさ (メッシュコードの桁数)。11桁=125m、8桁=1km。 */
  digits: number;
  /** 収録範囲。 */
  bbox: Bbox | null;
  /** このデータセットを構成するファイル。`ensure()` を呼ぶまで空。 */
  files: ItemFile[];
  ensure: () => Promise<void>;
}

/**
 * 要求する細かさに対して、どの出所を引くか。
 *
 * **要求より細かいものの中で、いちばん粗いものを選ぶ。** 125mのファイルからでも
 * 1kmは作れるが、そのぶん元の行を多く読む (実測でズーム7のとき21.1MB)。
 * 全国を1kmで束ねたファイル (5.5MB) があれば、そちらを読む方がずっと軽い。
 *
 * 逆に、要求より粗いものからは作れない (1kmのファイルで500mは描けない)。
 */
function meshSourceFor(sources: MeshSource[], digits: number): MeshSource | undefined {
  return sources
    .filter((source) => source.digits >= digits)
    .sort((a, b) => a.digits - b.digits)[0];
}

/** 粗い段 (`lod = 0`)。統合して簡略化した行。 */
const COARSE_LOD = 0;
/** 原寸 (`lod = 1`)。元の行がそのまま入っている。 */
const EXACT_LOD = 1;

/**
 * 緯度36°での1pxの大きさ (メートル)。`156543.03 * cos(36°) / 2^z`。
 *
 * 日本のほぼ中央での値。北海道と沖縄で2割ほど違うが、**段を選ぶのは
 * 「誤差が見えるか」の判断**なので、この程度の差は効かない。
 */
function metersPerPixel(zoom: number): number {
  return 126_643 / 2 ** zoom;
}

/**
 * 許容誤差 `toleranceM` で簡略化したものが使えるのは、どのズームまでか。
 *
 * **誤差が2px以内なら使う。** 100mの誤差はズーム10で0.8px、11で1.6px、12で3.2px
 * なので、100mの段はズーム11まで。線の太さが2px前後あるので、2px以内のずれは
 * 線の中に収まって見えない。
 *
 * **ズーム閾値を書かずにここで決める**のが肝。データ側の誤差が変われば
 * 切り替わるズームも自動で追従する。
 */
function coarseLodUntilZoom(toleranceM: number): number {
  let zoom = 0;
  while (zoom < 24 && toleranceM / metersPerPixel(zoom + 1) <= 2) zoom += 1;
  return zoom;
}

/**
 * このズームで読む段。段を持たないCollectionでは undefined (条件を付けない)。
 *
 * **読む側をこの1箇所に閉じてある。** 将来COGPの読み手に替えるとき、
 * 変更点がここだけで済むようにするため。
 */
function lodForZoom(
  source: { coarseLodToleranceM: number | undefined },
  zoom: number,
): number | undefined {
  if (source.coarseLodToleranceM === undefined) return undefined;
  return zoom <= coarseLodUntilZoom(source.coarseLodToleranceM) ? COARSE_LOD : EXACT_LOD;
}

/**
 * 段を絞るWHERE句の断片。段が無いファイルでは**何も付けない**。
 *
 * 付けてしまうと、段を持たないファイル (`lod` 列が無い) を読んだときに
 * 列が見つからずクエリごと失敗する。後ろに条件が続く形で使う。
 */
function lodFilter(lod: number | undefined): string {
  return lod === undefined ? '' : `lod = ${lod} AND`;
}

/**
 * いま粗い段を見ているのかを画面で断る文。
 *
 * **黙って簡略化したものを見せない。** 引いた表示では統合して簡略化した線が
 * 出ているので、そう書いておかないと区間数が急に減ったように見える。
 * どのズームで原寸に切り替わるかも一緒に言う。
 */
function lodNote(
  source: { coarseLodToleranceM: number | undefined },
  lod: number | undefined,
): string {
  if (source.coarseLodToleranceM === undefined || lod !== COARSE_LOD) return '';
  const until = coarseLodUntilZoom(source.coarseLodToleranceM);
  return ` · 簡略表示 (ズーム${until + 1}から原寸)`;
}

/**
 * ズームに対して、メッシュコードを何桁で束ねるか。
 *
 * **メッシュコードは階層になっている**ので、前から切るだけで粗くできる
 * (11桁=125m、10桁=250m、9桁=500m、8桁=1km、6桁=10km、4桁=80km)。
 *
 * 引くほど粗くするのは、描く数を抑えるため。125mメッシュは全国で282万件ある。
 * どのファイルから作るかは [`meshSourceFor`] が別に決める。
 */
/** メッシュコードの桁数から、人間に見せる大きさの呼び名。 */
const MESH_SIZE_LABELS: Record<number, string> = {
  4: '80km',
  6: '10km',
  8: '1km',
  9: '500m',
  10: '250m',
  11: '125m',
};

function meshDigits(zoom: number): number {
  if (zoom >= 15) return 11;
  if (zoom >= 14) return 10;
  if (zoom >= 12) return 9;
  if (zoom >= 9) return 8;
  if (zoom >= 6) return 6;
  return 4;
}

/**
 * 表示量。**上限とズームの閾値だけを動かす** — 何をどう読むかは変えない。
 *
 * どこまで描けるかは端末で違うので、利用者が決められるようにする。
 * 数字を直接触らせず3段にしているのは、上限を3000にするか4000にするかを
 * 決める材料が利用者の側に無いため。**上限に当たったことは各レイヤーが
 * 「表示上限」と断る**ので、そこを見て段を上げればよい。
 */
type DetailLevel = 'low' | 'medium' | 'high';

interface DetailSettings {
  /** 建物が原寸に切り替わるズーム。これより引くと整備範囲を出す。 */
  buildingsMinZoom: number;
  buildingsLimit: number;
  railwayLimit: number;
  roadLimit: number;
  /**
   * 道路の等級ごとの最小ズームから**引く**値。大きいほど引いた表示で
   * 多くの等級が出る。高速は元が0なので動かない。
   */
  roadClassZoomShift: number;
}

/**
 * **標準は従来の値と完全に一致させる。** 転送量や件数を測っている
 * E2Eの基準がこれで決まっているため、既定を動かすとそちらも動く。
 *
 * 多めは建物を1ズーム早く、道路の等級を2ズーム早く、鉄道と道路の上限を2倍。
 * 控えめはその逆。**建物のズームを1より大きく動かさない** —
 * 14で原寸の1画面は15の4倍の面積で、ズーム13の東京駅は21万棟 (実測) ある。
 *
 * **多めの建物の上限は4万。** ズーム14の東京駅は1280×720の画面で3.7万棟あり、
 * 6,000では中心の2割弱しか出なかった。上限は**転送量を減らさない** —
 * 中心から近い順に並べてから切るので、並べるために画面内を全部読む
 * (実測: 上限6,000でも6万でも37.5MB)。6万で37,178棟を描いても5.6秒で、
 * 6,000件のとき (7.0秒) と変わらなかった。1920×1080だと11.9万棟あるが、
 * そこまで描くのは測っていないので上げない。
 */
const DETAIL_LEVELS: Record<DetailLevel, DetailSettings & { label: string }> = {
  low: {
    label: '控えめ',
    buildingsMinZoom: 16,
    buildingsLimit: 1500,
    railwayLimit: 2000,
    roadLimit: 3000,
    roadClassZoomShift: -2,
  },
  medium: {
    label: '標準',
    buildingsMinZoom: 15,
    buildingsLimit: 3000,
    railwayLimit: 4000,
    roadLimit: 6000,
    roadClassZoomShift: 0,
  },
  high: {
    label: '多め',
    buildingsMinZoom: 14,
    buildingsLimit: 40000,
    railwayLimit: 8000,
    roadLimit: 12000,
    roadClassZoomShift: 2,
  },
};

const DETAIL_STORAGE_KEY = 'duck-geocoder:detail';

/** 保存されている段。無い・読めない・知らない値なら標準。 */
function loadDetailLevel(): DetailLevel {
  try {
    const saved = localStorage.getItem(DETAIL_STORAGE_KEY);
    if (saved && saved in DETAIL_LEVELS) return saved as DetailLevel;
  } catch {
    // プライベートブラウズなどで localStorage が使えないことがある。
    // 覚えられないだけで表示はできるので、黙って標準にする。
  }
  return 'medium';
}

function saveDetailLevel(level: DetailLevel): void {
  try {
    localStorage.setItem(DETAIL_STORAGE_KEY, level);
  } catch {
    // 同上。覚えられなくても今の表示には効いている。
  }
}

/** 機体の区分。SORA 2.5 の iGRC 表の列。 */
const AIRCRAFT_CLASSES = [
  { label: '1m / 25m/s', dimension: '1m' },
  { label: '3m / 35m/s', dimension: '3m' },
  { label: '8m / 75m/s', dimension: '8m' },
  { label: '20m / 120m/s', dimension: '20m' },
  { label: '40m / 200m/s', dimension: '40m' },
];

/**
 * SORA 2.5 の iGRC 表 (JARUS JAR_doc_25 Table 2) の、人口密度の行。
 *
 * **色の区切りをこの表に合わせる。** 連続的なグラデーションだと「濃い/薄い」しか
 * 読めないが、判断の区切りで段を切れば、地図がそのまま iGRC を答える。
 *
 * `igrc` は [`AIRCRAFT_CLASSES`] と同じ並び。`null` は**SORAの適用範囲外**。
 *
 * 表の写しなので、**運用に使う前に原文を確認すること。**
 * <http://jarus-rpas.org/wp-content/uploads/2024/06/SORA-v2.5-Main-Body-Release-JAR_doc_25.pdf>
 */
const IGRC_BANDS: {
  /** この帯の上限 (人/km²)。未満ならこの帯。 */
  limit: number;
  label: string;
  color: string;
  igrc: (number | null)[];
}[] = [
  { limit: 5, label: '5 未満', color: '#ffffb2', igrc: [2, 3, 4, 5, 6] },
  { limit: 50, label: '5 〜 50', color: '#fed976', igrc: [3, 4, 5, 6, 7] },
  { limit: 500, label: '50 〜 500', color: '#feb24c', igrc: [4, 5, 6, 7, 8] },
  { limit: 5000, label: '500 〜 5,000', color: '#fd8d3c', igrc: [5, 6, 7, 8, 9] },
  { limit: 50000, label: '5,000 〜 50,000', color: '#f03b20', igrc: [6, 7, 8, 9, 10] },
  {
    limit: Number.POSITIVE_INFINITY,
    label: '50,000 超',
    color: '#bd0026',
    igrc: [7, 8, null, null, null],
  },
];

/** 人口密度 (人/km²) から iGRC の帯を引く。 */
function igrcBand(density: number) {
  return IGRC_BANDS.find((band) => density < band.limit) ?? IGRC_BANDS[IGRC_BANDS.length - 1];
}

/**
 * 表示範囲と重なるファイルだけを選ぶ。**カタログを空間索引として使う。**
 *
 * 建物は都市ごとに1ファイルで、PLATEAUを全国に広げると300を超える。
 * 全部を `read_parquet([...])` に渡すと、**ファイルの数だけフッターを読みに行く**
 * (1ファイル1往復)。表示範囲に重なるのは普通1〜3都市なので、そこだけ渡す。
 *
 * 1つの大きなファイルに束ねる手もあるが、そちらは1都市の更新で全体を書き直すことになる。
 * 都市の境界が空間的な区切りとして働くので、分かれたままでよい。
 *
 * 人口メッシュ (都道府県ごとに1ファイル) も同じ仕組みで絞る。
 */
/**
 * **このパイプラインが読んでいるLOD。**
 *
 * PLATEAUの建物は `bldg:lod0RoofEdge` (屋根の外周線) だけを読み、高さの数値で
 * 押し出している。原典にはもっと細かいものが入っているので、その差を示す。
 */
const SHOWN_LOD = 0;

/**
 * 「表示はLOD0 / 原典はLOD3まで」を作る。無ければ空文字。
 *
 * **表示範囲に入っているファイルから最大を取る。** 都市ごとに違うので、
 * 1つずつ並べると行が伸びる。原典が表示と同じ細かさしか無ければ何も言わない
 * (言っても情報が無い)。
 */
function sourceLodNote(
  source: { files: ItemFile[] },
  bounds: ViewBounds,
): string {
  const lods = source.files
    .filter(({ bbox }) => !bbox || bboxOverlaps(bbox, bounds))
    .flatMap(({ sourceLod }) => sourceLod);
  if (lods.length === 0) return '';
  const max = Math.max(...lods);
  if (max <= SHOWN_LOD) return '';
  return ` · 表示はLOD${SHOWN_LOD} / 原典はLOD${max}まで`;
}

/** 収録範囲が表示範囲と重なるか。 */
function bboxOverlaps([west, south, east, north]: Bbox, bounds: ViewBounds): boolean {
  return (
    west <= bounds.east && east >= bounds.west && south <= bounds.north && north >= bounds.south
  );
}

function filesInView(
  source: { files: ItemFile[] },
  bounds: ViewBounds,
): string[] {
  const overlapping = source.files.filter(
    // 収録範囲が分からないファイルは落とさない (判断材料が無いので読む)。
    ({ bbox }) => !bbox || bboxOverlaps(bbox, bounds),
  );
  return overlapping.map(({ file }) => file);
}

async function initDuckDb(collections: Collection[]): Promise<{
  conn: duckdb.AsyncDuckDBConnection;
  /** 問い合わせの結果を Parquet にして返す (ダウンロード用)。 */
  exportParquet: (select: string, kv: Record<string, string>) => Promise<Uint8Array>;
  /** 配信パスを DuckDB に登録する (Rangeで読めるようにする)。二度目は何もしない。 */
  registerFiles: (files: string[]) => Promise<void>;
  /** 建物データの出所。カタログにあるものだけが並ぶ。 */
  buildingSources: BuildingSource[];
  /** 人口メッシュ。細かさの違うものが並ぶ。空なら地上リスクの表示を出さない。 */
  meshSources: MeshSource[];
  /** 鉄道 (路線と駅)。空なら鉄道の節を出さない。 */
  railwaySources: RailwaySource[];
  /** 事業者種別の語彙。絞り込みの選択肢をここから作る。 */
  railwayInstitutionTypes: string[];
  /** 鉄道がいつ時点のものか。ホバーで出す。 */
  railwayVintage: string | undefined;
  /** 道路 (Overture)。無ければ道路の節を出さない。 */
  roadSource: RoadSource | undefined;
  /** 送電線・川など、名前と種別だけを持つ線。カタログに並んだ順。 */
  lineSources: LineSource[];
  /** 道路等級の語彙。絞り込みの選択肢をここから作る。 */
  roadClasses: string[];
  /** 道路がいつ時点のものか。ホバーで出す。 */
  roadVintage: string | undefined;
  /** 路線の索引と区間のビューを作る。検索のときだけ呼ぶ。 */
  ensureRoutes: (() => Promise<void>) | undefined;
  /** 空間関数を使う前に呼ぶ。 */
  ensureSpatial: () => Promise<void>;
  /** 地名 (isj_oaza) を引く前に呼ぶ。 */
  ensureOaza: () => Promise<void>;
  /** 駅を引く前に呼ぶ。駅が配信されていなければ undefined。 */
  ensureStations: (() => Promise<void>) | undefined;
  /** 路線の線を引く前に呼ぶ。ハイライトのときだけ使う。 */
  ensureSections: (() => Promise<void>) | undefined;
}> {
  const bundle = await duckdb.selectBundle({
    mvp: {
      mainModule: duckdbUrl('duckdb-mvp.wasm'),
      mainWorker: duckdbUrl('duckdb-browser-mvp.worker.js'),
    },
    eh: {
      mainModule: duckdbUrl('duckdb-eh.wasm'),
      mainWorker: duckdbUrl('duckdb-browser-eh.worker.js'),
    },
  });
  // new Worker() は別オリジンのスクリプトを直接は読み込めない。createWorker は
  // 取得してからBlob URLにして起動するので、WASM本体を別のドメインに置ける。
  const worker = await duckdb.createWorker(bundle.mainWorker!);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  // どちらも指定しないと、警告も出さずにファイル全体のダウンロードに落ちる。
  // 詳細: docs/duckdb-wasm-range-requests.md
  //
  // forceFullHTTPReads: これを明示しないとRangeリクエストを一切出さない。
  //   既定値は false のはずだが、指定した場合としない場合で挙動が変わることを実測で確認。
  // reliableHeadRequests: DuckDB-WASMはまず「HEADにRangeを付けて206が返るか」で
  //   部分取得の可否を判断するが、GitHub Pagesなど200を返すサーバーがある。
  //   false にすると「GET bytes=0-0 で206を確認し、通常のHEADでサイズを取る」経路に
  //   なり、配信元の流儀に左右されにくくなる。
  await db.open({
    filesystem: { forceFullHTTPReads: false, reliableHeadRequests: false },
  });

  const conn = await db.connect();
  // 拡張の取得元をここで切り替えておく。read_parquet() は直後の行政区域の
  // ビュー作成 (このすぐ下) で使うため、遅延させると初期化そのものが
  // 本家 (extensions.duckdb.org) に依存したままになる。
  // parquet拡張は明示LOADしていないが、read_parquet()の時点でDuckDBが自動取得する
  // (autoload) ので、取得元さえ切り替えておけば以降は暗黙に自前配信から読まれる。
  await conn.query(`SET custom_extension_repository = '${DUCKDB_EXTENSIONS_URL}';`);

  // 空間関数は逆ジオコーディングと建物表示にしか要らない。拡張の取得に
  // 数秒かかるので、起動時ではなく最初に必要になったときに読む。
  //
  // duckdb-wasmはCRSメタデータ付きのGeoParquetをread_parquetすると
  // "stoi: no conversion" でクラッシュすることがある (PROJ初期化のタイミング問題、
  // duckdb/duckdb-wasm#2199)。spatial拡張を明示ロードする"前"に
  // duckdb_coordinate_systems() を一度呼んでおくと回避できる
  // (逆に LOAD spatial の後に呼ぶとクラッシュを再現してしまうので順序に注意)。
  // https://github.com/duckdb/duckdb-wasm/issues/2199#issuecomment-4205882097
  const ensureSpatial = once(async () => {
    await conn.query(`SELECT * FROM duckdb_coordinate_systems();`);
    await conn.query(`INSTALL spatial; LOAD spatial;`);
  });

  // DuckDBにファイルを教える。通信はしないので、何度呼んでも安い。
  const registered = new Set<string>();
  const register = async (files: string[]) => {
    for (const file of files) {
      if (registered.has(file)) continue;
      registered.add(file);
      await db.registerFileURL(file, dataUrl(file), duckdb.DuckDBDataProtocol.HTTP, false);
    }
  };

  const byKind = (kind: DatasetKind) => collections.filter((c) => c.kind === kind);
  const oazaCollections = byKind('oaza');
  const adminCollections = byKind('admin');
  if (oazaCollections.length === 0 || adminCollections.length === 0) {
    throw new Error('カタログに必要なCollection (oaza / admin) がありません。');
  }

  // 行政区域は全国版と都道府県版が同居しうる。範囲の広いもの (=件数が最多) を採用する。
  // ここだけは起動時にItemが要る (どのファイルを読むか決まらないため)。
  const adminItems = (await Promise.all(adminCollections.map((c) => c.items()))).flat();
  const adminItem = adminItems.sort(
    (a, b) =>
      (b.feature.properties['table:row_count'] ?? 0) -
      (a.feature.properties['table:row_count'] ?? 0),
  )[0];
  if (!adminItem) throw new Error('行政区域のItemがありません。');
  const adminFile = resolveHref(adminItem.feature.assets.data.href, adminItem.base);

  // 検索用の名称を抜き出したものがあれば使う。無い場合は行政区域から作るが、
  // そちらは名称の列がファイル全体に散らばっているため、HTTP越しだと
  // 往復が積み上がって初期化が数十秒かかる。
  const adminNamesCollection = byKind('admin_names')[0];
  const adminNamesItem = adminNamesCollection
    ? (await adminNamesCollection.items())[0]
    : undefined;
  const adminNamesFile = adminNamesItem
    ? resolveHref(adminNamesItem.feature.assets.data.href, adminNamesItem.base)
    : undefined;

  await register(adminNamesFile ? [adminFile, adminNamesFile] : [adminFile]);

  console.info(
    '[catalog] 行政区域:',
    adminItem.feature.id,
    '/ 名称:',
    adminNamesFile ?? '(行政区域から都度作成)',
    '/ 地名:',
    oazaCollections.map((c) => c.id).join(', '),
  );

  // ビューを作るだけでもDuckDBはスキーマ検証のためにフッターを読むので、
  // 1ファイルあたり数回の往復が発生する。起動時に要るのは行政区域と名称だけで、
  // 地名は検索時、建物はズームしたときにしか使わないので、そのときまで作らない。
  await conn.query(`CREATE VIEW admin AS SELECT * FROM read_parquet('${adminFile}');`);

  const ensureOaza = once(async () => {
    // 地名のItemもここで初めて読む。検索するまで要らない。
    const files = (await Promise.all(oazaCollections.map((c) => c.items())))
      .flat()
      .map(itemFile);
    await register(files);
    const list = files.map((file) => `'${file}'`).join(', ');
    await conn.query(`CREATE VIEW isj_oaza AS SELECT * FROM read_parquet([${list}]);`);
    // ビューを作るだけではデータを読まないので、検索に使う列に一度触れておく。
    // ここを省くと、読み込みの待ち時間が最初の検索にそのまま乗る。
    await conn.query(`
      SELECT count(pref_name || city_name || oaza_name) FROM isj_oaza;
      SELECT count(pref_name || county_name || city_name || ward_name) FROM admin_names;
    `);
  });

  /**
   * 駅を検索に載せる。**無ければ検索の候補が増えないだけ。**
   *
   * 地名と同じく、検索するまで読まない。読むのは `station_name` (71KB) と
   * `line_name` (7KB)、位置に使う bbox の4列 (299KB) で、**初回だけ**。
   * 行政区域の名称で起きた「row groupに散らばって往復42回」という問題は、
   * 駅のファイルが **1 row group** なので起きない。
   */
  const stationCollection = byKind('railway_station')[0];
  const ensureStations = stationCollection
    ? once(async () => {
        const files = (await stationCollection.items()).map(itemFile);
        await register(files);
        const list = files.map((file) => `'${file}'`).join(', ');
        await conn.query(`CREATE VIEW station AS SELECT * FROM read_parquet([${list}]);`);
        await conn.query(`SELECT count(station_name || line_name) FROM station;`);
      })
    : undefined;

  /**
   * 路線の線そのもの。**選んだ路線をハイライトするときだけ読む。**
   *
   * 検索と一覧は駅だけで足りる (駅は0.8MB、路線は5.2MBでジオメトリが4.6MB)。
   * 路線を選んだときに初めて、**その路線の範囲で絞って**読む。
   */
  const sectionCollection = byKind('railway')[0];
  const ensureSections = sectionCollection
    ? once(async () => {
        const files = (await sectionCollection.items()).map(itemFile);
        await register(files);
        await ensureSpatial();
        const list = files.map((file) => `'${file}'`).join(', ');
        await conn.query(`CREATE VIEW section AS SELECT * FROM read_parquet([${list}]);`);
      })
    : undefined;

  // 建物は任意。無ければ建物レイヤーを出さないだけで、他の機能は動く。
  // **並びはカタログの順。** 先頭が既定で出て、塗りも青になる。どれを先に
  // 置くかはパイプライン (`SUB_CATALOGS`) が決める — 属性が揃っているPLATEAUが先。
  //
  // **ビューは作らない。** 出所ごとに1つのビューへ束ねると、その時点で
  // ファイルの数だけフッターを読みに行くことになる (1ファイル1往復)。
  // 建物は都市ごとに1ファイルで、PLATEAUを全国に広げると300を超えるので、
  // 引くときに表示範囲と重なるものだけを渡す (`filesInView`)。
  const buildingCollections = collections.filter(
    (c) => c.kind === 'plateau_buildings' || c.kind === 'buildings',
  );
  const buildingSources: BuildingSource[] = buildingCollections.map((collection) => {
    // **整備範囲を結び付ける。** `duck:covers` がこのCollectionを指しているものを
    // 探す。IDの綴りで判断しない (出所が増えたときに書き足す場所が分かれる)。
    const coverageCollection = byKind('building_coverage').find(
      (c) => c.covers === collection.id,
    );
    const coverage: BuildingCoverage | undefined =
      coverageCollection && coverageCollection.meshDigits !== undefined
        ? {
            files: [],
            meshDigits: coverageCollection.meshDigits,
            ensure: once(async () => {
              const items = await coverageCollection.items();
              coverage!.files = itemFiles(items);
              await register(coverage!.files.map(({ file }) => file));
              await ensureSpatial();
            }),
          }
        : undefined;

    // 何で絞れるかは列の有無から決める。高さは列があれば絞れる。
    // 用途で絞れる列は**カタログが語彙を持っている列**。列名 (PLATEAUは usage、
    // Overtureは class) をここに書かないのは、出所が増えたときに書き足す場所が
    // 分かれてしまうため。語彙を出すかどうかはパイプライン側が一箇所で決める。
    const [categoryColumn, usages] = Object.entries(collection.summaries)[0] ?? [null, []];
    const source: BuildingSource = {
      id: collection.id,
      // Itemを読むまで空。寄って実際に引くまで通信しない。
      files: [],
      hasHeight: collection.columns.has('height'),
      categoryColumn,
      usages,
      bbox: collection.bbox,
      coverage,
      tiers: collection.tiers,
      ensure: once(async () => {
        const items = await collection.items();
        source.files = itemFiles(items);
        await register(source.files.map(({ file }) => file));
        await ensureSpatial();
      }),
    };
    return source;
  });

  // 人口メッシュ。建物と同じく、寄るまでItemを読まない。
  // **細かさの違うCollectionが並ぶ** (125mは都道府県ごと、1kmは全国で1つ) ので、
  // どれを引くかはズームに応じて `meshSourceFor` が決める。
  const meshSources: MeshSource[] = byKind('population_mesh').flatMap((collection) => {
    const digits = collection.meshDigits;
    if (digits === undefined) {
      // 細かさが分からないメッシュは使いようがない (どのズームで引くか決まらない)。
      console.warn('[catalog] duck:mesh_digits がありません:', collection.id);
      return [];
    }
    const source: MeshSource = {
      id: collection.id,
      digits,
      bbox: collection.bbox,
      files: [],
      ensure: once(async () => {
        const items = await collection.items();
        source.files = itemFiles(items);
        await register(source.files.map(({ file }) => file));
        await ensureSpatial();
      }),
    };
    return [source];
  });

  // 鉄道。路線と駅で列構成が違うのでCollectionが分かれている。
  // どちらも無ければ鉄道の節を出さないだけで、他の機能は動く。
  const railwaySources: RailwaySource[] = (['railway', 'railway_station'] as const).flatMap(
    (kind) => {
      const collection = byKind(kind)[0];
      if (!collection) return [];
      const source: RailwaySource = {
        id: collection.id,
        kind,
        bbox: collection.bbox,
        files: [],
        coarseLodToleranceM: collection.coarseLodToleranceM,
        ensure: once(async () => {
          const items = await collection.items();
          source.files = itemFiles(items);
          await register(source.files.map(({ file }) => file));
          await ensureSpatial();
        }),
      };
      return [source];
    },
  );

  // 道路。無ければ道路の節を出さないだけで、他の機能は動く。
  const roadCollection = byKind('road')[0];
  const roadSource: RoadSource | undefined = roadCollection
    ? {
        id: roadCollection.id,
        bbox: roadCollection.bbox,
        files: [],
        coarseLodToleranceM: roadCollection.coarseLodToleranceM,
        ensure: once(async () => {
          const items = await roadCollection.items();
          roadSource!.files = itemFiles(items);
          await register(roadSource!.files.map(({ file }) => file));
          await ensureSpatial();
        }),
      }
    : undefined;
  const roadVintage = roadCollection?.vintage;

  // 送電線・川。道路と同じく、寄るまで (ONにするまで) Itemを読まない。
  const lineSources: LineSource[] = collections
    .filter((c) => (LINE_KINDS as readonly string[]).includes(c.kind))
    .map((collection) => {
      const source: LineSource = {
        id: collection.id,
        kind: collection.kind as LineKind,
        title: collection.title,
        bbox: collection.bbox,
        files: [],
        coarseLodToleranceM: collection.coarseLodToleranceM,
        ensure: once(async () => {
          const items = await collection.items();
          source.files = itemFiles(items);
          await register(source.files.map(({ file }) => file));
          await ensureSpatial();
        }),
      };
      return source;
    });

  // 路線の索引と、区間そのもの。**検索とハイライトのときだけ**読む。
  const routeCollection = byKind('road_route')[0];
  const ensureRoutes =
    routeCollection && roadCollection
      ? once(async () => {
          const routeFile = ((first) => (first ? itemFile(first) : undefined))((await routeCollection.items())[0]);
          if (!routeFile) return;
          await register([routeFile]);
          await conn.query(
            `CREATE VIEW road_route AS SELECT * FROM read_parquet('${routeFile}');`,
          );
          // ハイライトは区間の方から引くので、同じ経路で用意しておく。
          const files = (await roadCollection.items()).map(itemFile);
          await register(files);
          const list = files.map((file) => `'${file}'`).join(', ');
          await conn.query(`CREATE VIEW road AS SELECT * FROM read_parquet([${list}]);`);
          await ensureSpatial();
        })
      : undefined;
  // 等級の語彙もカタログから。鉄道の事業者種別と同じ扱い。
  const roadClasses = (roadCollection?.summaries['class'] ?? []) as string[];

  // 絞り込みの選択肢はカタログの語彙から作る。**事業者種別の列名をここに書かない**のは
  // 建物の用途と同じ理由で、語彙を出すかどうかをパイプライン側の一箇所で決めるため。
  const railwayVintage = railwaySources[0]
    ? byKind(railwaySources[0].kind)[0]?.vintage
    : undefined;

  const railwayInstitutionTypes = railwaySources[0]
    ? ((byKind(railwaySources[0].kind)[0]?.summaries['institution_type'] ?? []) as string[])
    : [];

  // 行政区域は1つの自治体が複数のポリゴン行に分かれることがある (飛び地や島など) ので、
  // 検索には名称を重複排除したものを使う。
  //
  // 専用のファイルがあればそれを読む。無い場合は行政区域から作るが、名称の列は
  // 合計65KB程度しかないのに row group の数だけ散らばっているため、HTTP越しでは
  // 往復回数が効いて極端に遅くなる (実測で42リクエスト・約24秒)。
  // 転送量ではなく往復の問題なので、pipeline の build_admin_names で
  // まとまった小さなファイルを作っておくこと。
  await conn.query(
    adminNamesFile
      ? `CREATE VIEW admin_names AS SELECT * FROM read_parquet('${adminNamesFile}');`
      : `CREATE TABLE admin_names AS
           SELECT DISTINCT
             admin_id,
             pref_name,
             coalesce(county_name, '') AS county_name,
             coalesce(city_name, '') AS city_name,
             coalesce(ward_name, '') AS ward_name
           FROM admin;`,
  );

  /**
   * 問い合わせの結果を Parquet にして返す (ダウンロード用)。
   *
   * DuckDB-WASM の中の空のファイルに書いてから取り出す。ジオメトリの列が
   * GEOMETRY 型なら DuckDB が `geo` メタデータを書くので、GeoParquet として読める。
   * `kv` に出典や規約を入れて、**切り出したファイルにも条件が付いて回る**ようにする。
   */
  const exportParquet = async (select: string, kv: Record<string, string>): Promise<Uint8Array> => {
    const name = `export_${Date.now()}.parquet`;
    await db.registerEmptyFileBuffer(name);
    const escape = (text: string) => text.replace(/'/g, "''");
    const kvSql = Object.entries(kv)
      .map(([key, value]) => `'${escape(key)}': '${escape(value)}'`)
      .join(', ');
    try {
      await conn.query(
        `COPY (${select}) TO '${name}' (FORMAT PARQUET${kvSql ? `, KV_METADATA {${kvSql}}` : ''});`,
      );
      return await db.copyFileToBuffer(name);
    } finally {
      await db.dropFile(name);
    }
  };

  return {
    conn,
    exportParquet,
    registerFiles: register,
    buildingSources,
    meshSources,
    railwaySources,
    railwayInstitutionTypes,
    railwayVintage,
    roadSource,
    lineSources,
    roadClasses,
    roadVintage,
    ensureRoutes,
    ensureSpatial,
    ensureOaza,
    ensureStations,
    ensureSections,
  };
}

/**
 * 緯度経度の点が入る3次メッシュ (8桁、約1km) のコード。[`meshBounds`] の逆。
 * パイプラインの `mesh.rs` と同じ計算 (1次は緯度×1.5と経度−100の整数部、
 * 2次は8分割、3次は10分割)。
 */
function meshCode3(lon: number, lat: number): string {
  const p = Math.floor(lat * 1.5);
  const u = Math.floor(lon - 100);
  const latRest = lat * 1.5 - p;
  const lonRest = lon - 100 - u;
  const q = Math.floor(latRest * 8);
  const v = Math.floor(lonRest * 8);
  const r = Math.floor((latRest * 8 - q) * 10);
  const w = Math.floor((lonRest * 8 - v) * 10);
  return `${p}${u}${q}${v}${r}${w}`;
}

/**
 * 表示範囲に掛かる3次メッシュのコード。**多すぎるときは2次メッシュ (6桁) にまとめる**
 * (PLATEAU配信サービスは6桁でも引ける)。それでも多ければ `null` (寄ってもらう)。
 */
function meshCodesInView(bounds: ViewBounds, limit = 60): string[] | null {
  const codes = new Set<string>();
  // 3次メッシュは緯度30秒 (1/120度)・経度45秒 (1/80度)。半分の刻みで拾えば漏れない。
  for (let lat = bounds.south; lat <= bounds.north + 1 / 240; lat += 1 / 240) {
    for (let lon = bounds.west; lon <= bounds.east + 1 / 160; lon += 1 / 160) {
      codes.add(meshCode3(Math.min(lon, bounds.east), Math.min(lat, bounds.north)));
      if (codes.size > 2000) break;
    }
  }
  if (codes.size <= limit) return [...codes].sort();
  const coarse = new Set([...codes].map((code) => code.slice(0, 6)));
  return coarse.size <= limit / 4 ? [...coarse].sort() : null;
}

/** PLATEAU配信サービス (公式のAPI)。CityGMLのメッシュ単位のファイルとpackを引く。 */
const PLATEAU_API = 'https://api.plateauview.mlit.go.jp';

/** CityGMLの地物の種類の呼び名。APIが返す種類のうち、よく出るもの。 */
const CITYGML_TYPES: Record<string, string> = {
  bldg: '建物',
  tran: '道路',
  rwy: '鉄道',
  brid: '橋',
  luse: '土地利用',
  dem: '地形',
  fld: '洪水浸水想定',
  tnm: '津波浸水想定',
  htd: '高潮浸水想定',
  lsld: '土砂災害警戒区域',
  urf: '都市計画決定',
  veg: '植生',
  frn: '都市設備',
  ubld: '地下街',
  wwy: '航路',
};

/** メッシュ単位のCityGMLファイル1つ。 */
interface CityGmlFile {
  type: string;
  code: string;
  url: string;
  maxLod: number;
  fileSize?: number;
  features?: number;
}

/**
 * 表示範囲のCityGMLファイル (メッシュ単位) を公式のAPIで引く。**押したときだけ呼ぶ。**
 * このAPIはブラウザから直接呼べる (`access-control-allow-origin: *` を確かめた)。
 */
async function fetchCityGmlFiles(codes: string[]): Promise<CityGmlFile[]> {
  const response = await fetch(`${PLATEAU_API}/datacatalog/citygml/m:${codes.join(',')}`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`PLATEAU配信サービスが ${response.status} を返しました`);
  const body = (await response.json()) as {
    cities?: { files?: Record<string, Omit<CityGmlFile, 'type'>[]> }[];
  };
  const files: CityGmlFile[] = [];
  const seen = new Set<string>();
  for (const city of body.cities ?? []) {
    for (const [type, list] of Object.entries(city.files ?? {})) {
      for (const file of list) {
        if (!file.url || seen.has(file.url)) continue;
        seen.add(file.url);
        files.push({ ...file, type });
      }
    }
  }
  return files;
}

/**
 * 公式の pack で、選んだCityGMLを**付属ファイル (コードリスト・テクスチャ) 込みのZIP**に
 * まとめてもらう。サーバー側の非同期の処理なので、状態を数秒おきに見る。
 * 返すのはZIPのURL。
 */
async function packCityGml(urls: string[], onProgress: (progress: number) => void): Promise<string> {
  const response = await fetch(`${PLATEAU_API}/citygml/pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  if (!response.ok) throw new Error(`packの依頼に失敗しました (${response.status})`);
  const { id } = (await response.json()) as { id: string };
  for (;;) {
    const status = await fetch(`${PLATEAU_API}/citygml/pack/${id}/status`);
    if (!status.ok) throw new Error(`packの状態を取れません (${status.status})`);
    const body = (await status.json()) as { status: string; progress?: number };
    if (body.status === 'succeeded') return `${PLATEAU_API}/citygml/pack/${id}.zip`;
    if (body.status !== 'accepted' && body.status !== 'processing') {
      throw new Error(`packが失敗しました (${body.status})`);
    }
    onProgress(body.progress ?? 0);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

/** バイト列をファイルとして保存させる。 */
function saveBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.apache.parquet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** バイト数を読みやすく。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 地域メッシュ (JIS X 0410) のコードから範囲を求める。
 *
 * **束ねたセルは、この矩形で描く。** 中に入っている子メッシュのbboxの和で描くと、
 * 人のいる子だけを囲った形になり、細い縦帯のような「メッシュではない形」が出る。
 * 実際に地図で見て分かった。
 *
 * パイプライン側の `pipeline/src/mesh.rs` と同じ計算。JIS X 0410 は変わらないので、
 * 二重に持つことを受け入れている (SQLで書くよりこちらの方が読める)。
 */
function meshBounds(code: string): Bbox {
  const digits = [...code].map(Number);
  // 1次メッシュ。緯度は1.5倍した整数部、経度は100を引いた整数部。
  let latSize = 2 / 3;
  let lonSize = 1;
  let south = (digits[0] * 10 + digits[1]) / 1.5;
  let west = digits[2] * 10 + digits[3] + 100;

  // 2次メッシュ。1次を縦横8分割し、南西を0として行・列で指す。
  if (digits.length >= 6) {
    latSize /= 8;
    lonSize /= 8;
    south += digits[4] * latSize;
    west += digits[5] * lonSize;
  }
  // 3次メッシュ。2次を縦横10分割する。
  if (digits.length >= 8) {
    latSize /= 10;
    lonSize /= 10;
    south += digits[6] * latSize;
    west += digits[7] * lonSize;
  }
  // 分割メッシュ。1桁ごとに4分割で、1=南西 2=南東 3=北西 4=北東。
  for (const quadrant of digits.slice(8)) {
    latSize /= 2;
    lonSize /= 2;
    south += Math.floor((quadrant - 1) / 2) * latSize;
    west += ((quadrant - 1) % 2) * lonSize;
  }
  return [west, south, west + lonSize, south + latSize];
}

/** 集約したメッシュ1つ分。 */
interface MeshCell {
  /** メッシュコード。矩形はここから計算する。 */
  code: string;
  population: number;
  /** 人口密度 (人/km²)。**中の最大値**。 */
  density: number;
}

/**
 * 表示範囲の人口メッシュを、指定の桁で束ねて取り出す。
 *
 * **密度は平均ではなく最大を取る。** SORAは運航範囲の中で最も密度の高いところを
 * 採るので、平均にすると危ないセルが薄まって消える。人口は合計。
 *
 * 矩形は返さない。**メッシュコードから計算する** ([`meshBounds`])。
 * 子のbboxの和で描くと、メッシュではない形になってしまう。
 */
async function fetchMeshInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: MeshSource,
  bounds: ViewBounds,
  digits: number,
): Promise<MeshCell[]> {
  const files = filesInView(source, bounds);
  if (files.length === 0) return [];
  const list = files.map((file) => `'${file}'`).join(', ');

  const result = await conn.query(`
    SELECT
      substr(mesh_code, 1, ${digits}) AS code,
      sum(population) AS population,
      max(density) AS density
    FROM read_parquet([${list}])
    WHERE bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}
      AND bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}
      AND density IS NOT NULL
    GROUP BY code;
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      code: string;
      population: number | bigint | null;
      density: number;
    };
    return {
      code: r.code,
      population: Number(r.population ?? 0),
      density: r.density,
    };
  });
}

/** 鉄道1件分の表示用データ。路線と駅で同じ形にしてある。 */
interface RailwayFeature {
  geojson: GeoJSON.Geometry;
  /** N02_003 (路線名)。 */
  lineName: string;
  /** N02_004 (運営会社)。 */
  operator: string;
  /** 事業者種別を解決した名前。色はこれで決める。 */
  institutionType: string;
  /** 鉄道区分を解決した名前。 */
  railwayClass: string;
  /** 駅名。路線には無い。 */
  stationName: string | null;
}

/**
 * 表示範囲に入る鉄道を取り出す。建物と同じく bbox 列で先に絞り、
 * 画面中心に近い順に上限まで取る (上限に当たっても帯状に欠けないため)。
 *
 * 駅のファイルにしか `station_name` が無いので、SELECT する列を出所で変える。
 * 路線側で `station_name` を書くとスキーマに無い列で落ちる。
 */
async function fetchRailwayInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: RailwaySource,
  bounds: ViewBounds,
  institutionTypes: string[] | null,
  limit: number,
  lod: number | undefined,
): Promise<RailwayFeature[]> {
  const files = filesInView(source, bounds);
  if (files.length === 0) return [];
  const list = files.map((file) => `'${file}'`).join(', ');

  const conditions = [
    `bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}`,
    `bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}`,
  ];
  if (lod !== undefined) conditions.push(`lod = ${lod}`);
  if (institutionTypes) {
    // 建物の用途と同じく、1つも選ばれていなければ1件も出さない。
    const types = institutionTypes.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');
    conditions.push(types.length > 0 ? `institution_type IN (${types})` : 'false');
  }

  const stationSelect = source.kind === 'railway_station' ? 'station_name' : 'NULL';
  const lonScale = Math.cos((bounds.centerLat * Math.PI) / 180);

  const result = await conn.query(`
    SELECT
      ST_AsGeoJSON(geometry) AS geojson,
      line_name, operator, institution_type, railway_class,
      ${stationSelect} AS station_name
    FROM read_parquet([${list}])
    WHERE ${conditions.join('\n      AND ')}
    ORDER BY
      pow(((bbox.xmin + bbox.xmax) / 2 - ${bounds.centerLon}) * ${lonScale}, 2)
      + pow((bbox.ymin + bbox.ymax) / 2 - ${bounds.centerLat}, 2)
    LIMIT ${limit};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      geojson: string;
      line_name: string;
      operator: string;
      institution_type: string;
      railway_class: string;
      station_name: string | null;
    };
    return {
      geojson: JSON.parse(r.geojson) as GeoJSON.Geometry,
      lineName: r.line_name,
      operator: r.operator,
      institutionType: r.institution_type,
      railwayClass: r.railway_class,
      stationName: r.station_name,
    };
  });
}

/**
 * 表示範囲に入る道路を取り出す。鉄道と同じく bbox 列で先に絞り、
 * 画面中心に近い順に上限まで取る。
 *
 * `class` はファイルが分かれているので、**選ばれていない等級のファイルは
 * そもそも読みに行かない** (これが class で分けている理由)。
 */
async function fetchRoadsInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: RoadSource,
  bounds: ViewBounds,
  classes: string[],
  limit: number,
  lod: number | undefined,
): Promise<RoadFeature[]> {
  if (classes.length === 0) return [];
  // ファイル名に class が入っているので、読むファイルの段階で絞れる。
  const files = filesInView(source, bounds).filter((file) =>
    classes.some((cls) => file.endsWith(`_${cls}.parquet`)),
  );
  if (files.length === 0) return [];
  const list = files.map((file) => `'${file}'`).join(', ');
  const lonScale = Math.cos((bounds.centerLat * Math.PI) / 180);

  const result = await conn.query(`
    SELECT
      ST_AsGeoJSON(geometry) AS geojson,
      road_name, class, route_names
    FROM read_parquet([${list}])
    WHERE ${lodFilter(lod)}
      bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}
      AND bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}
    ORDER BY
      pow(((bbox.xmin + bbox.xmax) / 2 - ${bounds.centerLon}) * ${lonScale}, 2)
      + pow((bbox.ymin + bbox.ymax) / 2 - ${bounds.centerLat}, 2)
    LIMIT ${limit};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      geojson: string;
      road_name: string | null;
      class: string;
      route_names: unknown;
    };
    return {
      geojson: JSON.parse(r.geojson) as GeoJSON.Geometry,
      roadName: r.road_name,
      roadClass: r.class,
      // リスト列はArrowのVectorで返るので、素の配列に均す。
      routeNames: Array.from((r.route_names ?? []) as ArrayLike<unknown>, String),
    };
  });
}

// ---- 周辺検索 ----------------------------------------------------------------
//
// **起点 (点・線・面) から○m以内に何があるか**を、カタログにあるデータ全部に聞く。
// 画面に出しているかどうかは関係ない (出していないデータも数える)。
// 用途を決め打ちしない汎用の部品で、「川沿い・送電線沿いに何があるか」も
// 「この建物の周りに学校はあるか」も同じ問い合わせになる。

/** 周辺検索の起点。 */
interface NearbyOrigin {
  /** 何を起点にしたか (「山手線」「地図上の点」など)。 */
  label: string;
  geometry: GeoJSON.Geometry;
}

/**
 * 距離を測るための座標の置き換え。**起点の近くの緯度でメートルに直す**
 * (`ST_Affine`)。経度1度の長さは緯度で変わるので、起点の中心の緯度で決める。
 * 1km以内なら平面とみなした誤差は小さい (東京で1kmにつき数m)。
 */
interface NearbyFrame {
  /** `ST_Affine(… , sx, 0, 0, sy, ox, oy)` で度をメートルに直す。 */
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  /** 先に絞るための範囲 (起点の範囲を距離ぶん広げたもの。表示範囲で切ることがある)。 */
  bounds: ViewBounds;
  /** 表示範囲で切ったか。起点が画面より大きい (長い路線など) とき。 */
  clipped: boolean;
  /** 起点のジオメトリをメートルに直したSQLの式。 */
  origin: string;
  distance: number;
}

/** GeoJSON の座標を全部たどって範囲を返す。 */
function geometryBbox(geometry: GeoJSON.Geometry): Bbox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (value: unknown): void => {
    if (Array.isArray(value) && typeof value[0] === 'number') {
      const [x, y] = value as number[];
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, y);
      north = Math.max(north, y);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    }
  };
  if (geometry.type === 'GeometryCollection') {
    for (const part of geometry.geometries) {
      const [w, s, e, n] = geometryBbox(part);
      west = Math.min(west, w);
      south = Math.min(south, s);
      east = Math.max(east, e);
      north = Math.max(north, n);
    }
  } else {
    visit(geometry.coordinates);
  }
  return [west, south, east, north];
}

/**
 * 周辺検索の座標系と先に絞る範囲を決める。
 *
 * **起点が画面より大きいときは、表示範囲の中だけを数える。** 路線のように
 * 長いものを起点にすると、範囲が都市を丸ごと覆って建物を何百MBも読むことになる。
 */
function nearbyFrame(origin: NearbyOrigin, distance: number, view: ViewBounds): NearbyFrame {
  const [west, south, east, north] = geometryBbox(origin.geometry);
  const lat0 = (south + north) / 2;
  const lon0 = (west + east) / 2;
  const sx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const sy = 110_540;
  const dx = distance / sx;
  const dy = distance / sy;
  const expanded = { west: west - dx, south: south - dy, east: east + dx, north: north + dy };
  const clipped =
    expanded.west < view.west ||
    expanded.east > view.east ||
    expanded.south < view.south ||
    expanded.north > view.north;
  const bounds: ViewBounds = clipped
    ? {
        west: Math.max(expanded.west, view.west),
        south: Math.max(expanded.south, view.south),
        east: Math.min(expanded.east, view.east),
        north: Math.min(expanded.north, view.north),
        centerLon: lon0,
        centerLat: lat0,
      }
    : { ...expanded, centerLon: lon0, centerLat: lat0 };
  const json = JSON.stringify(origin.geometry).replace(/'/g, "''");
  const frame = { sx, sy, ox: -lon0 * sx, oy: -lat0 * sy, bounds, clipped, distance };
  return { ...frame, origin: toMeters(frame, `ST_GeomFromGeoJSON('${json}')`) };
}

/** ジオメトリの式をメートルの座標に直す。 */
function toMeters(frame: Pick<NearbyFrame, 'sx' | 'sy' | 'ox' | 'oy'>, expression: string): string {
  return `ST_Affine(${expression}, ${frame.sx}, 0, 0, ${frame.sy}, ${frame.ox}, ${frame.oy})`;
}

/** メートルの座標を度に戻す ([`toMeters`] の逆)。範囲の輪郭を地図に描くのに使う。 */
function fromMeters(frame: Pick<NearbyFrame, 'sx' | 'sy' | 'ox' | 'oy'>, expression: string): string {
  return `ST_Affine(${expression}, ${1 / frame.sx}, 0, 0, ${1 / frame.sy}, ${-frame.ox / frame.sx}, ${-frame.oy / frame.sy})`;
}

/** 先に bbox で絞り、そのうえで距離で判定する WHERE の中身。 */
function nearbyCondition(frame: NearbyFrame): string {
  const b = frame.bounds;
  return `bbox.xmin <= ${b.east} AND bbox.xmax >= ${b.west}
      AND bbox.ymin <= ${b.north} AND bbox.ymax >= ${b.south}
      AND ST_DWithin(${toMeters(frame, 'geometry')}, ${frame.origin}, ${frame.distance})`;
}

/** 周辺の建物。段ごとの件数・名前のある建物・強調に使う形。 */
interface NearbyBuildings {
  source: BuildingSource;
  /** 段の題名 → 件数。段の無い出所では「すべて」の1つ。 */
  counts: [string, number][];
  named: string[];
  features: GeoJSON.Feature[];
}

/** 強調に描く建物の上限。数えるのは全部だが、描くのはここまで。 */
const NEARBY_DRAW_LIMIT = 3000;

async function fetchNearbyBuildings(
  conn: duckdb.AsyncDuckDBConnection,
  source: BuildingSource,
  frame: NearbyFrame,
): Promise<NearbyBuildings | null> {
  const files = filesInView(source, frame.bounds);
  if (files.length === 0) return null;
  const list = files.map((file) => `'${file}'`).join(', ');
  const tier = source.tiers ? tierExpression(source.tiers) : `'all'`;
  const where = nearbyCondition(frame);
  const counted = await conn.query(`
    SELECT ${tier} AS tier, count(*) AS n,
      list(DISTINCT name) FILTER (name IS NOT NULL) AS names
    FROM read_parquet([${list}])
    WHERE ${where}
    GROUP BY 1;
  `);
  const rows = counted.toArray().map((row) => row.toJSON() as { tier: string; n: number | bigint; names: unknown });
  if (rows.length === 0) return null;
  const order = source.tiers?.tiers ?? [{ id: 'all', title: 'すべて', values: [] }];
  const counts = order.map(
    (t) => [t.title, Number(rows.find((r) => r.tier === t.id)?.n ?? 0)] as [string, number],
  );
  // 名前は重要な段から並べる (公共施設の名前が先に来る)。
  const named = order.flatMap((t) => {
    const row = rows.find((r) => r.tier === t.id);
    return row?.names ? Array.from(row.names as ArrayLike<unknown>, String) : [];
  });

  const drawn = await conn.query(`
    SELECT ST_AsGeoJSON(geometry) AS geojson, name, ${tier} AS tier
    FROM read_parquet([${list}])
    WHERE ${where}
    LIMIT ${NEARBY_DRAW_LIMIT};
  `);
  const features = drawn.toArray().map((row) => {
    const r = row.toJSON() as { geojson: string; name: string | null; tier: string };
    const rank = order.findIndex((t) => t.id === r.tier);
    return {
      type: 'Feature' as const,
      properties: { name: r.name, tierRank: source.tiers ? rank : -1 },
      geometry: JSON.parse(r.geojson) as GeoJSON.Geometry,
    };
  });
  return { source, counts, named, features };
}

/**
 * 周辺にある線や点の名前 (重複なし)。駅・路線・道路・送電線・川で共通。
 * `nameExpression` は名前を作る式 (駅なら駅名と路線名など)。
 */
async function fetchNearbyNames(
  conn: duckdb.AsyncDuckDBConnection,
  source: { files: ItemFile[]; coarseLodToleranceM?: number },
  frame: NearbyFrame,
  nameExpression: string,
  limit = 30,
): Promise<{ names: string[]; total: number }> {
  const files = filesInView(source, frame.bounds);
  if (files.length === 0) return { names: [], total: 0 };
  const list = files.map((file) => `'${file}'`).join(', ');
  // 粗い段を持つファイルは原寸だけで判定する (粗い段は簡略化して位置がずれている)。
  const lod = source.coarseLodToleranceM !== undefined ? lodFilter(EXACT_LOD) : '';
  const result = await conn.query(`
    SELECT DISTINCT ${nameExpression} AS name
    FROM read_parquet([${list}])
    WHERE ${lod} ${nearbyCondition(frame)}
      AND (${nameExpression}) IS NOT NULL;
  `);
  const names = result.toArray().map((row) => String((row.toJSON() as { name: unknown }).name));
  names.sort((a, b) => a.localeCompare(b, 'ja'));
  return { names: names.slice(0, limit), total: names.length };
}

/**
 * 周辺の人口。**範囲に掛かるメッシュの値の合計** なので、範囲より広い分を含む
 * (メッシュの一部だけ掛かっても、そのメッシュ全体の人口を数える)。概算として出す。
 */
async function fetchNearbyPopulation(
  conn: duckdb.AsyncDuckDBConnection,
  source: MeshSource,
  frame: NearbyFrame,
): Promise<{ population: number; cells: number } | null> {
  const files = filesInView(source, frame.bounds);
  if (files.length === 0) return null;
  const list = files.map((file) => `'${file}'`).join(', ');
  const result = await conn.query(`
    SELECT coalesce(sum(population), 0) AS population, count(*) AS cells
    FROM read_parquet([${list}])
    WHERE ${nearbyCondition(frame)};
  `);
  const row = result.toArray()[0]?.toJSON() as { population: number | bigint; cells: number | bigint };
  return { population: Number(row.population), cells: Number(row.cells) };
}

/** 建物1件分の表示用データ。 */
interface BuildingFeature {
  geojson: GeoJSON.Geometry;
  name: string | null;
  /** 用途 (PLATEAU) または種別 (Overture)。出所によって語彙が違う。 */
  category: string | null;
  height: number | null;
  /** 重要度の段のID。出所が段を持たなければ null。 */
  tier: string | null;
}

/** 建物の絞り込み条件。PLATEAUのように属性が揃っている出所でだけ意味を持つ。 */
interface BuildingFilter {
  /** 高さの下限 (m)。0なら絞らない。 */
  minHeight: number;
  /** 対象の用途。null なら絞らない。 */
  usages: string[] | null;
  /** 対象の重要度の段 (ID)。null なら絞らない。 */
  tiers: string[] | null;
}

/**
 * 表示範囲に入る建物を取り出す。
 *
 * 逆ジオコーディングと同じく、ジオメトリ本体を評価する前に bbox 列で絞る。
 *
 * 件数が多いと描画が重くなるので上限を設けるが、単に LIMIT で切るとまずい。
 * データは空間的にソートされているため、先頭から N 件を取ると地図の一部分にだけ
 * 固まって「帯状に消える」ように見える。
 *
 * **画面中心に近い順に取る。** 地図を傾けると `getBounds()` は地平線方向へ大きく
 * 広がり (実測でpitch 50度のとき面積3.1倍、60度で7.1倍)、上限に当たりやすくなる。
 * 中心からの距離順にしておけば、間引かれても手前から埋まり、遠景が薄くなるという
 * 見た目として自然な劣化になる。範囲そのものを切り詰めるより調整値が要らない。
 */
/** 整備範囲のセル1つ。 */
interface CoverageCell {
  code: string;
  /** このセルの中にある建物の数。 */
  buildings: number;
  /**
   * **データのある1kmセルの数。** 配られているのは常に8桁 (1km) なので、
   * 束ねたときにいくつ集まったかがそのまま「どれだけ埋まっているか」になる。
   * 8桁で見ているときは必ず1。
   */
  filled: number;
  /**
   * このセルにかかる自治体。**1つに潰さない** — メッシュは境界をまたぐので、
   * 全国35,645セルのうち約10%が複数にかかる (最大4つ)。
   * 束ねて粗くすると当然もっと増える。
   */
  cities: string[];
}

/**
 * 整備範囲を表示範囲のぶんだけ引く。
 *
 * **人口メッシュと同じ作り。** コードを前から切って束ねるので、
 * 1kmで配ったものから10kmも80kmも作れる。
 */
async function fetchCoverageInView(
  conn: duckdb.AsyncDuckDBConnection,
  coverage: BuildingCoverage,
  bounds: ViewBounds,
  digits: number,
): Promise<CoverageCell[]> {
  const files = filesInView(coverage, bounds);
  if (files.length === 0) return [];
  const list = files.map((file) => `'${file}'`).join(', ');

  const result = await conn.query(`
    SELECT
      substr(mesh_code, 1, ${digits}) AS code,
      sum(buildings) AS buildings,
      -- **束ねた1kmセルの数。** 行は1kmセルにつき1つしか無いので、
      -- これが「このセルのうちどれだけ埋まっているか」の分子になる。
      count(*) AS filled,
      -- 束ねると自治体も混ざる。**並べて重複を落とす**ので、
      -- 同じ顔ぶれなら並びも同じになる。
      list_sort(list_distinct(flatten(list(cities)))) AS cities
    FROM read_parquet([${list}])
    WHERE bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}
      AND bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}
    GROUP BY code;
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      code: string;
      buildings: number | bigint;
      filled: number | bigint;
      cities: unknown;
    };
    return {
      code: r.code,
      buildings: Number(r.buildings),
      filled: Number(r.filled),
      // リスト列はArrowのVectorで返るので、素の配列に均す。
      cities: Array.from((r.cities ?? []) as ArrayLike<unknown>, String),
    };
  });
}

/**
 * 表示範囲に整備範囲のセルが**1つでも**あるか。一覧の「この範囲には無い」の判定に使う。
 *
 * Collectionの収録範囲 (bbox) だけで決めると、PLATEAUは306都市の和が日本を
 * ほぼ覆う箱になり、山の中でも「ある」と出る。整備範囲は1kmのセルで持っているので、
 * そちらに聞けば**建物が1棟でもあるところだけ**を「ある」と言える。
 *
 * **1行見つかれば止める** (`LIMIT 1`)。セルを数えたり束ねたりしないので、
 * 描くための問い合わせ (`fetchCoverageInView`) より軽い。bboxの列の統計で
 * 行グループごと読み飛ばすので、当たらない場所ではほとんど読まない。
 */
async function coverageInView(
  conn: duckdb.AsyncDuckDBConnection,
  coverage: BuildingCoverage,
  bounds: ViewBounds,
): Promise<boolean> {
  const files = filesInView(coverage, bounds);
  if (files.length === 0) return false;
  const list = files.map((file) => `'${file}'`).join(', ');
  const result = await conn.query(`
    SELECT 1 FROM read_parquet([${list}])
    WHERE bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}
      AND bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}
    LIMIT 1;
  `);
  return result.numRows > 0;
}

async function fetchBuildingsInView(
  conn: duckdb.AsyncDuckDBConnection,
  source: BuildingSource,
  bounds: ViewBounds,
  filter: BuildingFilter,
  limit: number,
  /** 間引くときの段の上限 (この順位まで出す)。`undefined` なら全部。 */
  maxRank?: number,
): Promise<BuildingFeature[]> {
  // 表示範囲に重なるファイルだけを渡す。重なるものが無ければ問い合わせない。
  const files = filesInView(source, bounds);
  if (files.length === 0) return [];
  const list = files.map((file) => `'${file}'`).join(', ');

  // 絞り込みは **SQLに渡す**。取得後にJavaScript側で捨てると、
  // 読む量も転送する量も減らないため。
  const conditions = [
    `bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}`,
    `bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}`,
  ];
  // **段の列で間引く。** 段ごとに行グループが分かれているので、統計で読み飛ばせる。
  if (maxRank !== undefined && source.tiers?.lod_column) {
    conditions.unshift(`${source.tiers.lod_column} <= ${maxRank}`);
  }
  if (source.hasHeight && filter.minHeight > 0) {
    conditions.push(`height >= ${filter.minHeight}`);
  }
  if (source.categoryColumn && filter.usages) {
    // 用途が1つも選ばれていなければ1件も出さない (空のINは常に偽)。
    const list = filter.usages.map((u) => `'${u.replace(/'/g, "''")}'`).join(', ');
    conditions.push(list.length > 0 ? `${source.categoryColumn} IN (${list})` : 'false');
  }
  // 段は規則から求める式。絞るときも同じ式を条件にする (列が無いので)。
  const tierSelect = source.tiers ? tierExpression(source.tiers) : 'NULL';
  if (source.tiers && filter.tiers) {
    const list = filter.tiers.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');
    conditions.push(list.length > 0 ? `(${tierSelect}) IN (${list})` : 'false');
  }
  const categorySelect = source.categoryColumn ?? 'NULL';

  // 緯度方向と経度方向で1度あたりの距離が違うので、経度差を縮めてから比べる
  // (東京付近では経度1度が緯度1度の約0.81倍)。並べ替えの順序だけの話なので、
  // 厳密な測地線距離までは要らない。
  const lonScale = Math.cos((bounds.centerLat * Math.PI) / 180);

  const result = await conn.query(`
    SELECT ST_AsGeoJSON(geometry) AS geojson, name, ${categorySelect} AS category, height,
      ${tierSelect} AS tier
    FROM read_parquet([${list}])
    WHERE ${conditions.join('\n      AND ')}
    ORDER BY
      pow(((bbox.xmin + bbox.xmax) / 2 - ${bounds.centerLon}) * ${lonScale}, 2)
      + pow((bbox.ymin + bbox.ymax) / 2 - ${bounds.centerLat}, 2)
    LIMIT ${limit};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      geojson: string;
      name: string | null;
      category: string | null;
      height: number | null;
      tier: string | null;
    };
    return {
      geojson: JSON.parse(r.geojson) as GeoJSON.Geometry,
      name: r.name,
      category: r.category,
      height: r.height,
      tier: r.tier,
    };
  });
}

/**
 * 「港区 芝公園」のように複数の要素が並んだ入力も拾えるよう、空白区切りの
 * トークンごとに「連結した住所」への部分一致をANDで取る条件式を組み立てる。
 * (列ごとの部分一致だと、候補選択後にinputへ入る連結文字列が何にも一致しない)
 */
function buildMatchConditions(keyword: string, concatExpr: string): string {
  return keyword
    .split(/[\s　]+/)
    .filter((token) => token.length > 0)
    .map((token) => `${concatExpr} ILIKE '%${token.replace(/'/g, "''")}%'`)
    .join(' AND ');
}

/** 候補として表示する件数の上限 (行政区域と地名の合計)。 */
const MAX_RESULTS = 10;

/**
 * 打った語そのものではない道路を、候補に出す上限。
 *
 * **道路は同じ語を含む路線が桁違いに多い。**「東京」には109路線が当たり、
 * 上限を掛けずに前へ出したときは候補10件をすべて道路が埋めて、
 * 東京駅も東京都も消えた。
 */
const ROUTE_SUGGESTIONS = 3;

async function searchAddress(
  conn: duckdb.AsyncDuckDBConnection,
  keyword: string,
): Promise<SearchResult[]> {
  // 行政区域と地名は別のテーブルにあるので個別に引き、行政区域を優先して
  // 合計 MAX_RESULTS 件に収める (どちらか一方しか無い場合は残りをもう一方で埋める)。
  const adminExpr = `pref_name || county_name || city_name || ward_name`;
  const adminResult = await conn.query(`
    SELECT admin_id, ${adminExpr} AS label
    FROM admin_names
    WHERE ${buildMatchConditions(keyword, adminExpr)}
    ORDER BY length(label)
    LIMIT ${MAX_RESULTS};
  `);
  const admins: SearchResult[] = adminResult.toArray().map((row) => {
    const r = row.toJSON() as unknown as { admin_id: string; label: string };
    return { kind: 'admin', label: r.label, adminId: r.admin_id };
  });

  const oazaExpr = `pref_name || city_name || oaza_name`;
  const oazaResult = await conn.query(`
    -- 位置参照情報は点データなので、covering bbox がそのまま経緯度になる。
    -- ST_X/ST_Y を使うと地名検索のためだけに spatial 拡張の取得を待つことになる。
    SELECT ${oazaExpr} AS label, bbox.xmin AS lon, bbox.ymin AS lat
    FROM isj_oaza
    WHERE ${buildMatchConditions(keyword, oazaExpr)}
    ORDER BY length(label)
    LIMIT ${MAX_RESULTS};
  `);
  const oazas: SearchResult[] = oazaResult.toArray().map((row) => {
    const r = row.toJSON() as unknown as { label: string; lon: number; lat: number };
    return { kind: 'oaza', label: r.label, lon: r.lon, lat: r.lat };
  });

  return [...admins, ...oazas].slice(0, MAX_RESULTS);
}

/**
 * 駅を名前で引く。
 *
 * **路線名も対象にする。**「山手線」でその路線の駅が出る。
 *
 * **駅名・路線名・運営会社の組でユニークにする。** 同じ駅名の行が路線の数だけあり
 * (「東京」は12路線)、そのまま出すと候補が同じ名前で埋まる。
 * 乗り換えでまとめるか県で分けるかは扱いが難しいので、まずは組で分ける。
 *
 * **運営会社まで入れないと壊れる。**「本線」は複数の会社が使う一般名で、
 * 駅名と路線名だけだと住吉駅 (兵庫と福岡) が同じ組になり、平均を取ると
 * **600km離れた中間点**に飛ぶ。実測で3組 (10,134組中) がこれに当たり、
 * 会社を足すと最大の広がりが1kmに収まる。
 *
 * 位置は **bboxの中心**。駅は点ではなく線 (ホームの延長) なので、
 * `bbox.xmin` をそのまま使うと端に寄る。
 */
async function searchStations(
  conn: duckdb.AsyncDuckDBConnection,
  keyword: string,
): Promise<SearchResult[]> {
  // **「駅」を挟む。** 原典の `station_name` は「品川」で「駅」が付かないので、
  // 人がふつうに打つ「品川駅」が1件も当たらなかった。
  // (「〇〇駅」で終わる駅名も8件あるが、二重になっても照合には影響しない)
  const expr = `station_name || '駅' || line_name || operator`;
  const result = await conn.query(`
    SELECT * FROM (
      SELECT
        station_name, line_name, any_value(operator) AS operator,
        avg((bbox.xmin + bbox.xmax) / 2) AS lon,
        avg((bbox.ymin + bbox.ymax) / 2) AS lat
      FROM station
      WHERE ${buildMatchConditions(keyword, expr)}
      GROUP BY station_name, line_name, operator
    )
    ORDER BY length(station_name || line_name)
    LIMIT ${MAX_RESULTS};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      station_name: string;
      line_name: string;
      operator: string;
      lon: number;
      lat: number;
    };
    return {
      kind: 'station' as const,
      label: `${r.station_name}駅`,
      // **会社名は必ず出す。**「品川駅 (本線)」では何線か分からない。
      // 重複しているときだけ出す形にしたが、絞り込んだ結果の中でしか
      // 重複を数えられず、品川駅のように1件だけ返る場合に付かなかった。
      detail: `${r.operator} ${r.line_name}`,
      lon: r.lon,
      lat: r.lat,
    };
  });
}

/**
 * 路線を名前で引く。**路線そのものを候補に出す。**
 *
 * 「山手線」と打ったときに駅ばかり並ぶと、路線を見たい人の役に立たない。
 *
 * 範囲は**その路線の駅から**作る。路線のファイル (5.2MB、ジオメトリだけで4.6MB) を
 * 読まずに済み、駅は検索のために既に読んでいる。実測で596路線のうち
 * 駅が1つしかないのは2つだけで、範囲の中央値は14km。
 */
async function searchLines(
  conn: duckdb.AsyncDuckDBConnection,
  keyword: string,
): Promise<SearchResult[]> {
  const result = await conn.query(`
    SELECT
      line_name, operator,
      min(bbox.xmin) AS west, min(bbox.ymin) AS south,
      max(bbox.xmax) AS east, max(bbox.ymax) AS north
    FROM station
    WHERE ${buildMatchConditions(keyword, 'line_name || operator')}
    GROUP BY line_name, operator
    ORDER BY length(line_name)
    LIMIT ${MAX_RESULTS};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      line_name: string;
      operator: string;
      west: number;
      south: number;
      east: number;
      north: number;
    };
    return {
      kind: 'line' as const,
      label: r.line_name,
      // **会社名は必ず出す。**「本線」は10社が使っている。
      detail: r.operator,
      bbox: [r.west, r.south, r.east, r.north] as Bbox,
      lineName: r.line_name,
      operator: r.operator,
    };
  });
}

/**
 * 道路の路線を引く。「国道13号」「山形県道16号」など。
 *
 * **路線の索引 (211KB) から引く。** 区間そのもの (70MB) を走査すると、
 * bbox列だけで約9MB読むことになる。索引は同じOvertureの道路から作った要約なので、
 * 検索で出たものと地図に出るものは同じデータ。
 */
/**
 * 区間の並びを1つのMultiLineStringにまとめる。ハイライト用。
 *
 * 1件も無ければ `null` を返す。空のMultiLineStringを入れると、
 * MapLibreが空のソースと区別できない。
 */
function toMultiLineString(parts: GeoJSON.Geometry[]): GeoJSON.Geometry | null {
  const coordinates = parts.flatMap((part) =>
    part.type === 'LineString'
      ? [part.coordinates]
      : part.type === 'MultiLineString'
        ? part.coordinates
        : [],
  );
  return coordinates.length > 0 ? { type: 'MultiLineString', coordinates } : null;
}

async function searchRoutes(
  conn: duckdb.AsyncDuckDBConnection,
  keyword: string,
): Promise<SearchResult[]> {
  const result = await conn.query(`
    SELECT route_name, class, segments, bbox
    FROM road_route
    WHERE ${buildMatchConditions(keyword, 'route_name')}
    ORDER BY length(route_name)
    LIMIT ${MAX_RESULTS};
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as unknown as {
      route_name: string;
      class: string;
      segments: number;
      bbox: { xmin: number; ymin: number; xmax: number; ymax: number };
    };
    return {
      kind: 'route' as const,
      label: r.route_name,
      detail: `${ROAD_STYLES[r.class]?.label ?? r.class} · ${Number(r.segments).toLocaleString()} 区間`,
      bbox: [r.bbox.xmin, r.bbox.ymin, r.bbox.xmax, r.bbox.ymax] as Bbox,
      routeName: r.route_name,
    };
  });
}

/**
 * 選んだ路線の道路を読む。**ハイライトのためだけに、そのときだけ読む。**
 *
 * 範囲で絞るのは鉄道と同じ理由 (row groupの統計で読み飛ばさせる)。
 * **`list_contains` で当てる。** 1区間が複数の路線に属するのでリストになっている。
 */
async function fetchRouteGeometry(
  conn: duckdb.AsyncDuckDBConnection,
  routeName: string,
  [west, south, east, north]: Bbox,
): Promise<GeoJSON.Geometry[]> {
  const quoted = `'${routeName.replace(/'/g, "''")}'`;
  const result = await conn.query(`
    SELECT ST_AsGeoJSON(geometry) AS geojson
    FROM road
    WHERE list_contains(route_names, ${quoted})
      AND bbox.xmin <= ${east} AND bbox.xmax >= ${west}
      AND bbox.ymin <= ${north} AND bbox.ymax >= ${south};
  `);
  return result
    .toArray()
    .map(
      (row) => JSON.parse((row.toJSON() as unknown as { geojson: string }).geojson) as GeoJSON.Geometry,
    );
}

/**
 * 選んだ路線の線を読む。**ハイライトのためだけに、そのときだけ読む。**
 *
 * 範囲 (`bbox`) で絞るのは、row group の統計で読み飛ばさせるため。
 * 路線のファイルは5.2MB (ジオメトリ4.6MB) あるが、
 * 実測では山手線が65区間で8KB、東海道線でも493区間で140KB。
 */
async function fetchLineGeometry(
  conn: duckdb.AsyncDuckDBConnection,
  lineName: string,
  operator: string,
  [west, south, east, north]: Bbox,
): Promise<GeoJSON.Geometry[]> {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const result = await conn.query(`
    SELECT ST_AsGeoJSON(geometry) AS geojson
    FROM section
    WHERE line_name = ${quote(lineName)} AND operator = ${quote(operator)}
      AND bbox.xmin <= ${east} AND bbox.xmax >= ${west}
      AND bbox.ymin <= ${north} AND bbox.ymax >= ${south};
  `);
  return result
    .toArray()
    .map((row) => JSON.parse((row.toJSON() as unknown as { geojson: string }).geojson) as GeoJSON.Geometry);
}

/**
 * 逆ジオコーディング。指定した座標を含む行政区域を返す。
 *
 * ポリゴンとの包含判定 (ST_Contains) は重いので、先に bbox 列で候補を絞る。
 * bbox はGeoParquet生成時に書き込んである covering 列で、
 * これがあるおかげで全国データ (12万件) でも実用的な速度で返る。
 */
async function reverseGeocode(
  conn: duckdb.AsyncDuckDBConnection,
  lon: number,
  lat: number,
): Promise<{ label: string; adminId: string } | null> {
  const result = await conn.query(`
    SELECT pref_name || coalesce(county_name, '') || coalesce(city_name, '')
             || coalesce(ward_name, '') AS label,
           admin_id
    FROM admin
    WHERE bbox.xmin <= ${lon} AND bbox.xmax >= ${lon}
      AND bbox.ymin <= ${lat} AND bbox.ymax >= ${lat}
      AND ST_Contains(geometry, ST_Point(${lon}, ${lat}))
    LIMIT 1;
  `);
  const rows = result.toArray();
  if (rows.length === 0) return null;
  const row = rows[0].toJSON() as unknown as { label: string; admin_id: string };
  return { label: row.label, adminId: row.admin_id };
}

async function fetchAdminPolygon(
  conn: duckdb.AsyncDuckDBConnection,
  adminId: string,
): Promise<{ geojson: GeoJSON.Geometry; bbox: [number, number, number, number] } | null> {
  const result = await conn.query(`
    SELECT ST_AsGeoJSON(ST_Union_Agg(geometry)) AS geojson,
           min(bbox.xmin) AS xmin, min(bbox.ymin) AS ymin,
           max(bbox.xmax) AS xmax, max(bbox.ymax) AS ymax
    FROM admin
    WHERE admin_id = '${adminId}';
  `);
  const rows = result.toArray();
  if (rows.length === 0) return null;
  const row = rows[0].toJSON() as {
    geojson: string | null;
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  };
  if (!row.geojson) return null;
  return {
    geojson: JSON.parse(row.geojson) as GeoJSON.Geometry,
    bbox: [row.xmin, row.ymin, row.xmax, row.ymax],
  };
}

/**
 * 出典表示のリンク。
 *
 * 国土交通省の利用約款も国土地理院の利用規約も、出典に当該ページのURLを求めている。
 * 表示義務のあるものなので、組み立ては1箇所に置く。
 */
function creditLink(url: string, label: string): string {
  return `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`;
}

// 国土地理院タイル。利用規約により出典表示 (attribution) が必須。
const GSI_TERMS_URL = 'https://maps.gsi.go.jp/development/ichiran.html';

/**
 * 選べる地図。**先頭が既定** (建物の出所と同じ流儀)。
 *
 * 出典はどれも「国土地理院」で同じなので、切り替えても出典表示は変えなくてよい。
 * 3種とも z18 までタイルがあることを実測で確かめてある (港区・高尾山)。
 * 地形を入れたときは航空写真の方が起伏が分かる。
 */
const BASEMAPS = [
  { id: 'pale', label: '淡色地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png' },
  { id: 'std', label: '標準地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png' },
  {
    id: 'photo',
    label: '航空写真',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
  },
] as const;

/**
 * 地形の標高タイル。
 *
 * Mapterhornの日本のソースは基盤地図情報 (数値標高モデル) で、1m・5m・10m版を持つ。
 * 測量法に基づく国土地理院長承認 (使用) はMapterhorn側が取得済み (R 7JHs 542) で、
 * こちらは配信されているタイルを実行時に読むだけなので、地理院タイルを
 * ベースマップに使っているのと同じ立場になる (出典表示のみ)。
 *
 * PLATEAUのCityGMLにも地形モデル (TINRelief) が同梱されているが、実測すると
 * 三角形の辺が5.00mと7.08m (=5×√2) しか無く、**5mグリッドを三角形に割っただけ**
 * だった。情報量は5mラスタと同じで、港区の4メッシュだけで展開後960MBある。
 * 表示のためにこれをラスタタイルへ焼く工程を持つ意味がないので使わない。
 */
const TERRAIN_TILEJSON_URL = 'https://tiles.mapterhorn.com/tilejson.json';

const GSI_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    gsi: {
      type: 'raster',
      // 切り替えは setTiles でURLだけ差し替える。tileSize も maxzoom も出典も
      // 3種で共通なので、ソースを作り直す必要がない。
      tiles: [BASEMAPS[0].url],
      tileSize: 256,
      maxzoom: 18,
      attribution: creditLink(GSI_TERMS_URL, '国土地理院'),
    },
    terrain: {
      type: 'raster-dem',
      // tiles / encoding (terrarium) / tileSize / attribution は tilejson から読ませる。
      // 個別に書き写すと、向こうが変えたときに黙ってずれる。
      url: TERRAIN_TILEJSON_URL,
      // tilejson が maxzoom を宣言していないのに、実際は z16 までしか無い
      // (z17以降は404)。明示しないと建物を見るズームで404を撃ち続ける。
      maxzoom: 16,
    },
  },
  layers: [
    {
      id: 'gsi-basemap',
      type: 'raster',
      source: 'gsi',
    },
  ],
  // ここに terrain を書かないこと。スタイルに書くと地形タイルの取得が
  // map の 'load' の条件に入り、**Mapterhornが落ちていると起動できなくなる**
  // (読み込み中の表示から進まない)。読み込み後に setTerrain で有効にする。
};

/**
 * 建物の塗り (既定)。**高さで塗り分ける。** 傾けずに見るときも高さが分かるようにするため。
 * 高さを持たないデータ (Overtureはほぼ全件がそう) では既定色のままになる。
 *
 * **出所で色相を分ける。** PLATEAUとOvertureは同時に出せるので、
 * 重なったところでどちらの建物かが見分けられないと困る。
 * カタログで先頭の出所 (`palette` 0) が青、それ以外が橙。
 */
const BUILDING_COLOR_BY_HEIGHT: ExpressionSpecification = [
  'match',
  ['get', 'palette'],
  0,
  [
    'case',
    ['==', ['get', 'height'], null],
    '#4a6785',
    ['interpolate', ['linear'], ['get', 'height'], 0, '#c6d4e4', 20, '#8fabc9', 60, '#4a6785', 150, '#2d3f52'],
  ],
  [
    'case',
    ['==', ['get', 'height'], null],
    '#c77d3a',
    ['interpolate', ['linear'], ['get', 'height'], 0, '#f0cfa8', 20, '#e0a669', 60, '#c77d3a', 150, '#8a4f1c'],
  ],
];

/**
 * 建物の塗り (重要度で色分けするとき)。**重要な段ほど目立たせ、住宅・その他は退かせる。**
 *
 * 出所の色相 (青・橙) より段を優先する。重要なものを探すときは、どちらの出所かより
 * どの段かが知りたい (出所はホバーで分かる)。段の無い出所 (`tierRank` -1) は
 * 高さの塗りに落とす。
 */
const BUILDING_COLOR_BY_TIER: ExpressionSpecification = [
  'match',
  ['get', 'tierRank'],
  0,
  '#c0392b',
  1,
  '#e09a3e',
  2,
  '#d5d9de',
  BUILDING_COLOR_BY_HEIGHT,
];

const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

/**
 * 地図を生成し、スタイルのロードとハイライト用レイヤーの追加が終わるまで待つ。
 *
 * 出典表示はカタログから組み立てる。どのデータセットを配信するかはカタログ次第なので、
 * ここに書き並べると実際に使っているものとずれる。表示義務のある出典が抜けるのは
 * ライセンス違反になるため、データ側に追随させる。
 */
/**
 * 出典表示が下端から占めている高さを測り、CSS変数 `--attribution-space` に入れる。
 *
 * **出典は出所が増えるほど行が増える。** 人口メッシュ (47都道府県) を足したときに
 * 1行から2行になり、全幅40pxに広がって左下の「建物のある範囲へ移動」を覆った
 * (押せなくなった)。いまはたたんであるが、広げれば452×112pxの箱になる。
 * パネルの位置を固定値で避けると、出所を足すたびに破れる。
 *
 * **高さではなく「下端からどこまで」を測る。** 出典の箱の下にはMapLibreが
 * 余白を入れるので、高さだけで避けると余白のぶん足りない (実測で2px重なった)。
 *
 * 出典そのものは縮めない。表示義務があるので、避けるのはこちらの役目。
 */
function watchAttributionHeight(map: MapLibreMap): void {
  const container = map.getContainer();
  const attribution = container.querySelector<HTMLElement>('.maplibregl-ctrl-attrib');
  if (!attribution) return;
  const apply = () => {
    const space = container.getBoundingClientRect().bottom - attribution.getBoundingClientRect().top;
    document.documentElement.style.setProperty(
      '--attribution-space',
      `${Math.ceil(space)}px`,
    );
  };
  new ResizeObserver(apply).observe(attribution);
  apply();
}

/**
 * 出典をたたんだ状態から始める。
 *
 * MapLibreは `compact` でも**初回だけ広げた状態**で出す。出所が6件あるこのアプリでは
 * 418×230pxの箱になり、右下のパネルを押し上げてしまう。ⓘ を押せば出るので、
 * 最初からたたんでおく。
 *
 * 広げ閉じはMapLibreがクラスの付け外しでやっているので、こちらも外して合わせる。
 */
function collapseAttribution(map: MapLibreMap): void {
  map
    .getContainer()
    .querySelector('.maplibregl-ctrl-attrib')
    ?.classList.remove('maplibregl-compact-show');
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
function groupCredits(collections: Collection[]): {
  titles: string[];
  attribution: string;
  url: string;
  via: string[];
  vintages: string[];
  terms: Terms | undefined;
  /** サブカタログの題名 (PLATEAU など)。出所の一覧表の見出しに使う。 */
  group: string | undefined;
}[] {
  const byAttribution = new Map<
    string,
    {
      url: string;
      titles: string[];
      via: string[];
      vintages: string[];
      terms: Terms | undefined;
      group: string | undefined;
    }
  >();
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
    .map(([attribution, { url, titles, via, vintages, terms, group }]) => ({
      titles,
      attribution,
      url,
      via,
      vintages,
      terms,
      group,
    }));
}

/**
 * 規約の要約 (`duck:terms`)。パイプラインの `catalog::Terms` と同じ形。
 * **規約の本文が正本で、これは要約。** 画面には必ず本文へのリンクを添える。
 */
interface Terms {
  name: string;
  url: string;
  commercial: 'allowed' | 'not_restricted' | 'non_commercial';
  attribution_required: boolean;
  note_modification: boolean;
  share_alike: boolean;
}

/** 規約の要約をバッジにする。**「可」と言い切れないものは言い切らない。** */
function termsBadges(terms: Terms): HTMLElement {
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

function buildDataCredits(collections: Collection[]): string[] {
  return groupCredits(collections).map(
    ({ titles, attribution, url }) =>
      `<span class="credit"><b>${titles.join('・')}</b> ${creditLink(url, attribution)}</span>`,
  );
}

/** 外部へのリンク。別タブで開き、参照元を渡さない。 */
function externalLink(href: string, label: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = label;
  return link;
}

/**
 * 出典をパネルにも出す。**地図右下の ⓘ とは別に持つ。**
 *
 * MapLibreは出典の間を `" | "` のテキストで繋ぐので、1件ずつ改行させられない
 * (ブロックにすると区切りだけの行ができる)。結果として ⓘ の中身は1行に詰まり、
 * どれが何の出典なのか目で追いにくい。
 *
 * ⓘ は表示義務を果たす標準の置き場所として残し、**読ませるのはこちら**。
 * 地形 (Mapterhorn) のようにTileJSONから来る出典はカタログに無いので、
 * ⓘ の側が引き続き唯一の出どころになる。
 */
/**
 * **使うときの条件の一覧表。** 出所ごとに1行で、商用可か・出典表示・加工の明記・継承を並べる。
 * 出典の文言を1つずつ読まなくても、何に使えるかが一目で分かるようにする。
 */
function renderTermsSummary(container: HTMLElement, collections: Collection[]): void {
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

function renderCredits(container: HTMLElement, collections: Collection[]): void {
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
 * PLATEAU GIS Converter の README の謝辞 (Planetiler の手法を参考にした旨)
 * に倣った。
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
        use: '指した場所がどの市区町村かを調べる空間関数',
        url: 'https://github.com/duckdb/duckdb-spatial',
      },
      {
        name: 'MapLibre GL JS',
        who: 'MapLibre · BSD-3-Clause',
        use: '地図と建物の立体の描画',
        url: 'https://github.com/maplibre/maplibre-gl-js',
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
        name: 'PMTiles',
        who: 'Protomaps',
        use: '解像度ごとにファイルを分けず、1つのファイルに収める考え方。粗い段を別ファイルにしなかったのはこれに倣った',
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
function renderTechCredits(container: HTMLElement): void {
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
}

function initMap(collections: Collection[]): Promise<MapLibreMap> {
  const map = new MapLibreMap({
    container: 'map',
    style: GSI_STYLE,
    center: [139.767, 35.681],
    zoom: 9,
    // 既定の出典表示を止め、カタログ由来の出典を足したものに差し替える。
    attributionControl: false,
  });
  // **たたんで出す。** 出所が増えるほど文言が伸びるので、広げたままだと
  // 地図の下端を何行も占める (人口メッシュを足しただけで1行から2行になり、
  // 左下のボタンを覆った)。ⓘ を押せば全文が出る。
  map.addControl(
    new AttributionControl({ compact: true, customAttribution: buildDataCredits(collections) }),
  );
  collapseAttribution(map);
  watchAttributionHeight(map);
  // 建物を立体で描くので、傾きを操作する手段を出しておく。
  // visualizePitch を付けるとコンパスが傾きも表し、クリックで方位と傾きが
  // 0に戻る。つまり「2Dに戻す」手段が標準で付いてくるので、自前で切り替えUIを持たない。
  // 左上は検索欄、右下は出典表示があるので右上に置く。
  map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
  // 地形を切る手段。平野部では起伏が無く、タイルを読むだけになる場面もある。
  // MapLibreに標準で付いてくるので、自前のトグルは作らない。
  map.addControl(new TerrainControl({ source: 'terrain' }), 'top-right');

  map.on('error', (e) => console.error('[map] error', e.error ?? e));

  return new Promise((resolve) => {
    map.on('load', () => {
      // 人口メッシュは一番下に敷く。判断の背景であって、主役ではない。
      map.addSource('population-mesh', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'population-mesh-fill',
        type: 'fill',
        source: 'population-mesh',
        paint: {
          // 色はSORAの iGRC の区切りで段を切る (`IGRC_BANDS`)。
          // 連続的なグラデーションにすると「濃い/薄い」しか読めない。
          'fill-color': ['get', 'color'],
          // 下の地図 (地名や道路) が透けて見える濃さにする。
          // 判断に使うのは色の段であって、塗りつぶしそのものではない。
          'fill-opacity': 0.55,
        },
      });

      // 道路は人口メッシュの上、鉄道の下。**鉄道より下に敷く**のは、
      // 交差点で鉄道の方が見えてほしいため (踏切と立体交差の区別は付かないが、
      // 線路の連続性が切れる方が読みにくい)。
      // 送電線・川。道路の下に敷く (道路の方が細かく読まれるため)。
      // 種別ごとに1組。見せ方は `LINE_STYLES` (川は実線、送電線は破線)。
      for (const kind of LINE_KINDS) {
        const style = LINE_STYLES[kind];
        map.addSource(`line-${kind}`, { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
        map.addLayer({
          id: `line-${kind}`,
          type: 'line',
          source: `line-${kind}`,
          paint: {
            'line-color': style.color,
            'line-width': ['interpolate', ['linear'], ['zoom'], 6, style.width * 0.6, 14, style.width * 1.6],
            'line-opacity': 0.85,
            ...(style.dash ? { 'line-dasharray': style.dash } : {}),
          },
          layout: { 'line-cap': 'round', 'line-join': 'round' },
        });
      }

      map.addSource('road', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'road-line',
        type: 'line',
        source: 'road',
        // 色と太さは引くときに決めてしまう (`ROAD_STYLES`)。鉄道と同じ作り。
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['get', 'width'],
          'line-opacity': 0.9,
        },
      });

      // 鉄道は人口メッシュの上、建物の下。メッシュの色が透けて読める濃さにする。
      map.addSource('railway', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'railway-line',
        type: 'line',
        source: 'railway',
        // 色は引くときに決めてしまう (`RAILWAY_COLORS`)。人口メッシュと同じく、
        // スタイル式で分岐を組むより凡例と同じ表から作る方がずれない。
        paint: {
          'line-color': ['get', 'color'],
          // 引いたときに線が潰れないよう、ズームで太さを変える。
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 12, 2, 16, 3.5],
          'line-opacity': 0.9,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });

      // 駅も線 (原典がホームの延長を線で持っている) なので、太さと白い縁取りで
      // 路線と区別する。点に潰すと原典より情報が減る。
      map.addSource('railway-stations', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'railway-station-casing',
        type: 'line',
        source: 'railway-stations',
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 11],
        },
        layout: { 'line-cap': 'round' },
      });
      map.addLayer({
        id: 'railway-station',
        type: 'line',
        source: 'railway-stations',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 7],
        },
        layout: { 'line-cap': 'round' },
      });

      // 建物はハイライトより先に追加して、下に敷く。
      // 出典表示はカタログ由来のものが上の AttributionControl に入っている。
      map.addSource('buildings', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      // 立体 (fill-extrusion) で描く。平面用と2枚持たないのは、傾き0度なら
      // 真上から見ることになり、平面塗りとほとんど同じに見えるため。
      // 2Dに戻したいときは NavigationControl のコンパスで傾きを0にする。
      map.addLayer({
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'buildings',
        paint: {
          // 既定は高さで塗る。「重要度で色分けする」を入れると段で塗る
          // (`BUILDING_COLOR_BY_TIER` に差し替える)。
          'fill-extrusion-color': BUILDING_COLOR_BY_HEIGHT,
          // 高さが無い建物にも既定値を与える。0にすると描画されず、
          // Overtureは高さが1.5%しか入っていないのでほぼ全部消えてしまう。
          'fill-extrusion-height': ['coalesce', ['get', 'height'], 3],
          // **地盤標高を入れないこと。** 地形が有効なとき、MapLibreは
          // get_elevation(重心) を base と height の両方に加算する
          // (fill_extrusion.vertex.glsl)。base は地形面からの相対値なので、
          // ここに海抜を入れると二重に足して建物が空へ飛ぶ。
          'fill-extrusion-base': 0,
          // 1未満にすると面同士が透けて見える描画崩れが出るので、下地を
          // わずかに透かす程度に留める。
          'fill-extrusion-opacity': 0.9,
        },
      });

      // 建物の整備範囲。引くと建物そのものは消えるので、どこにデータがあるかを
      // 1kmのメッシュで示す。偶然その場所へ行かないと機能に気づけない、という状態を避ける。
      map.addSource('buildings-coverage', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'buildings-coverage-fill',
        type: 'fill',
        source: 'buildings-coverage',
        paint: {
          'fill-color': '#4a6785',
          // **充足率で濃淡を付ける。** 建物の数で濃くすると人口密集部が濃くなる
          // だけなので使わない。束ねた1kmセルのうち何割にデータがあるかで塗る。
          //
          // **低い側を広く取り、底を上げる。** 直線の傾斜にすると、80kmメッシュで
          // 数セルしか無いところ (6400分の数) が事実上見えなくなる。実測では
          // 80kmの平均充足率は7.2%しかないので、そこが消えると意味が逆転する。
          // 「少しはある」と「全く無い」は別物なので、**描かれる限り必ず見える**
          // 0.12を下限にする。8桁 (1km) では必ず1なので一様に塗られる。
          'fill-opacity': [
            'interpolate',
            ['linear'],
            ['get', 'ratio'],
            0,
            0.12,
            0.05,
            0.18,
            0.25,
            0.26,
            1,
            0.36,
          ],
        },
      });
      map.addLayer({
        id: 'buildings-coverage-outline',
        type: 'line',
        source: 'buildings-coverage',
        paint: {
          'line-color': '#4a6785',
          'line-width': 1.5,
          // 縁は薄く。3万セルの縁を濃く引くと網目が潰れて塗りが読めない。
          'line-opacity': 0.3,
        },
      });

      // 周辺検索の範囲 (起点から○m) と、範囲に入った建物。ハイライトの下に敷く。
      map.addSource('nearby-zone', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
      map.addLayer({
        id: 'nearby-zone-fill',
        type: 'fill',
        source: 'nearby-zone',
        paint: { 'fill-color': '#ff6600', 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: 'nearby-zone-line',
        type: 'line',
        source: 'nearby-zone',
        paint: { 'line-color': '#ff6600', 'line-width': 1.5, 'line-dasharray': [2, 1] },
      });
      map.addSource('nearby-hits', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
      map.addLayer({
        id: 'nearby-hits',
        type: 'fill',
        source: 'nearby-hits',
        // 重要度で色分けと同じ色。段の無い出所は橙。
        paint: {
          'fill-color': ['match', ['get', 'tierRank'], 0, '#c0392b', 1, '#e09a3e', 2, '#8a94a0', '#ff6600'],
          'fill-opacity': 0.75,
          'fill-outline-color': '#ffffff',
        },
      });

      map.addSource('highlight', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'highlight-fill',
        type: 'fill',
        source: 'highlight',
        // **ポリゴンのときだけ塗る。** ソースは行政区域 (ポリゴン) と
        // 路線 (線) で使い回していて、MapLibre の fill は**線のジオメトリも
        // 閉じた輪とみなして塗ってしまう**。東海道線のように品川〜武蔵小杉〜鶴見と
        // 品川〜川崎〜鶴見が輪を作る路線では、線の内側が丸ごと橙色になる。
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#ff6600', 'fill-opacity': 0.35 },
      });
      map.addLayer({
        id: 'highlight-casing',
        type: 'line',
        source: 'highlight',
        // **白で縁取ってから橙を載せる。** 路線を選ぶと線そのものがここに入るが、
        // 鉄道レイヤーを出していると同じような太さの色線が並び、橙だけでは
        // どれが選んだ路線か分からない。白の縁があると下地の色から浮く。
        paint: { 'line-color': '#ffffff', 'line-width': 9 },
      });
      map.addLayer({
        id: 'highlight-outline',
        type: 'line',
        source: 'highlight',
        // **破線にする。** 鉄道レイヤーの線と色だけで見分けさせると、
        // 色の見え方によっては区別がつかない。形が違えば色に頼らずに済む。
        paint: { 'line-color': '#ff6600', 'line-width': 5, 'line-dasharray': [1.6, 1.1] },
      });

      // 行政区域データ(N03)は市区町村・行政区までしか持たないため、
      // 丁目を選んでもポリゴンは区全体になる。どの丁目を選んだかは
      // 位置参照情報の代表点(ポイント)で示す。
      map.addSource('selected-point', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'selected-point-circle',
        type: 'circle',
        source: 'selected-point',
        paint: {
          'circle-radius': 7,
          'circle-color': '#d94500',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });
      // 地形は最後に有効にする。ここまで来ていれば、以降タイルが取れなくても
      // 起伏が出ないだけで地図は使える。起動を外部サービスに握らせない。
      map.setTerrain({ source: 'terrain', exaggeration: 1 });
      resolve(map);
    });
  });
}

async function main() {
  const input = document.querySelector<HTMLInputElement>('#search-input')!;
  const resultsEl = document.querySelector<HTMLUListElement>('#results')!;
  const clearButton = document.querySelector<HTMLButtonElement>('#clear-button')!;
  const pickButton = document.querySelector<HTMLButtonElement>('#pick-location')!;
  const nearbyButton = document.querySelector<HTMLButtonElement>('#nearby-button')!;
  const nearbyPanel = document.querySelector<HTMLDivElement>('#nearby-panel')!;
  const nearbyDistance = document.querySelector<HTMLSelectElement>('#nearby-distance')!;
  const nearbyOriginEl = document.querySelector<HTMLParagraphElement>('#nearby-origin')!;
  const nearbyResultsEl = document.querySelector<HTMLDivElement>('#nearby-results')!;
  const nearbyFromSearch = document.querySelector<HTMLButtonElement>('#nearby-from-search')!;
  const loadingEl = document.querySelector<HTMLDivElement>('#loading')!;
  const loadingMessageEl = document.querySelector<HTMLParagraphElement>('#loading-message')!;
  const busyEl = document.querySelector<HTMLDivElement>('#busy')!;
  const busyLabelEl = document.querySelector<HTMLSpanElement>('#busy-label')!;
  const basemapSelect = document.querySelector<HTMLSelectElement>('#basemap')!;
  const buildingsSection = document.querySelector<HTMLDivElement>('#buildings-section')!;
  const filtersEl = document.querySelector<HTMLDivElement>('#building-filters')!;
  const heightField = document.querySelector<HTMLDivElement>('#height-field')!;
  const usageField = document.querySelector<HTMLDivElement>('#usage-field')!;
  const minHeightInput = document.querySelector<HTMLInputElement>('#min-height')!;
  const minHeightValue = document.querySelector<HTMLOutputElement>('#min-height-value')!;
  const usageOptionsEl = document.querySelector<HTMLDivElement>('#usage-options')!;
  const tierField = document.querySelector<HTMLDivElement>('#tier-field')!;
  const tierOptionsEl = document.querySelector<HTMLDivElement>('#tier-options')!;
  const tierColorToggle = document.querySelector<HTMLInputElement>('#tier-color')!;
  const usageAllButton = document.querySelector<HTMLButtonElement>('#usage-all')!;
  const usageNoneButton = document.querySelector<HTMLButtonElement>('#usage-none')!;
  const buildingCountEl = document.querySelector<HTMLParagraphElement>('#building-count')!;
  const railwaySectionEl = document.querySelector<HTMLDivElement>('#railway-section')!;
  const railwayTypesEl = document.querySelector<HTMLDivElement>('#railway-types')!;
  const railwayAllButton = document.querySelector<HTMLButtonElement>('#railway-all')!;
  const railwayNoneButton = document.querySelector<HTMLButtonElement>('#railway-none')!;
  const railwaySummaryEl = document.querySelector<HTMLParagraphElement>('#railway-summary')!;
  let railwayTypeInputs: HTMLInputElement[] = [];
  const roadSectionEl = document.querySelector<HTMLDivElement>('#road-section')!;
  const roadClassesEl = document.querySelector<HTMLDivElement>('#road-classes')!;
  const roadAllButton = document.querySelector<HTMLButtonElement>('#road-all')!;
  const roadNoneButton = document.querySelector<HTMLButtonElement>('#road-none')!;
  const roadSummaryEl = document.querySelector<HTMLParagraphElement>('#road-summary')!;
  let roadClassInputs: HTMLInputElement[] = [];

  const meshSectionEl = document.querySelector<HTMLDivElement>('#mesh-section')!;

  // レイヤー一覧まわり。**データは節を積まずに1データ1行で並べる** —
  // 種別ごとに `<details>` を足していくと、オープンデータが増えるだけ縦に伸びる。
  const layerListEl = document.querySelector<HTMLDivElement>('#layer-list')!;
  const layerRowsEl = document.querySelector<HTMLDivElement>('#layer-rows')!;
  const layerAbsentEl = document.querySelector<HTMLDivElement>('#layer-absent')!;
  const layerAbsentRowsEl = document.querySelector<HTMLDivElement>('#layer-absent-rows')!;
  const layerSupportEl = document.querySelector<HTMLDivElement>('#layer-support')!;
  const layerSupportRowsEl = document.querySelector<HTMLDivElement>('#layer-support-rows')!;
  const layerSettingsEl = document.querySelector<HTMLDivElement>('#layer-settings')!;
  const layerSettingsTitleEl = document.querySelector<HTMLParagraphElement>(
    '#layer-settings-title',
  )!;
  const layerSettingsBodyEl = document.querySelector<HTMLDivElement>('#layer-settings-body')!;
  const layerCatalogEl = document.querySelector<HTMLDivElement>('#layer-catalog')!;
  const openStac = createStacViewer(document.querySelector<HTMLDialogElement>('#stac-viewer')!);
  const layerBackButton = document.querySelector<HTMLButtonElement>('#layer-back')!;
  const aircraftSelect = document.querySelector<HTMLSelectElement>('#aircraft-class')!;
  const meshLegendBody = document.querySelector<HTMLTableSectionElement>('#mesh-legend tbody')!;
  const meshSummaryEl = document.querySelector<HTMLParagraphElement>('#mesh-summary')!;
  const creditsEl = document.querySelector<HTMLDListElement>('#credits')!;
  // 技術の謝辞はカタログに依らないので、初期化を待たずに出す (失敗しても読める)。
  renderTechCredits(document.querySelector<HTMLDivElement>('#tech-credits')!);

  // 出典・使っている技術のダイアログ。右下のパネルは幅が狭く、長い文言が細切れに
  // 折り返して読めないので、押したらダイアログで広く出す。
  for (const button of document.querySelectorAll<HTMLButtonElement>('.info-open')) {
    const dialog = document.getElementById(button.dataset.dialog!) as HTMLDialogElement;
    button.addEventListener('click', () => dialog.showModal());
  }
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('.info-dialog')) {
    dialog.querySelector('.info-dialog-close')!.addEventListener('click', () => dialog.close());
    // 背景を押したら閉じる (中身は内側の要素にあるので、dialog自身が的になるのは背景だけ)。
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  // DuckDB-WASMの初期化とParquetの読み込みには数秒かかるので、
  // 準備が終わるまでは操作できないことが分かるようにしておく。
  loadingMessageEl.textContent = '地図とデータベースを準備中…';
  let conn: duckdb.AsyncDuckDBConnection;
  let exportParquet: (select: string, kv: Record<string, string>) => Promise<Uint8Array>;
  let registerFiles: (files: string[]) => Promise<void>;
  let map: MapLibreMap;
  let buildingSources: BuildingSource[] = [];
  let meshSources: MeshSource[] = [];
  let railwaySources: RailwaySource[] = [];
  let railwayInstitutionTypes: string[] = [];
  let railwayVintage: string | undefined;
  let roadSource: RoadSource | undefined;
  let lineSources: LineSource[] = [];
  let roadClasses: string[] = [];
  let roadVintage: string | undefined;
  let ensureRoutes: (() => Promise<void>) | undefined;
  let ensureSpatial: () => Promise<void>;
  let ensureOaza: () => Promise<void>;
  let ensureStations: (() => Promise<void>) | undefined;
  let ensureSections: (() => Promise<void>) | undefined;
  let collections: Collection[] = [];
  try {
    collections = await fetchCollections();
    const [db, createdMap] = await Promise.all([
      initDuckDb(collections),
      initMap(collections),
    ]);
    conn = db.conn;
    exportParquet = db.exportParquet;
    registerFiles = db.registerFiles;
    buildingSources = db.buildingSources;
    meshSources = db.meshSources;
    railwaySources = db.railwaySources;
    railwayInstitutionTypes = db.railwayInstitutionTypes;
    railwayVintage = db.railwayVintage;
    roadSource = db.roadSource;
    lineSources = db.lineSources;
    roadClasses = db.roadClasses;
    roadVintage = db.roadVintage;
    ensureRoutes = db.ensureRoutes;
    ({ ensureSpatial, ensureOaza, ensureStations, ensureSections } = db);
    map = createdMap;
    renderCredits(creditsEl, collections);
    renderTermsSummary(document.querySelector<HTMLDivElement>('#terms-summary')!, collections);
  } catch (e) {
    console.error('[init] failed', e);
    loadingEl.innerHTML = '<p>初期化に失敗しました。コンソールを確認してください。</p>';
    return;
  }
  // E2Eテストから地図の状態 (ハイライトされている地物など) を検証したり、
  // データの実際のURLを知るための足がかり。アプリ本体はこれを参照しない。
  // dataUrl を公開しているのは、データが別オリジン (オブジェクトストレージ) に
  // 移っても、テスト側を書き換えずに公開URLへ流せるようにするため。
  (window as unknown as TestHooks).__map = map;

  loadingEl.hidden = true;

  // 操作できるようになった後、使われそうなものを裏で用意しておく。
  // 待たないので操作は妨げないが、実際に使うころには済んでいることが多い。
  // (用意していないと、最初の検索やクリックでその場の待ち時間になる)
  void ensureOaza().catch((e: unknown) => console.error('[warmup] oaza', e));
  void ensureSpatial().catch((e: unknown) => console.error('[warmup] spatial', e));
  input.disabled = false;
  pickButton.disabled = false;
  nearbyButton.disabled = false;
  input.focus();

  // 地図の切り替え。出典も maxzoom も tileSize も3種で同じなので、
  // ソースを作り直さずURLだけ差し替える。
  //
  // 地形の入切とは連動させない。自分で選んだものが別の操作で勝手に変わるのは、
  // 逆ジオコーディングを📍ボタンにしたときに取り除いた感覚と同じになる。
  for (const basemap of BASEMAPS) {
    const option = document.createElement('option');
    option.value = basemap.id;
    option.textContent = basemap.label;
    basemapSelect.append(option);
  }
  basemapSelect.value = BASEMAPS[0].id;
  basemapSelect.addEventListener('change', () => {
    const basemap = BASEMAPS.find((b) => b.id === basemapSelect.value);
    if (!basemap) return;
    (map.getSource('gsi') as RasterTileSource | undefined)?.setTiles([basemap.url]);
  });

  // 初期化のオーバーレイ (#loading) は上で消えるが、その後も数秒かかる操作がある。
  // 操作を先に触れる作りにしている以上、「触れる」と「終わっている」を
  // 見分ける手がかりが要る。
  //
  // 同時に複数走っても消えないよう、真偽値ではなく件数で持つ。
  let busyCount = 0;
  let failureTimer: ReturnType<typeof setTimeout> | undefined;

  const busy = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    busyCount += 1;
    clearTimeout(failureTimer);
    busyEl.classList.remove('failed');
    busyLabelEl.textContent = label;
    busyEl.hidden = false;
    try {
      return await run();
    } finally {
      busyCount -= 1;
      if (busyCount === 0) busyEl.hidden = true;
    }
  };

  /**
   * 失敗を画面にも出す。コンソールに残すのとは別の役割で、
   * console.error だけだと利用者には「何も起きない」としか見えない。
   */
  const showFailure = (message: string) => {
    console.error('[failure]', message);
    clearTimeout(failureTimer);
    busyLabelEl.textContent = message;
    busyEl.classList.add('failed');
    busyEl.hidden = false;
    // 出したままにすると次の操作の邪魔になる。他の処理が走っていなければ引っ込める。
    failureTimer = setTimeout(() => {
      if (busyCount > 0) return;
      busyEl.hidden = true;
      busyEl.classList.remove('failed');
    }, 5000);
  };

  // MapLibre v6 の setData は Promise を返す (v5までは同期)。await しないと
  // データ適用の完了を待てず、エラーも握り潰されるので必ず待つ。
  const setSourceData = async (sourceId: string, geometry: GeoJSON.Geometry | null) => {
    const source = map.getSource(sourceId) as GeoJSONSource | undefined;
    if (!source) return;
    await source.setData(
      geometry ? { type: 'Feature', properties: {}, geometry } : EMPTY_FEATURE_COLLECTION,
    );
  };

  // 逆ジオコーディングの結果を出すポップアップ。1つを使い回す。
  //
  // closeOnClick を切ってあるのは、建物を見るつもりのクリックで結果が消えると、
  // 📍ボタン化して消したはずの「勝手に変わる」感覚が戻ってくるため。
  // 消すのは×かEscだけにする。
  // **判定の結果はホバーと見分けられるようにする。** 2つとも吹き出しなので、
  // クラスが無いと「どちらが押した場所のものか」が中身を読むまで分からない
  // (テストからも区別できない)。
  const popup = new Popup({ closeButton: true, closeOnClick: false, className: 'result-popup' });

  // ハイライトとポップアップは1つの結果なので、片方を閉じたら両方消す。
  const clearHighlight = () => {
    Promise.all([setSourceData('highlight', null), setSourceData('selected-point', null)]).catch(
      (e: unknown) => console.error('[clearHighlight] failed', e),
    );
  };
  popup.on('close', clearHighlight);

  const clearSearch = () => {
    input.value = '';
    resultsEl.innerHTML = '';
    clearButton.hidden = true;
    // 開いていれば close が飛んで clearHighlight も走るが、開いていないときの
    // ために自分でも消す (どちらも繰り返して困らない)。
    popup.remove();
    clearHighlight();
    input.focus();
  };

  /** 路線の端から端まで入るように寄せる。鉄道と道路で同じ。 */
  const fitToBbox = ([west, south, east, north]: Bbox) => {
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      // パネルが左下と右下にあるので、下側を多めに空ける。
      { padding: { top: 60, bottom: 120, left: 60, right: 60 }, duration: 1500 },
    );
  };

  const showResult = async (result: SearchResult) => {
    // 路線は点ではなく**範囲**。端から端まで入るように寄せる。
    //
    // **線そのものをハイライトする。** 範囲へ動かすだけだと、鉄道レイヤーを
    // 出しているときに「どれが選んだ路線か」が分からない。
    if (result.kind === 'line') {
      await setSourceData('selected-point', null);
      if (ensureSections) {
        await busy('路線を読み込み中…', async () => {
          await ensureSections();
          const parts = await fetchLineGeometry(
            conn,
            result.lineName,
            result.operator,
            result.bbox,
          );
          const geometry = toMultiLineString(parts);
          await setSourceData('highlight', geometry);
          if (geometry) rememberSelection(result.label, geometry);
        });
      }
      fitToBbox(result.bbox);
      return;
    }

    // 道路の路線も同じ扱い。**出所は違うが見せ方は変わらない** ので、
    // ハイライトも寄せ方も鉄道と揃える。
    if (result.kind === 'route') {
      await setSourceData('selected-point', null);
      if (ensureRoutes) {
        await busy('道路を読み込み中…', async () => {
          await ensureRoutes();
          const parts = await fetchRouteGeometry(conn, result.routeName, result.bbox);
          const geometry = toMultiLineString(parts);
          await setSourceData('highlight', geometry);
          if (geometry) rememberSelection(result.label, geometry);
        });
      }
      fitToBbox(result.bbox);
      return;
    }

    // 地名(代表点しか無い)と駅はその地点へ飛ぶ。ポリゴンは消す。
    if (result.kind === 'oaza' || result.kind === 'station') {
      const point: GeoJSON.Point = { type: 'Point', coordinates: [result.lon, result.lat] };
      await Promise.all([setSourceData('highlight', null), setSourceData('selected-point', point)]);
      rememberSelection(result.label, point);
      map.flyTo({ center: [result.lon, result.lat], zoom: 16, duration: 1500 });
      return;
    }

    // 行政区域は面をハイライトして全体が入るように寄る。
    // ポリゴン取得を待たずにカメラを動かすと、後から呼ぶ fitBounds が
    // アニメーションを横取りしてしまうので、取得を終えてから1回だけ動かす。
    //
    // 逆ジオコーディングでは名前が先に出るので、ここが無言だと
    // 「地名だけ出てポリゴンが出ない」ように見える。大きい自治体ほど重い
    // (対馬市で70,848頂点) ので、待っていることを知らせる。
    const polygon = await busy('範囲を読み込み中…', async () => {
      await ensureSpatial();
      return fetchAdminPolygon(conn, result.adminId);
    });
    if (!polygon) {
      console.warn('admin polygon not found for admin_id', result.adminId);
      showFailure('範囲を取得できませんでした');
      return;
    }

    await Promise.all([
      setSourceData('highlight', polygon.geojson),
      setSourceData('selected-point', null),
    ]);
    rememberSelection(result.label, polygon.geojson);
    map.fitBounds(
      [
        [polygon.bbox[0], polygon.bbox[1]],
        [polygon.bbox[2], polygon.bbox[3]],
      ],
      { padding: 40, duration: 1500 },
    );
  };

  const renderResults = (rows: SearchResult[]) => {
    resultsEl.innerHTML = '';

    // 何も出さないと一覧ごと消えて (#results:empty)、読み込み中と区別がつかない。
    // 地名は収録した都道府県の分しか無いので、この状態には普通に到達する。
    if (rows.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '該当する地名がありません';
      resultsEl.appendChild(li);
      return;
    }

    for (const row of rows) {
      const li = document.createElement('li');
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = {
        admin: '行政区域',
        oaza: '地名',
        station: '駅',
        line: '路線',
        route: '道路',
      }[
        row.kind
      ];
      li.append(badge, row.label);
      // **会社名と路線名は2段目に置く。**1行に詰めると
      //「東京駅 (東日本旅客鉄道 東北新幹線)」のように長くなって読みにくい。
      if ('detail' in row && row.detail) {
        const detail = document.createElement('span');
        detail.className = 'result-detail';
        detail.textContent = row.detail;
        li.append(detail);
      }
      li.addEventListener('click', () => {
        resultsEl.innerHTML = '';
        input.value = row.label;
        showResult(row).catch((e: unknown) => console.error('[showResult] failed', e));
      });
      resultsEl.appendChild(li);
    }
  };

  let debounceTimer: number | undefined;
  const runSearch = (debounceMs: number) => {
    window.clearTimeout(debounceTimer);
    const keyword = input.value.trim();
    clearButton.hidden = keyword.length === 0;
    if (keyword.length === 0) {
      resultsEl.innerHTML = '';
      return;
    }
    debounceTimer = window.setTimeout(() => {
      // 初回は ensureOaza の読み込みを待つので、ここだけ数秒かかることがある。
      busy('検索中…', async () => {
        // 駅は配信されていないこともある。無ければ地名と行政区域だけで引く。
        await Promise.all([ensureOaza(), ensureStations?.(), ensureRoutes?.()]);
        const [places, stations, lines, routes] = await Promise.all([
          searchAddress(conn, keyword),
          ensureStations ? searchStations(conn, keyword) : Promise.resolve([]),
          ensureStations ? searchLines(conn, keyword) : Promise.resolve([]),
          ensureRoutes ? searchRoutes(conn, keyword) : Promise.resolve([]),
        ]);
        // **打った語がそのものを指しているものを先に出す。**
        // 「山手線」で駅ばかり並ぶと、路線を見たい人の役に立たない。
        // 「東京」なら東京駅が先に来てほしい。
        const exactLines = lines.filter((l) => l.label.includes(keyword));
        const exactStations = stations.filter((s) => s.label.startsWith(`${keyword}駅`));
        const rest = stations.filter((s) => !exactStations.includes(s));
        // **道路は数が多いので、打った語そのもの以外は後ろに回して上限を掛ける。**
        // 「東京」には109路線が当たり、候補10件を道路が埋めて
        // 東京駅も東京都も消えた。「国道13号」のように語そのものを指すものは先頭。
        const exactRoutes = routes.filter((r) => r.label === keyword);
        const otherRoutes = routes
          .filter((r) => r.label !== keyword)
          .slice(0, ROUTE_SUGGESTIONS);
        return [
          ...exactRoutes,
          ...exactLines,
          ...exactStations,
          ...places,
          ...otherRoutes,
          ...rest,
        ].slice(0, MAX_RESULTS);
      })
        .then(renderResults)
        .catch((e: unknown) => {
          console.error('[searchAddress] failed', e);
          showFailure('検索に失敗しました');
        });
    }, debounceMs);
  };

  /**
   * 「検索に使用」を出すかどうか。**打っている間だけ出す。**
   *
   * 常時出しておくと検索欄が200pxまで伸びて左上の地図を覆い、
   * クリックが届かなくなる (実測156px)。かといってフォーカスだけを条件にすると、
   * **起動時に検索欄へ自動でフォーカスが当たる**ので結局出っぱなしになる。
   */
  input.addEventListener('input', () => runSearch(200));
  // 候補を選ぶと一覧を閉じるので、再びフォーカスしたときに候補を出し直す。
  // (入力を変えないと候補が出ないのは分かりにくい)
  input.addEventListener('focus', () => runSearch(0));
  input.addEventListener('blur', () => {
    resultsEl.innerHTML = '';
  });
  // 候補のクリックは blur より先に mousedown が走る。既定動作を止めて
  // フォーカスを外させないと、click が発火する前に一覧が消えてしまう。
  resultsEl.addEventListener('mousedown', (e) => e.preventDefault());

  clearButton.addEventListener('click', clearSearch);

  // ---- 行の状態 --------------------------------------------------------------
  //
  // 件数や「ズーム15まで寄ると出ます」は**一覧の行に出す**。設定の中に置くと、
  // 開かない限り出ない理由が読めない。
  //
  // **行はCollectionなので、状態もCollection IDで持つ。** 以前は設定パネルの
  // 要約を監視して行へ写していたが、建物がPLATEAUとOvertureの2行になると
  // 要約1つでは足りない。
  /** いまの表示範囲。傾けたときの中心は bounds の中心とずれるので、地図から直接もらう。 */
  const currentBounds = (): ViewBounds => {
    const b = map.getBounds();
    const c = map.getCenter();
    return {
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
      centerLon: c.lng,
      centerLat: c.lat,
    };
  };

  const layerStatus = new Map<string, string>();
  const setLayerStatus = (id: string, text: string) => {
    layerStatus.set(id, text);
    for (const el of document.querySelectorAll(`[data-layer-status="${id}"]`)) {
      el.textContent = text;
    }
  };

  /**
   * 表示量。建物・鉄道・道路の上限とズームの閾値がここから決まる。
   *
   * 建物は `buildingsMinZoom` から原寸 (都市ごとのファイル・全件) を読む。
   * **これより引いても隠さない** — 整備範囲をメッシュで出す。
   */
  let detail: DetailSettings = DETAIL_LEVELS[loadDetailLevel()];
  let buildingsToken = 0;

  /**
   * 設定パネルを向けている出所。**描く出所とは別。**
   *
   * 描くのは一覧でONになっているもの全部 (PLATEAUとOvertureを同時に出せる)。
   * ここが決めるのは、共有している設定パネルの中身 (絞り込み・件数・移動ボタン)
   * をどちらに向けるかだけ。どちらかの ⚙ を押すと切り替わる。
   */
  let settingsSource: BuildingSource | undefined = buildingSources[0];
  /**
   * 絞り込み。**出所ごとに持つ。** 用途の語彙が出所ごとに違う
   * (PLATEAUは「商業施設」、Overtureは `commercial`) ので、共有すると意味が変わる。
   */
  const filters = new Map<string, BuildingFilter>(
    buildingSources.map((source) => [source.id, { minHeight: 0, usages: null, tiers: null }]),
  );
  const filterOf = (source: BuildingSource): BuildingFilter => filters.get(source.id)!;

  /** 行の状態に書き、パネルを開いている出所なら件数の欄にも出す。 */
  const showBuildingStatus = (source: BuildingSource, text: string) => {
    setLayerStatus(source.id, text);
    if (source === settingsSource) buildingCountEl.textContent = text;
  };

  /**
   * 一覧でONになっている出所の建物を引き直す。
   *
   * **出所ごとに引いて1つのソースにまとめる。** 地物に `origin` (Collection ID) を
   * 持たせて塗り分けるので、地図のレイヤーは出所が増えても1組のまま。
   * 上限は出所ごとに掛かる (両方ONなら最大で2倍描く)。
   */
  const refreshBuildings = async () => {
    const mapSource = map.getSource('buildings') as GeoJSONSource | undefined;
    const coverage = map.getSource('buildings-coverage') as GeoJSONSource | undefined;
    if (!mapSource || buildingSources.length === 0) return;

    const visible = buildingSources.filter((source) => isLayerVisible(source.id));
    // 取得を始める前に件数表示を空にする。引いていたときの「拡大すると建物が出ます」が
    // 残っていると、すでに寄っている利用者に拡大しろと言い続けることになる。
    for (const source of buildingSources) showBuildingStatus(source, '');

    if (visible.length === 0) {
      await coverage?.setData(EMPTY_FEATURE_COLLECTION);
      await mapSource.setData(EMPTY_FEATURE_COLLECTION);
      return;
    }

    const zoom = map.getZoom();
    const token = ++buildingsToken;
    const bounds = currentBounds();

    // 状態は最後にまとめて出す。途中で打ち切ったとき (地図が動いた) に
    // 片方の出所だけ新しい件数が出る、という食い違いを作らない。
    const statuses: [BuildingSource, string][] = [];

    // **出所ごとに、このズームでどこまで出すかを決める** ([`buildingDepth`])。
    // 全部 / 重要な段だけ (間引き) / 整備範囲のメッシュ、の3通り。
    const depths = new Map(visible.map((source) => [source, buildingDepth(source, zoom)]));

    // **引いた表示では整備範囲を出す** (段で間引いても出せないほど引いたとき)。
    // 建物そのものは、簡略化はフットプリントが1px未満で効かず、高さで選ぶのは
    // 基準に意味を持たせられなかった。代わりに「どこまで整備されているか」を出す。
    const coverageFeatures: GeoJSON.Feature[] = [];
    for (const source of visible) {
      if (depths.get(source) !== null) continue;
      if (!source.coverage) {
        // 整備範囲を持たない出所は、引いた表示では何も描かない。
        // **どこまで寄れば出るかを数字で言う。**
        statuses.push([source, `ズーム${firstVisibleZoom(source)}まで寄ると出ます`]);
        continue;
      }
      const area = source.coverage;
      // 配られているより細かくはできない。引くほど粗く束ねる。
      const digits = Math.min(meshDigits(zoom), area.meshDigits);
      const cells = await busy('整備範囲を読み込み中…', async () => {
        await area.ensure();
        return fetchCoverageInView(conn, area, bounds, digits);
      });
      if (token !== buildingsToken) return;
      coverageFeatures.push(...coverageFeatureCollection(cells).features);
      const buildings = cells.reduce((total, cell) => total + cell.buildings, 0);
      statuses.push([
        source,
        `整備範囲 ${cells.length.toLocaleString()} メッシュ` +
          ` (${MESH_SIZE_LABELS[digits] ?? `${digits}桁`}) · ` +
          `建物 ${buildings.toLocaleString()} 棟 · ズーム${firstVisibleZoom(source)}から建物そのもの`,
      ]);
    }
    await coverage?.setData({ type: 'FeatureCollection', features: coverageFeatures });

    const features: GeoJSON.Feature[] = [];
    for (const source of visible) {
      const depth = depths.get(source);
      if (depth === null || depth === undefined) continue;
      const rows = await busy('建物を読み込み中…', async () => {
        await source.ensure();
        return fetchBuildingsInView(
          conn,
          source,
          bounds,
          filterOf(source),
          detail.buildingsLimit,
          depth === 'all' ? undefined : depth,
        );
      });
      if (token !== buildingsToken) return;

      for (const row of rows) {
        features.push({
          type: 'Feature',
          properties: {
            name: row.name,
            category: row.category,
            height: row.height,
            // **どの出所の建物か。** ホバーの「出所」に使う。
            origin: source.id,
            // 塗り分けの番号。IDを塗りの式に書くと出所が増えたときに直す場所が
            // 分かれるので、カタログに並んだ順番で渡す。
            palette: buildingSources.indexOf(source),
            // **重要度の段。** 名前はホバー用、順位は色分け用 (0がいちばん重要)。
            // 段の無い出所では -1 にして、色分けでも既定の塗りに落とす。
            tier: source.tiers?.tiers.find((t) => t.id === row.tier)?.title ?? null,
            tierRank: source.tiers?.tiers.findIndex((t) => t.id === row.tier) ?? -1,
          },
          geometry: row.geojson,
        });
      }
      const count =
        rows.length >= detail.buildingsLimit
          ? `${detail.buildingsLimit}件以上 (表示上限)`
          : `${rows.length}件`;
      // **間引いているときは、どこまで出しているかを言う。** 黙って減らすと
      // 「住宅が無い」と読まれてしまう。
      const thinned =
        depth === 'all'
          ? ''
          : ` · ${source
              .tiers!.tiers.slice(0, depth + 1)
              .map((t) => t.title)
              .join('・')}のみ (ズーム${detail.buildingsMinZoom}ですべて)`;
      statuses.push([source, count + thinned + sourceLodNote(source, bounds)]);
    }
    await mapSource.setData({ type: 'FeatureCollection', features });
    for (const [source, text] of statuses) showBuildingStatus(source, text);
  };

  /**
   * このズームで建物をどこまで出すか。`'all'` = 全部、数字 = その順位の段まで (間引き)、
   * `null` = 建物は出さない (整備範囲を出すか、寄れと言う)。
   *
   * **1ズーム引くごとに1段減らす。** 画面の面積は1ズームで4倍になるので、
   * 段を1つ落とすことで読む量を抑える。実測 (東京駅・1280×720):
   * z13 で公共施設だけなら1.0万棟・1.9MB (全部なら22万棟・31MB)、
   * z14 で商業・業務までなら1.7万棟・2.5MB。
   * 段の列 (`lod_column`) を持たない出所は間引けないので、全部か無しか。
   */
  const buildingDepth = (source: BuildingSource, zoom: number): 'all' | number | null => {
    const steps = Math.ceil(detail.buildingsMinZoom - zoom);
    if (steps <= 0) return 'all';
    const tiers = source.tiers;
    if (!tiers?.lod_column) return null;
    const rank = tiers.tiers.length - 1 - steps;
    return rank >= 0 ? rank : null;
  };

  /** その出所の建物が出始めるズーム (間引いた段を含む)。 */
  const firstVisibleZoom = (source: BuildingSource): number =>
    source.tiers?.lod_column
      ? detail.buildingsMinZoom - (source.tiers.tiers.length - 1)
      : detail.buildingsMinZoom;

  const requestRefresh = () => {
    refreshBuildings().catch((e: unknown) => {
      console.error('[buildings] failed', e);
      showFailure('建物の読み込みに失敗しました');
    });
  };

  // ---- 人口密度 (SORAの地上リスク) ----

  /** 選んでいる機体の区分。iGRC表の列にあたる。 */
  let aircraftIndex = 0;
  let meshToken = 0;

  /** 凡例を作り直す。機体を変えると iGRC の値が変わる。 */
  const renderLegend = () => {
    meshLegendBody.replaceChildren();
    // 密度が高い側を上に出す。危ない方から目に入る並びにする。
    for (const band of [...IGRC_BANDS].reverse()) {
      const row = document.createElement('tr');
      const range = document.createElement('td');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = band.color;
      range.append(swatch, document.createTextNode(band.label));

      const igrc = document.createElement('td');
      const value = band.igrc[aircraftIndex];
      if (value === null) {
        igrc.className = 'out-of-scope';
        igrc.textContent = '範囲外';
        igrc.title = 'SORAの適用範囲外';
      } else {
        igrc.textContent = String(value);
      }
      row.append(range, igrc);
      meshLegendBody.append(row);
    }
  };

  /** いま地図にメッシュを載せているか。空を載せ直す無駄を避けるために持つ。 */
  let meshShown = false;

  const refreshMesh = async () => {
    const mapSource = map.getSource('population-mesh') as GeoJSONSource | undefined;
    if (!mapSource) return;

    /**
     * メッシュを消す。**既に空なら何もしない。**
     *
     * `moveend` は地図を動かすたびに飛ぶので、消えている状態で毎回 `setData` を
     * 呼ぶと、空のデータをワーカーへ往復させ続けることになる。建物の描画と
     * 同じワーカーを使うため、そこの取り合いになる。
     */
    const clear = async (message: string) => {
      if (meshShown) {
        await mapSource.setData(EMPTY_FEATURE_COLLECTION);
        meshShown = false;
      }
      meshSummaryEl.textContent = message;
    };

    // 行は細かさ違いのCollectionを束ねた1つで、IDは先頭のもの (一覧側と同じ規則)。
    if (!isLayerVisible(meshSources[0]?.id ?? '')) {
      await clear('');
      return;
    }

    const zoom = map.getZoom();
    const digits = meshDigits(zoom);
    // 要求する細かさを出せる出所が無ければ出せない。125mしか配っていない状態で
    // 引くと、これに当たる代わりに125mから束ねることになっていた。
    const source = meshSourceFor(meshSources, digits);
    if (!source) {
      await clear('この縮尺の人口密度は配信されていません');
      return;
    }

    const token = ++meshToken;
    const cells = await busy('人口密度を読み込み中…', async () => {
      await source.ensure();
      const b = map.getBounds();
      const c = map.getCenter();
      return fetchMeshInView(
        conn,
        source,
        {
          west: b.getWest(),
          south: b.getSouth(),
          east: b.getEast(),
          north: b.getNorth(),
          centerLon: c.lng,
          centerLat: c.lat,
        },
        digits,
      );
    });
    if (token !== meshToken) return;

    meshShown = true;
    await mapSource.setData({
      type: 'FeatureCollection',
      features: cells.map(({ code, population, density }) => {
        // 矩形はメッシュコードから計算する。中に入っている子のbboxの和で描くと、
        // 人のいる子だけを囲った細長い形になり、メッシュに見えなくなる。
        const [west, south, east, north] = meshBounds(code);
        return {
          type: 'Feature',
          // 色は引くときに決めてしまう。スタイル式で段を組むより、
          // 凡例と同じ一つの表 (`IGRC_BANDS`) から作る方がずれない。
          properties: { population, density, color: igrcBand(density).color },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
              ],
            ],
          },
        };
      }),
    });

    // **表示範囲の最大値を出す。** SORAは運航範囲の中で最も密度の高いところを採るので、
    // 地図から目で探させるより数字で出す方が確実。
    if (cells.length === 0) {
      meshSummaryEl.textContent = 'この範囲に人口メッシュがありません';
      return;
    }
    const peak = cells.reduce((max, cell) => Math.max(max, cell.density), 0);
    const band = igrcBand(peak);
    const igrc = band.igrc[aircraftIndex];
    const size = MESH_SIZE_LABELS[digits] ?? `${digits}桁`;
    meshSummaryEl.textContent =
      `${size}メッシュ / 表示範囲の最大 ${Math.round(peak).toLocaleString()} 人/km² ` +
      `(iGRC ${igrc === null ? '範囲外' : igrc})`;
  };

  const requestMeshRefresh = () => {
    refreshMesh().catch((e: unknown) => {
      console.error('[mesh] failed', e);
      showFailure('人口密度の読み込みに失敗しました');
    });
  };

  /**
   * 鉄道を引き直す。
   *
   * **ズームで隠さない。** 路線のジオメトリ列は原寸で4.5MBあって全国を一度に
   * 読むと起動時の転送量 (1.5MB) を超えるが、**引いたときは粗い段 (`lod = 0`) を
   * 引く**ので全国597本・329KBで足りる。
   *
   * **駅には段が無い。** 点に近い短い線なので簡略化しても縮まない。
   * 表示範囲で絞るだけで足りる (全国で2.2万件・821KB)。
   */
  // 1回に描く上限は `detail.railwayLimit`。路線と駅の合計ではなく、それぞれに掛かる。
  let railwayToken = 0;
  let railwayShown = false;

  const refreshRailway = async () => {
    const lineSource = map.getSource('railway') as GeoJSONSource | undefined;
    const stationSource = map.getSource('railway-stations') as GeoJSONSource | undefined;
    if (!lineSource || !stationSource) return;

    // メッシュと同じく、既に空なら何もしない。`moveend` ごとに空データを
    // ワーカーへ往復させると、建物の描画と同じワーカーを取り合うことになる。
    const clear = async (message: string) => {
      if (railwayShown) {
        await lineSource.setData(EMPTY_FEATURE_COLLECTION);
        await stationSource.setData(EMPTY_FEATURE_COLLECTION);
        railwayShown = false;
      }
      railwaySummaryEl.textContent = message;
      for (const source of railwaySources) setLayerStatus(source.id, '');
    };

    // **路線と駅は別のCollectionなので、一覧でも別の行。** ONの方だけを引く。
    // 絞り込み (事業者種別) と設定パネルは両方で共有する。
    const visibleSources = railwaySources.filter((source) => isLayerVisible(source.id));
    if (visibleSources.length === 0) {
      await clear('');
      return;
    }

    const selectedTypes = [...railwayTypeInputs]
      .filter((input) => input.checked)
      .map((input) => input.value);

    const token = ++railwayToken;
    const results = await busy('鉄道を読み込み中…', async () => {
      const b = map.getBounds();
      const c = map.getCenter();
      const bounds: ViewBounds = {
        west: b.getWest(),
        south: b.getSouth(),
        east: b.getEast(),
        north: b.getNorth(),
        centerLon: c.lng,
        centerLat: c.lat,
      };
      return Promise.all(
        visibleSources.map(async (source) => {
          await source.ensure();
          return {
            kind: source.kind,
            features: await fetchRailwayInView(
              conn,
              source,
              bounds,
              railwayInstitutionTypes.length > 0 ? selectedTypes : null,
              detail.railwayLimit,
              // 駅には段が無いので、そちらは undefined が返って条件が付かない。
              lodForZoom(source, map.getZoom()),
            ),
          };
        }),
      );
    });
    if (token !== railwayToken) return;

    const toGeoJson = (features: RailwayFeature[]): GeoJSON.FeatureCollection => ({
      type: 'FeatureCollection',
      features: features.map((feature) => ({
        type: 'Feature',
        properties: {
          // 色は引くときに決める (凡例と同じ表から作る)。
          color: RAILWAY_COLORS[feature.institutionType] ?? RAILWAY_FALLBACK_COLOR,
          lineName: feature.lineName,
          operator: feature.operator,
          institutionType: feature.institutionType,
          railwayClass: feature.railwayClass,
          stationName: feature.stationName,
        },
        geometry: feature.geojson,
      })),
    });

    const lines = results.find((r) => r.kind === 'railway')?.features ?? [];
    const stations = results.find((r) => r.kind === 'railway_station')?.features ?? [];

    railwayShown = true;
    await lineSource.setData(toGeoJson(lines));
    await stationSource.setData(toGeoJson(stations));

    // 行ごとの状態。**出していない方は空にする** (前の件数が残らないように)。
    for (const source of railwaySources) {
      if (!visibleSources.includes(source)) {
        setLayerStatus(source.id, '');
        continue;
      }
      const features = source.kind === 'railway' ? lines : stations;
      setLayerStatus(
        source.id,
        features.length === 0
          ? 'この範囲にありません'
          : `${features.length.toLocaleString()} ${source.kind === 'railway' ? '本' : '駅'}` +
              lodNote(source, lodForZoom(source, map.getZoom())) +
              (features.length >= detail.railwayLimit ? ' (表示上限)' : ''),
      );
    }

    if (lines.length === 0 && stations.length === 0) {
      railwaySummaryEl.textContent = 'この範囲に鉄道がありません';
      return;
    }
    const capped = lines.length >= detail.railwayLimit || stations.length >= detail.railwayLimit;
    const lineSourceInfo = visibleSources.find((source) => source.kind === 'railway');
    railwaySummaryEl.textContent =
      `路線 ${lines.length.toLocaleString()} / 駅 ${stations.length.toLocaleString()}` +
      (lineSourceInfo ? lodNote(lineSourceInfo, lodForZoom(lineSourceInfo, map.getZoom())) : '') +
      (capped ? ' (上限に達しました。拡大すると全部出ます)' : '');
  };

  /**
   * 道路を引き直す。
   *
   * **ズームで隠さない。** 幹線だけで65.6万区間あり、原寸を引いた画面に出すと
   * 9.4MB転送になって線で埋まるが、**引いたときは粗い段 (`lod = 0`) を引く**ので
   * 全国でも高速1,360本・483KBで足りる。どのズームでどちらを引くかは
   * [`lodForZoom`] がデータの許容誤差から決める。
   */
  // 1回に描く上限は `detail.roadLimit`。
  let roadToken = 0;
  let roadShown = false;

  /**
   * 等級ごとに、**どのズームから出すか**。
   *
   * **簡略化だけでは足りない。** 粗い段で転送量は収まるが、全国の都道府県道
   * 4,609本を一度に描くと画面が線で埋まって何も読めず、細い線が重なるので
   * ツールチップも拾うたびに移り変わる。**引いたら幹線だけにする。**
   *
   * 高速はズーム0から出す (全国の骨格として読めるし、1,360本しかない)。
   * これは標準の値で、表示量の設定 (`detail.roadClassZoomShift`) でずらす。
   */
  const ROAD_CLASS_MIN_ZOOM: Record<string, number> = {
    motorway: 0,
    trunk: 8,
    primary: 10,
  };

  /** 表示量の設定を反映した、その等級が出るズーム。0より下げない。 */
  const roadClassMinZoom = (cls: string): number =>
    Math.max(0, (ROAD_CLASS_MIN_ZOOM[cls] ?? 0) - detail.roadClassZoomShift);

  /** このズームで出す等級。選ばれているもののうち、出してよいものだけ。 */
  const roadClassesForZoom = (selected: string[], zoom: number): string[] =>
    selected.filter((cls) => zoom >= roadClassMinZoom(cls));

  const refreshRoads = async () => {
    const source = map.getSource('road') as GeoJSONSource | undefined;
    if (!source || !roadSource) return;

    const clear = async (message: string) => {
      if (roadShown) {
        await source.setData(EMPTY_FEATURE_COLLECTION);
        roadShown = false;
      }
      roadSummaryEl.textContent = message;
    };

    if (!isLayerVisible(roadSource.id)) {
      await clear('');
      return;
    }

    const selectedClasses = [...roadClassInputs]
      .filter((input) => input.checked)
      .map((input) => input.value);

    const zoom = map.getZoom();
    // **引いたら幹線だけにする。** 選んであっても、そのズームで読めない等級は出さない。
    const shownClasses = roadClassesForZoom(selectedClasses, zoom);
    const heldBack = selectedClasses.length - shownClasses.length;

    const lod = lodForZoom(roadSource, zoom);
    const token = ++roadToken;
    const features = await busy('道路を読み込み中…', async () => {
      await roadSource.ensure();
      const b = map.getBounds();
      const c = map.getCenter();
      return fetchRoadsInView(
        conn,
        roadSource,
        {
          west: b.getWest(),
          south: b.getSouth(),
          east: b.getEast(),
          north: b.getNorth(),
          centerLon: c.lng,
          centerLat: c.lat,
        },
        shownClasses,
        detail.roadLimit,
        lod,
      );
    });
    if (token !== roadToken) return;

    roadShown = true;
    await source.setData({
      type: 'FeatureCollection',
      features: features.map((feature) => {
        const style = ROAD_STYLES[feature.roadClass];
        return {
          type: 'Feature',
          properties: {
            color: style?.color ?? '#777777',
            width: style?.width ?? 1.5,
            roadName: feature.roadName,
            roadClass: style?.label ?? feature.roadClass,
            // ホバーで出すので、ここで読める形にしておく。
            routeNames: feature.routeNames.join(' / '),
          },
          geometry: feature.geojson,
        };
      }),
    });

    // **出していない等級があることを言う。** 黙って外すと「チェックしたのに
    // 出ない」ように見える。どのズームで出るかも数字で言う。
    const heldBackNote = () => {
      if (heldBack === 0) return '';
      const next = Math.min(
        ...selectedClasses
          .filter((cls) => !shownClasses.includes(cls))
          .map(roadClassMinZoom),
      );
      return ` · ${heldBack}種別はズーム${next}から`;
    };

    if (features.length === 0) {
      roadSummaryEl.textContent =
        (shownClasses.length === 0 ? '選んだ等級はこのズームでは出しません' : 'この範囲に道路がありません') +
        heldBackNote();
      return;
    }
    const capped = features.length >= detail.roadLimit;
    roadSummaryEl.textContent =
      `${features.length.toLocaleString()} ${lod === COARSE_LOD ? '本' : '区間'}` +
      lodNote(roadSource, lod) +
      heldBackNote() +
      (capped ? ' (上限に達しました。拡大すると全部出ます)' : '');
  };

  const requestRoadRefresh = () => {
    refreshRoads().catch((e: unknown) => {
      console.error('[road] failed', e);
      showFailure('道路の読み込みに失敗しました');
    });
  };

  // ---- 送電線・川 (名前と種別だけの線) -----------------------------------------
  //
  // 道路と同じく**ズームで隠さない**。引いた表示では粗い段 (名前・種別・タイルで
  // 束ねて簡略化したもの) を引く。上限は道路と共有する (同じ太さの線なので)。
  const lineTokens = new Map<string, number>();
  const lineShown = new Set<string>();

  const refreshLine = async (source: LineSource) => {
    const mapSource = map.getSource(`line-${source.kind}`) as GeoJSONSource | undefined;
    if (!mapSource) return;
    if (!isLayerVisible(source.id)) {
      if (lineShown.has(source.id)) {
        await mapSource.setData(EMPTY_FEATURE_COLLECTION);
        lineShown.delete(source.id);
      }
      setLayerStatus(source.id, '');
      return;
    }
    const zoom = map.getZoom();
    const lod = lodForZoom(source, zoom);
    const token = (lineTokens.get(source.id) ?? 0) + 1;
    lineTokens.set(source.id, token);
    const features = await busy(`${source.title}を読み込み中…`, async () => {
      await source.ensure();
      return fetchLinesInView(conn, source, currentBounds(), detail.roadLimit, lod);
    });
    if (lineTokens.get(source.id) !== token) return;

    lineShown.add(source.id);
    await mapSource.setData({
      type: 'FeatureCollection',
      features: features.map((feature) => ({
        type: 'Feature',
        properties: {
          name: feature.name,
          lineClass: LINE_CLASS_LABELS[feature.lineClass] ?? feature.lineClass,
          origin: source.id,
        },
        geometry: feature.geojson,
      })),
    });
    const capped = features.length >= detail.roadLimit;
    setLayerStatus(
      source.id,
      features.length === 0
        ? 'この範囲にありません'
        : `${features.length.toLocaleString()} ${lod === COARSE_LOD ? '本' : '区間'}` +
            lodNote(source, lod) +
            (capped ? ' (表示上限)' : ''),
    );
  };

  const requestLineRefresh = (source: LineSource) => () => {
    refreshLine(source).catch((e: unknown) => {
      console.error('[line] failed', source.id, e);
      showFailure(`${source.title}の読み込みに失敗しました`);
    });
  };
  for (const source of lineSources) map.on('moveend', requestLineRefresh(source));

  const requestRailwayRefresh = () => {
    refreshRailway().catch((e: unknown) => {
      console.error('[railway] failed', e);
      showFailure('鉄道の読み込みに失敗しました');
    });
  };

  if (railwaySources.length > 0) {

    // 選択肢はカタログの語彙から作る。色見本を添えて、地図の色と対応付ける。
    for (const type of railwayInstitutionTypes) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = type;
      input.checked = true;
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = RAILWAY_COLORS[type] ?? RAILWAY_FALLBACK_COLOR;
      label.append(input, swatch, document.createTextNode(type));
      railwayTypesEl.append(label);
    }
    railwayTypeInputs = [...railwayTypesEl.querySelectorAll<HTMLInputElement>('input')];
    for (const input of railwayTypeInputs) {
      input.addEventListener('change', requestRailwayRefresh);
    }
    const setAll = (checked: boolean) => {
      for (const input of railwayTypeInputs) input.checked = checked;
      requestRailwayRefresh();
    };
    railwayAllButton.addEventListener('click', () => setAll(true));
    railwayNoneButton.addEventListener('click', () => setAll(false));

    map.on('moveend', requestRailwayRefresh);
  }

  if (roadSource) {
    // 鉄道と同じ作り。**等級はカタログの語彙から**来るので、順番だけ
    // ROAD_STYLES に沿わせる (高速 → 国道 → 都道府県道)。
    const ordered = Object.keys(ROAD_STYLES).filter((cls) => roadClasses.includes(cls));
    const rest = roadClasses.filter((cls) => !(cls in ROAD_STYLES));
    for (const cls of [...ordered, ...rest]) {
      const style = ROAD_STYLES[cls];
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = cls;
      input.checked = true;
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = style?.color ?? '#777777';
      label.append(input, swatch, document.createTextNode(style?.label ?? cls));
      roadClassesEl.append(label);
    }
    roadClassInputs = [...roadClassesEl.querySelectorAll<HTMLInputElement>('input')];
    for (const input of roadClassInputs) {
      input.addEventListener('change', requestRoadRefresh);
    }
    const setAllRoads = (checked: boolean) => {
      for (const input of roadClassInputs) input.checked = checked;
      requestRoadRefresh();
    };
    roadAllButton.addEventListener('click', () => setAllRoads(true));
    roadNoneButton.addEventListener('click', () => setAllRoads(false));

    map.on('moveend', requestRoadRefresh);
  }

  if (meshSources.length > 0) {
    for (const [index, { label }] of AIRCRAFT_CLASSES.entries()) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = label;
      aircraftSelect.append(option);
    }
    renderLegend();

    // 機体を変えても地図の色は変わらない (色は密度の帯で決まる)。
    // 変わるのは凡例と要約に出る iGRC の値だけなので、引き直さない。
    aircraftSelect.addEventListener('change', () => {
      aircraftIndex = Number(aircraftSelect.value);
      renderLegend();
      requestMeshRefresh();
    });
    map.on('moveend', requestMeshRefresh);
  }

  // ---- レイヤー一覧 -------------------------------------------------------
  //
  // **カタログの階層をそのまま一覧にする。** サブカタログ (PLATEAU / Overture Maps …)
  // が見出し、Collectionが行。以前は「建物」「道路」のように使う側から見た
  // まとまりで組んでいて、画面からカタログが見えなかった。
  //
  // 行とCollectionは**ほぼ1対1**。例外は2つだけ。
  // - 人口メッシュは細かさ違いのCollection (125m / 1km) をズームで選ぶので1行に束ねる
  // - 整備範囲は建物の「引いた姿」なので行にせず、建物の ⚙ の中に出す
  //   (`duck:covers` で結ばれている)
  interface Layer {
    /** 先頭のCollectionのID。**行とCollectionを同じ名前で呼ぶ。** */
    id: string;
    title: string;
    /** どのサブカタログの下か。一覧の見出しになる。 */
    group: CatalogGroup | undefined;
    /** この行を作っているCollection。⚙ で中身を見せる。 */
    collections: Collection[];
    vintage?: string;
    /** 収録範囲。**この場所にあるか**の判定に使う。複数Collectionなら和。 */
    bbox: Bbox | null;
    visible: boolean;
    /** 出るのに要るズーム。**無ければどの縮尺でも出る。** */
    minZoom?: number;
    /** 設定の中身。一覧から開いたときに出す。**複数の行で共有することがある。** */
    settings: HTMLElement;
    /** 共有している設定パネルを、この行に向ける。 */
    onOpen?: () => void;
    refresh: () => void;
    /**
     * 整備範囲。**あればこれで「この範囲にあるか」を決める** (箱より正確)。
     * 建物のうちメッシュを持つ出所 (PLATEAU) だけ。
     */
    coverage?: BuildingCoverage;
  }

  const byKind = (kind: DatasetKind) => collections.filter((c) => c.kind === kind);
  const bboxOf = (members: Collection[]) =>
    unionBbox(members.map((c) => c.bbox).filter((b): b is Bbox => b !== null));

  /** 建物の設定パネルをその出所に向ける。中身は建物の節 (下) で埋める。 */
  let pointBuildingSettings: (source: BuildingSource) => void = () => {};

  // **カタログに書かれた順に並べる。** 並びはパイプライン側 (`SUB_CATALOGS`) が決める。
  const layers: Layer[] = [];
  for (const collection of collections) {
    const base = {
      id: collection.id,
      title: collection.title,
      group: collection.group,
      collections: [collection],
      vintage: collection.vintage,
      bbox: collection.bbox,
      visible: false,
    };
    switch (collection.kind) {
      case 'plateau_buildings':
      case 'buildings': {
        const source = buildingSources.find((s) => s.id === collection.id);
        if (!source) break;
        const coverage = collections.find(
          (c) => c.kind === 'building_coverage' && c.covers === collection.id,
        );
        layers.push({
          ...base,
          collections: coverage ? [collection, coverage] : [collection],
          // **カタログで先頭の建物だけ既定で出す。** このアプリの出発点なので
          // 何か出ていてほしいが、両方出すと重なって描かれる。
          visible: source === buildingSources[0],
          minZoom: detail.buildingsMinZoom,
          settings: buildingsSection,
          onOpen: () => pointBuildingSettings(source),
          refresh: requestRefresh,
          coverage: source.coverage,
        });
        break;
      }
      case 'population_mesh': {
        // 細かさ違いを1行に束ねる。**描画側と同じく先頭のメッシュをIDにする。**
        const first = meshSources[0];
        if (!first || first.id !== collection.id) break;
        const members = byKind('population_mesh');
        layers.push({
          ...base,
          collections: members,
          bbox: bboxOf(members),
          settings: meshSectionEl,
          refresh: requestMeshRefresh,
        });
        break;
      }
      case 'railway':
      case 'railway_station':
        if (!railwaySources.some((s) => s.id === collection.id)) break;
        layers.push({
          ...base,
          // **「寄る」ボタンを出さない。** 引いた表示でも粗い段が出るので、
          // 寄らないと見えないものが無い。設定 (事業者種別) は路線と駅で共有する。
          settings: railwaySectionEl,
          refresh: requestRailwayRefresh,
        });
        break;
      case 'road':
        if (roadSource?.id !== collection.id) break;
        // 鉄道と同じく「寄る」ボタンは出さない。
        layers.push({ ...base, settings: roadSectionEl, refresh: requestRoadRefresh });
        break;
      case 'power_line':
      case 'waterway': {
        const source = lineSources.find((s) => s.id === collection.id);
        if (!source) break;
        // 絞り込みが無いので、設定の中身は空 (⚙ ではCollectionの中身だけが出る)。
        const settings = document.createElement('div');
        layers.push({ ...base, settings, refresh: requestLineRefresh(source) });
        break;
      }
      default:
        // 検索の裏方と整備範囲は行にしない (「検索できるもの」と建物の ⚙ に出る)。
        break;
    }
  }

  const isLayerVisible = (id: string) => layers.find((l) => l.id === id)?.visible ?? false;

  // 設定はパネルの中身を入れ替えて出す。**取り外さない** — 外すと
  // 参照は生きていてもDOMから消え、CSSもテストのセレクタも当たらなくなる。
  for (const layer of layers) {
    layer.settings.hidden = true;
    layerSettingsBodyEl.append(layer.settings);
  }

  const showLayerList = () => {
    layerSettingsEl.hidden = true;
    layerListEl.hidden = false;
  };

  /** 配信しているJSONそのものへのリンク。**カタログが実在することを見せる。** */
  const jsonLink = (path: string | undefined, label: string): HTMLElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'json-link';
    button.textContent = label;
    button.title = 'STACの文書を見る';
    button.disabled = !path;
    // **ページの中で開く** (`openStac`)。生のJSONへ飛ばすと地図から離れる。
    if (path) button.addEventListener('click', () => openStac(path));
    return button;
  };

  const formatBbox = ([west, south, east, north]: Bbox) =>
    `${west.toFixed(2)}, ${south.toFixed(2)} – ${east.toFixed(2)}, ${north.toFixed(2)}`;

  /**
   * Collection 1つぶんの中身。**カタログに書いてあることだけを出す。**
   *
   * 絞り込みだけでは、行の裏にあるのがどのCollectionで、何ファイルあって、
   * 元のJSONはどこか、が画面から辿れない。
   */
  /** 切り出しで書き出す行の上限。DuckDB-WASM のメモリの中にファイルを作るため。 */
  const MAX_EXPORT_ROWS = 300_000;

  /**
   * **この範囲を取得** — 3通り。
   *
   * 1. **この範囲の GeoParquet**: 表示範囲で切り出して保存する (ブラウザの中で書く)。
   *    出典と規約を KV メタデータに入れて、切り出したファイルにも条件が付いて回るようにする
   * 2. **ファイルごと**: 範囲に重なるファイル (配信している GeoParquet) と、その配布元
   * 3. **CityGML** (PLATEAUだけ): 公式の配信サービスで、表示範囲のメッシュ単位のGMLを
   *    直接リンクし、付属ファイル込みのZIPにもまとめられる (pack)
   *
   * 開いたときの表示範囲で作る (開くまで何も読まない)。
   */
  const downloadSection = (collection: Collection): HTMLElement => {
    const section = document.createElement('details');
    section.className = 'download-section';
    const summary = document.createElement('summary');
    summary.textContent = 'この範囲を取得';
    const body = document.createElement('div');
    section.append(summary, body);
    section.addEventListener('toggle', () => {
      if (section.open) void fillDownloads(collection, body);
    });
    return section;
  };

  const fillDownloads = async (collection: Collection, body: HTMLElement) => {
    body.replaceChildren(document.createTextNode('範囲のファイルを調べています…'));
    const bounds = currentBounds();
    const items = (await collection.items()).filter(({ feature }) => {
      const bbox = feature.bbox?.length === 4 ? (feature.bbox as Bbox) : null;
      return !bbox || bboxOverlaps(bbox, bounds);
    });
    const files = items.map(itemFile);
    body.replaceChildren();
    if (files.length === 0) {
      body.append('この範囲にはファイルがありません');
      return;
    }

    // 1. この範囲の GeoParquet。
    const status = document.createElement('p');
    status.className = 'download-status';
    const clip = document.createElement('button');
    clip.type = 'button';
    clip.className = 'download-clip';
    clip.textContent = 'この範囲を GeoParquet で保存';
    clip.addEventListener('click', () => {
      void (async () => {
        clip.disabled = true;
        try {
          status.textContent = '数えています…';
          await ensureSpatial();
          // 表示で使っていないファイルもあるので登録する (済んでいるものは何もしない)。
          await registerFiles(files);
          const list = files.map((file) => `'${file}'`).join(', ');
          // 線の粗い段 (統合・簡略化した行) は**原寸と重なる複製**なので書き出さない。
          // 建物の段 (lod) は行の振り分けで重複は無いが、配信の都合の列なので外す。
          const exact = collection.coarseLodToleranceM !== undefined ? `lod = ${EXACT_LOD} AND` : '';
          const exclude = collection.columns.has('lod') ? ' EXCLUDE (lod)' : '';
          const where = `${exact} bbox.xmin <= ${bounds.east} AND bbox.xmax >= ${bounds.west}
            AND bbox.ymin <= ${bounds.north} AND bbox.ymax >= ${bounds.south}`;
          const counted = await conn.query(`SELECT count(*) AS n FROM read_parquet([${list}]) WHERE ${where};`);
          const rows = Number((counted.toArray()[0].toJSON() as { n: number | bigint }).n);
          if (rows === 0) {
            status.textContent = 'この範囲にはありません';
            return;
          }
          if (rows > MAX_EXPORT_ROWS) {
            status.textContent = `${rows.toLocaleString()} 件あり、多すぎます (上限 ${MAX_EXPORT_ROWS.toLocaleString()} 件)。寄ってから保存してください`;
            return;
          }
          status.textContent = `${rows.toLocaleString()} 件を書き出しています…`;
          const bytes = await exportParquet(`SELECT *${exclude} FROM read_parquet([${list}]) WHERE ${where}`, {
            'duck:attribution': collection.attribution,
            'duck:terms': collection.terms ? `${collection.terms.name} ${collection.terms.url}` : collection.license,
            'duck:source': `${collection.id} (${dataUrl(collection.path)})`,
            'duck:clip_bbox': `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`,
            ...(collection.vintage ? { 'duck:vintage': collection.vintage } : {}),
          });
          saveBytes(bytes, `${collection.id}_${new Date().toISOString().slice(0, 10)}.parquet`);
          status.textContent = `${rows.toLocaleString()} 件・${formatBytes(bytes.length)} を保存しました (出典と規約をファイルのメタデータに入れています)`;
        } catch (e) {
          console.error('[download] failed', e);
          status.textContent = '書き出せませんでした';
        } finally {
          clip.disabled = false;
        }
      })();
    });
    body.append(clip, status);

    // 2. ファイルごと (配信している GeoParquet と配布元)。
    const fileList = document.createElement('ul');
    fileList.className = 'download-files';
    const shown = items.slice(0, 12);
    for (const item of shown) {
      const li = document.createElement('li');
      const ours = document.createElement('a');
      ours.href = dataUrl(itemFile(item));
      ours.textContent = item.feature.id;
      ours.download = '';
      li.append(ours);
      const via = item.feature.links?.find((link) => link.rel === 'via')?.href ?? collection.via;
      if (via) li.append(' · ', externalLink(via, '配布元'));
      fileList.append(li);
    }
    const fileHead = document.createElement('p');
    fileHead.className = 'download-head';
    fileHead.textContent =
      `ファイルごと (${items.length.toLocaleString()} 件` +
      (items.length > shown.length ? `、先頭 ${shown.length} 件を表示` : '') +
      ')';
    body.append(fileHead, fileList);

    // 3. CityGML (PLATEAU だけ)。
    if (collection.kind === 'plateau_buildings') body.append(cityGmlSection(bounds));
  };

  /** CityGML の取得。メッシュ単位の直リンクと、公式 pack の ZIP。 */
  const cityGmlSection = (bounds: ViewBounds): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'citygml-section';
    const head = document.createElement('p');
    head.className = 'download-head';
    head.textContent = 'CityGML (PLATEAU配信サービス)';
    const find = document.createElement('button');
    find.type = 'button';
    find.className = 'citygml-find';
    find.textContent = 'この範囲の CityGML を探す';
    const result = document.createElement('div');
    box.append(head, find, result);

    find.addEventListener('click', () => {
      void (async () => {
        const codes = meshCodesInView(bounds);
        if (!codes) {
          result.textContent = '範囲が広すぎます。寄ってから探してください';
          return;
        }
        find.disabled = true;
        result.textContent = '探しています…';
        try {
          const files = await fetchCityGmlFiles(codes);
          renderCityGml(result, files);
        } catch (e) {
          console.error('[citygml] failed', e);
          result.textContent = 'PLATEAU配信サービスから取れませんでした';
        } finally {
          find.disabled = false;
        }
      })();
    });
    return box;
  };

  const renderCityGml = (container: HTMLElement, files: CityGmlFile[]) => {
    container.replaceChildren();
    if (files.length === 0) {
      container.textContent = 'この範囲にはありません';
      return;
    }
    const types = [...new Set(files.map((f) => f.type))].sort(
      (a, b) => (a === 'bldg' ? -1 : b === 'bldg' ? 1 : a.localeCompare(b)),
    );
    const select = document.createElement('select');
    select.className = 'citygml-type';
    for (const type of types) {
      const option = document.createElement('option');
      option.value = type;
      const count = files.filter((f) => f.type === type).length;
      option.textContent = `${CITYGML_TYPES[type] ?? type} (${type}) · ${count} ファイル`;
      select.append(option);
    }
    const list = document.createElement('ul');
    list.className = 'citygml-files';
    const pack = document.createElement('button');
    pack.type = 'button';
    pack.className = 'citygml-pack';
    const packStatus = document.createElement('p');
    packStatus.className = 'download-status';

    const show = () => {
      const chosen = files.filter((f) => f.type === select.value);
      const total = chosen.reduce((sum, f) => sum + (f.fileSize ?? 0), 0);
      list.replaceChildren(
        ...chosen.map((file) => {
          const li = document.createElement('li');
          const link = externalLink(file.url, `${file.code}`);
          li.append(
            link,
            ` · LOD${file.maxLod}` +
              (file.features ? ` · ${file.features.toLocaleString()} 件` : '') +
              (file.fileSize ? ` · ${formatBytes(file.fileSize)}` : ''),
          );
          return li;
        }),
      );
      pack.textContent = `ZIPにまとめる (コードリスト・テクスチャ込み${total ? `、約 ${formatBytes(total)}` : ''})`;
      packStatus.textContent = '';
    };
    select.addEventListener('change', show);
    pack.addEventListener('click', () => {
      void (async () => {
        const urls = files.filter((f) => f.type === select.value).map((f) => f.url);
        pack.disabled = true;
        packStatus.textContent = 'PLATEAU配信サービスにまとめてもらっています…';
        try {
          const zip = await packCityGml(urls, (progress) => {
            packStatus.textContent = `まとめています… ${Math.round(progress * 100)}%`;
          });
          packStatus.replaceChildren(externalLink(zip, 'ZIPをダウンロード'));
        } catch (e) {
          console.error('[citygml pack] failed', e);
          packStatus.textContent = 'まとめられませんでした';
        } finally {
          pack.disabled = false;
        }
      })();
    });
    show();
    const note = document.createElement('p');
    note.className = 'download-note';
    note.textContent =
      'GMLはメッシュ単位の原典そのもの。用途などのコードを読むにはコードリストが要るので、変換ツールに渡すならZIPにまとめたものを使ってください。';
    container.append(select, list, pack, packStatus, note);
  };

  const collectionCard = (collection: Collection): HTMLElement => {
    const card = document.createElement('div');
    card.className = 'collection-card';
    card.dataset.collection = collection.id;

    const head = document.createElement('div');
    head.className = 'collection-head';
    const id = document.createElement('code');
    id.textContent = collection.id;
    head.append(id, jsonLink(collection.path, 'Collection'));

    const description = document.createElement('p');
    description.className = 'collection-description';
    description.textContent = collection.description;

    const facts = document.createElement('dl');
    facts.className = 'collection-facts';
    const fact = (term: string, ...value: (string | Node)[]) => {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.append(...value);
      facts.append(dt, dd);
      return dd;
    };
    // **使うときの条件はバッジで出す。** 識別子 (`other` を含む) だけでは何ができるか
    // 分からない。規約の本文へのリンクを必ず添える (バッジは要約)。
    if (collection.terms) {
      fact('使う条件', termsBadges(collection.terms), ' ', externalLink(collection.terms.url, collection.terms.name));
    } else {
      // 古いカタログ (duck:terms の無いもの) では識別子だけ出す。
      fact(
        'ライセンス',
        collection.license === 'other'
          ? externalLink(collection.attributionUrl, '利用規約')
          : collection.license,
      );
    }
    if (collection.provider) fact('提供', collection.provider);
    if (collection.vintage) fact('版', collection.vintage);
    // **ファイル数はItemCollectionを読まないと分からない。** 起動時には読まない
    // 約束なので、開いたときに読む (1回だけ。建物を引くときもこれを使い回す)。
    const count = document.createElement('span');
    count.className = 'collection-item-count';
    count.textContent = '…';
    fact('ファイル', count, ' ', jsonLink(collection.itemsPath, 'Items'));
    collection
      .items()
      .then((items) => (count.textContent = `${items.length.toLocaleString()} 件`))
      .catch(() => (count.textContent = '読めません'));
    if (collection.bbox) fact('範囲', formatBbox(collection.bbox));

    // 列は多い (PLATEAUは十数列) ので、たたんでおく。
    const columns = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `列 (${collection.columns.size})`;
    const list = document.createElement('p');
    list.textContent = [...collection.columns].join(', ');
    columns.append(summary, list);

    card.append(head, description, facts, columns);
    if (collection.itemsPath && collection.columns.has('geometry')) {
      card.append(downloadSection(collection));
    }
    return card;
  };

  const openLayerSettings = (layer: Layer) => {
    // **要素で比べる。** 建物のPLATEAUとOvertureは同じパネルを共有しているので、
    // 行で比べると並び順によっては自分のパネルをもう一方の行が隠してしまう。
    for (const other of layers) other.settings.hidden = other.settings !== layer.settings;
    layerSettingsTitleEl.textContent = layer.group ? `${layer.group.title} › ${layer.title}` : layer.title;
    layerCatalogEl.replaceChildren(...layer.collections.map(collectionCard));
    layer.onOpen?.();
    layerListEl.hidden = true;
    layerSettingsEl.hidden = false;
  };

  layerBackButton.addEventListener('click', showLayerList);

  /** 表示範囲と収録範囲が重なるか。**通信しない** (起動時に読んだbboxだけを見る)。 */
  const coversView = (bbox: Bbox | null): boolean => {
    if (!bbox) return true; // 分からないものは落とさない
    const b = map.getBounds();
    const [west, south, east, north] = bbox;
    return (
      west <= b.getEast() && east >= b.getWest() && south <= b.getNorth() && north >= b.getSouth()
    );
  };

  const layerRow = (layer: Layer, present: boolean): HTMLElement => {
    const row = document.createElement('div');
    row.className = present ? 'layer-row' : 'layer-row absent';
    row.dataset.layer = layer.id;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = layer.visible;
    toggle.id = `layer-toggle-${layer.id}`;
    toggle.addEventListener('change', () => {
      layer.visible = toggle.checked;
      layer.refresh();
    });

    const name = document.createElement('label');
    name.className = 'layer-name';
    name.htmlFor = toggle.id;
    name.textContent = layer.title;

    // 状態 (件数や「拡大すると出ます」) は**行に出す**。設定の中に置くと、
    // 開かない限り読めない。出ない理由が分からないのがいちばん困る。
    const status = document.createElement('span');
    status.className = 'layer-status';
    status.dataset.layerStatus = layer.id;
    status.textContent = layerStatus.get(layer.id) ?? '';

    // 出所は見出し (サブカタログ) が言うので、行には版だけを添える。
    const source = document.createElement('span');
    source.className = 'layer-source';
    source.textContent = layer.vintage ?? '';

    // **いまの位置のまま寄る。** 「建物のある範囲へ移動」は場所ごと動かすが、
    // 見たい場所は既に画面にあることが多く、足りないのはズームだけ。
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'layer-zoom-button';
    zoomIn.textContent = '🔍';
    zoomIn.title = `ズーム${layer.minZoom ?? 0}まで寄る`;
    zoomIn.hidden = layer.minZoom === undefined;
    zoomIn.addEventListener('click', () => {
      if (layer.minZoom === undefined) return;
      // 出していなければ一緒に出す。寄っただけで何も出ないのは分かりにくい。
      if (!layer.visible) {
        layer.visible = true;
        toggle.checked = true;
      }
      map.easeTo({ zoom: layer.minZoom, duration: 600 });
      layer.refresh();
    });

    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'layer-settings-button';
    settings.textContent = '⚙';
    settings.title = `${layer.title}の設定`;
    settings.addEventListener('click', () => openLayerSettings(layer));

    // **2段にする。** 名前・状態・出所・ボタンを1行に詰めると、幅の取り合いで
    // 出所が幅0まで潰れた (17.5remのパネルで実際に起きた)。
    // 段が増えても**データ1つにつき1行**なので、増え方は変わらない。
    const head = document.createElement('div');
    head.className = 'layer-head';
    head.append(toggle, name, zoomIn, settings);

    const sub = document.createElement('div');
    sub.className = 'layer-sub';
    sub.append(source, status);

    row.append(head, sub);
    return row;
  };

  /**
   * 設定の中にある要約を、一覧の行へ写す。**行とパネルが1対1のものだけ**に使う。
   *
   * 建物 (PLATEAUとOverture) と鉄道 (路線と駅) は1つのパネルを2行で共有するので、
   * 要約1つを写すと両方の行に同じことが出る。そちらは描く側が行ごとに直接書く。
   */
  const mirrorStatus = (layerId: string, from: HTMLElement) => {
    const apply = () => setLayerStatus(layerId, from.textContent ?? '');
    new MutationObserver(apply).observe(from, { childList: true, characterData: true, subtree: true });
    apply();
  };

  /** サブカタログの見出し。その文書のJSONへのリンクを添える。 */
  const groupHeading = (group: CatalogGroup): HTMLElement => {
    const heading = document.createElement('div');
    heading.className = 'layer-group';
    heading.dataset.group = group.id;
    heading.title = group.description;
    const title = document.createElement('span');
    title.className = 'layer-group-title';
    title.textContent = group.title;
    heading.append(title, jsonLink(group.path, 'Catalog'));
    return heading;
  };

  /** 行を並べ、サブカタログが変わるところに見出しを挟む。 */
  const withHeadings = (rows: Layer[], present: boolean): HTMLElement[] => {
    const nodes: HTMLElement[] = [];
    let previous: CatalogGroup | undefined;
    for (const layer of rows) {
      if (layer.group && layer.group.id !== previous?.id) nodes.push(groupHeading(layer.group));
      previous = layer.group;
      nodes.push(layerRow(layer, present));
    }
    return nodes;
  };

  /** 裏方 (検索・逆ジオコーディングが使うもの)。**切れてはいけない**ので出すだけ。 */
  const supportRow = (title: string, source: string): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'layer-row support';
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = title;
    const sourceEl = document.createElement('span');
    sourceEl.className = 'layer-source';
    sourceEl.textContent = source;
    row.append(name, sourceEl);
    return row;
  };

  /**
   * 整備範囲で確かめた「この範囲にあるか」。行ID → 答え。
   *
   * **表示範囲が変わっても消さず、新しい答えが来たら上書きする。** 消すと
   * 答えが来るまでの間は箱で判定することになり、山の中でPLATEAUが
   * 「ある」→「無い」と動かすたびにちらつく。少し動かしただけなら、
   * 前の答えはたいてい正しい。
   */
  const presence = new Map<string, boolean>();
  let presenceToken = 0;

  /**
   * 箱 (Collectionの収録範囲) の外なら確実に無い。箱の内側なら、整備範囲の
   * 答えがあればそれに従う。**箱だけだと粗い** — PLATEAUは306都市の和が
   * 日本をほぼ覆うので、箱だけでは山の中でも「ある」と出る。
   */
  const isPresent = (layer: Layer) => coversView(layer.bbox) && (presence.get(layer.id) ?? true);

  const renderLayerList = () => {
    const present = layers.filter(isPresent);
    const absent = layers.filter((layer) => !isPresent(layer));
    layerRowsEl.replaceChildren(...withHeadings(present, true));
    layerAbsentRowsEl.replaceChildren(...withHeadings(absent, false));
    layerAbsentEl.hidden = absent.length === 0;
  };

  /** 整備範囲を持つ行について、表示範囲にセルがあるかを聞き直す。 */
  const refreshPresence = async () => {
    const token = ++presenceToken;
    const b = map.getBounds();
    const c = map.getCenter();
    const bounds: ViewBounds = {
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
      centerLon: c.lng,
      centerLat: c.lat,
    };
    for (const layer of layers) {
      // 箱の外なら聞くまでもない。**読みに行かない。**
      if (!layer.coverage || !coversView(layer.bbox)) continue;
      await layer.coverage.ensure();
      const inView = await coverageInView(conn, layer.coverage, bounds);
      // 答えを待つ間に地図が動いていたら捨てる (次の問い合わせが上書きする)。
      if (token !== presenceToken) return;
      presence.set(layer.id, inView);
    }
    renderLayerList();
  };

  const requestPresence = () => {
    refreshPresence().catch((e: unknown) => {
      // 判定が失敗しても一覧は箱で出ている。**描画は止めない。**
      console.error('[layers] presence failed', e);
    });
  };

  // 人口メッシュと道路はパネルと行が1対1なので、パネルの要約をそのまま写す。
  if (meshSources[0]) mirrorStatus(meshSources[0].id, meshSummaryEl);
  if (roadSource) mirrorStatus(roadSource.id, roadSummaryEl);

  if (layers.length > 0) {
    // **まず箱で描き、整備範囲の答えが来たら描き直す。** `moveend` ごとに走るので、
    // 答えを待たせて一覧が空になる時間を作らない。
    renderLayerList();
    requestPresence();
    map.on('moveend', () => {
      renderLayerList();
      requestPresence();
    });
  }

  // ---- 表示量 ---------------------------------------------------------------
  //
  // **全レイヤーに一度に効く。** 建物だけ上げて道路はそのまま、という使い方は
  // 想定しない — 重いかどうかは端末で決まり、レイヤーごとには決まらないため。
  const detailSelect = document.querySelector<HTMLSelectElement>('#detail-level')!;
  for (const [level, { label }] of Object.entries(DETAIL_LEVELS)) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = label;
    detailSelect.append(option);
  }
  detailSelect.value = loadDetailLevel();
  detailSelect.addEventListener('change', () => {
    const level = detailSelect.value as DetailLevel;
    detail = DETAIL_LEVELS[level];
    saveDetailLevel(level);

    // 「寄る」ボタンの行き先は建物のズームで決まる。行は作り直すので値だけ差し替える。
    // 寄るボタンを持つのは建物の行だけ (出所の数だけある)。
    for (const layer of layers) {
      if (layer.minZoom !== undefined) layer.minZoom = detail.buildingsMinZoom;
    }
    if (layers.length > 0) renderLayerList();

    requestRefresh();
    requestRailwayRefresh();
    requestRoadRefresh();
  });

  // 裏方は種別から引く。**一覧に出すが切らせない** (外すと検索が壊れる)。
  const supportKinds: [DatasetKind, string][] = [
    // **打つ言葉で書く。** データセット名 (「位置参照情報」) では、
    // 何を打てば当たるのかが分からない。出所は2段目に小さく出る。
    ['admin', '市区町村名'],
    ['oaza', '町名・丁目'],
    ['block', '街区 (〜丁目〜番)'],
    ['railway_station', '駅名・路線名'],
    ['road_route', '道路名 (国道13号など)'],
  ];
  const supportRows = supportKinds.flatMap(([kind, title]) => {
    const collection = byKind(kind)[0];
    return collection ? [supportRow(title, collection.attribution.split('（')[0])] : [];
  });
  if (supportRows.length > 0) {
    layerSupportRowsEl.replaceChildren(...supportRows);
    layerSupportEl.hidden = false;
  }

  if (settingsSource) {
    map.on('moveend', requestRefresh);

    /** チェック状態を条件に反映する。全部入っていれば「絞っていない」= null。 */
    const syncUsageFilter = (all: string[]) => {
      if (!settingsSource) return;
      const checked = [...usageOptionsEl.querySelectorAll<HTMLInputElement>('input:checked')];
      filterOf(settingsSource).usages =
        checked.length === all.length ? null : checked.map((c) => c.value);
      requestRefresh();
    };

    // 選択肢はカタログに入っているので、**ここでデータを読まない**。
    // 以前はここで全ファイルの用途の列を走査していて、起動のたびに
    // ファイルの数だけ往復していた。
    const showFilters = (source: BuildingSource) => {
      const filter = filterOf(source);
      heightField.hidden = !source.hasHeight;
      usageField.hidden = source.categoryColumn === null;
      filtersEl.hidden = !source.hasHeight && source.categoryColumn === null;

      // **その出所の絞り込みを戻す。** パネルは共有なので、開き直すたびに
      // 前に開いていた出所の値が残っている。
      minHeightInput.value = String(filter.minHeight);
      minHeightValue.textContent = `${filter.minHeight} m`;

      // **重要度の段。** 段の規則はカタログから来るので、出所ごとに作り直す
      // (題名は同じでも、何がどの段に入るかは出所の語彙で違う)。
      tierField.hidden = !source.tiers;
      tierOptionsEl.replaceChildren();
      for (const tier of source.tiers?.tiers ?? []) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = tier.id;
        checkbox.checked = filter.tiers === null || filter.tiers.includes(tier.id);
        checkbox.addEventListener('change', () => {
          const all = source.tiers!.tiers.map((t) => t.id);
          const checked = [...tierOptionsEl.querySelectorAll<HTMLInputElement>('input:checked')];
          filter.tiers = checked.length === all.length ? null : checked.map((c) => c.value);
          requestRefresh();
        });
        // 何が入るのかを添える。段の名前だけでは「業務」に工場が入るのか分からない。
        label.title = tier.values.length > 0 ? tier.values.join('・') : 'どの段にも入らないもの';
        label.append(checkbox, document.createTextNode(tier.title));
        tierOptionsEl.append(label);
      }

      if (source.categoryColumn === null) return;
      const usages = source.usages;

      // 出所ごとに語彙が違うので、切り替えのたびに作り直す。
      usageOptionsEl.replaceChildren();
      for (const usage of usages) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = usage;
        checkbox.checked = filter.usages === null || filter.usages.includes(usage);
        checkbox.addEventListener('change', () => syncUsageFilter(usages));
        label.append(checkbox, document.createTextNode(usage));
        usageOptionsEl.append(label);
      }

      // 1つだけ見たいときに13個外させない。「なし」→目的の1つ、で済むようにする。
      const setAll = (checked: boolean) => {
        for (const input of usageOptionsEl.querySelectorAll<HTMLInputElement>('input')) {
          input.checked = checked;
        }
        syncUsageFilter(usages);
      };
      usageAllButton.onclick = () => setAll(true);
      usageNoneButton.onclick = () => setAll(false);
    };

    // **重要度で色分けする。** 重要な段を目立たせ、住宅・その他を退かせる。
    // 引き直さず塗りだけを替える (段は既に地物に入っている)。出所をまたいで効く。
    tierColorToggle.addEventListener('change', () => {
      map.setPaintProperty(
        'buildings-3d',
        'fill-extrusion-color',
        tierColorToggle.checked ? BUILDING_COLOR_BY_TIER : BUILDING_COLOR_BY_HEIGHT,
      );
    });

    // **どちらかの ⚙ を押したら、共有しているパネルをその出所に向ける。**
    // 描く出所は変えない (それは一覧のチェックが決める)。
    pointBuildingSettings = (source) => {
      settingsSource = source;
      showFilters(source);
      buildingCountEl.textContent = layerStatus.get(source.id) ?? '';
    };
    showFilters(settingsSource);
    // 整備範囲は refreshBuildings が出すが、その呼び出しは moveend でしか
    // 起きない。起動直後にも一度呼んでおかないと、地図を動かすまで出ない。
    requestRefresh();

    // スライダーは動かすたびにイベントが飛ぶので、少し待ってからクエリする。
    let heightTimer: ReturnType<typeof setTimeout> | undefined;
    minHeightInput.addEventListener('input', () => {
      if (!settingsSource) return;
      const filter = filterOf(settingsSource);
      filter.minHeight = Number(minHeightInput.value);
      minHeightValue.textContent = `${filter.minHeight} m`;
      clearTimeout(heightTimer);
      heightTimer = setTimeout(requestRefresh, 200);
    });
  }

  // 操作の役割分担:
  //   ホバー = 調べる (建物の情報を見るだけ。地図は動かさない)
  //   📍を押してからクリック = 選ぶ (逆ジオコーディングして行政区域をハイライトする)
  //
  // 逆ジオコーディングは結果の行政区域が全部入るまで地図を引く (showResult の
  // fitBounds)。常時オンだと、建物を眺めている最中のクリックで見ていた場所も
  // 傾きもまとめて失われるので、押したときだけ効かせる。

  // 待ち受け中は十字、建物の上ではポインタ。どちらも同じ canvas の style を
  // 触るので、条件をここに集めて一箇所から書く。
  let picking = false;
  /** 周辺検索の待ち受け中。📍と同じく、押してから地図をクリックする。 */
  let nearbyMode = false;
  let hoveringBuilding = false;
  const updateCursor = () => {
    map.getCanvas().style.cursor =
      picking || nearbyMode ? 'crosshair' : hoveringBuilding ? 'pointer' : '';
  };

  // 📍と◎は**どちらか一方だけ**。両方が待ち受けていると、1回のクリックで
  // 判定と周辺検索が同時に走って、どちらの結果か分からなくなる。
  const setPicking = (on: boolean) => {
    picking = on;
    pickButton.setAttribute('aria-pressed', String(on));
    if (on && nearbyMode) setNearbyMode(false);
    updateCursor();
  };
  const setNearbyMode = (on: boolean) => {
    nearbyMode = on;
    nearbyButton.setAttribute('aria-pressed', String(on));
    if (on && picking) setPicking(false);
    // **押したらパネルを出して、何をすればいいかを言う。** 検索で選んだものがあれば、
    // 地図をクリックせずにそれを起点にもできる。
    if (on) {
      nearbyPanel.hidden = false;
      nearbyOriginEl.textContent = '地図の点・線・建物をクリックしてください';
      nearbyResultsEl.replaceChildren();
      nearbyFromSearch.hidden = lastSelection === null;
    }
    updateCursor();
  };

  pickButton.addEventListener('click', () => setPicking(!picking));
  nearbyButton.addEventListener('click', () => setNearbyMode(!nearbyMode));

  // Escの出口を1本にまとめる。押している最中なら解除が先、そうでなければ
  // 出ている結果を消す。window で拾うのは、判定した直後はフォーカスが地図側にあり、
  // 検索欄に付けていると効かないため。
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (picking) {
      setPicking(false);
      return;
    }
    if (nearbyMode) {
      setNearbyMode(false);
      return;
    }
    clearSearch();
  });

  // ---- 周辺検索 ---------------------------------------------------------------
  //
  // 起点は4通り: 検索で選んだもの / 地図上の点 / 地図上の線 / 建物。
  // 地図上のものは◎を押してからクリックする。何も無いところなら点、
  // 線や建物の上ならそれを起点にする。
  let lastSelection: NearbyOrigin | null = null;
  let currentOrigin: NearbyOrigin | null = null;
  let nearbyToken = 0;

  /** 検索で選んだものを覚えておく。周辺検索のパネルから起点にできる。 */
  const rememberSelection = (label: string, geometry: GeoJSON.Geometry) => {
    lastSelection = { label, geometry };
    nearbyFromSearch.hidden = false;
  };

  /** 起点に使える地図上のレイヤーと、その呼び名・名前の属性。上ほど優先。 */
  const ORIGIN_LAYERS: { layer: string; label: string; nameKey: string | null }[] = [
    { layer: 'buildings-3d', label: '建物', nameKey: null },
    { layer: 'line-power_line', label: '送電線', nameKey: 'name' },
    { layer: 'line-waterway', label: '川', nameKey: 'name' },
    { layer: 'railway-station', label: '駅', nameKey: 'stationName' },
    { layer: 'railway-line', label: '鉄道', nameKey: 'lineName' },
    { layer: 'road-line', label: '道路', nameKey: 'roadName' },
  ];

  /**
   * クリックした場所の起点を決める。**線は同じ名前の区間をまとめて起点にする**
   * (川や送電線は区間に切れているので、1区間だけだと「川沿い」にならない)。
   * 名前は表示中のデータから集めるので、画面に出ている範囲の分になる。
   */
  const originAt = async (
    point: { x: number; y: number },
    lngLat: { lng: number; lat: number },
  ): Promise<NearbyOrigin> => {
    const layers = ORIGIN_LAYERS.filter(({ layer }) => map.getLayer(layer));
    const hits = map.queryRenderedFeatures([point.x, point.y], {
      layers: layers.map(({ layer }) => layer),
    });
    const hit = hits[0];
    const spec = hit && layers.find(({ layer }) => layer === hit.layer.id);
    if (!hit || !spec) {
      return {
        label: `地図上の点 (${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)})`,
        geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] },
      };
    }
    if (spec.nameKey === null) {
      return {
        label: `${spec.label} ${(hit.properties.name as string | null) ?? '(名称なし)'}`,
        geometry: hit.geometry,
      };
    }
    const name = hit.properties[spec.nameKey] as string | null;
    if (!name) return { label: `${spec.label} (名前なし)`, geometry: hit.geometry };
    const data = await (map.getSource(hit.source) as GeoJSONSource).getData();
    const lines: GeoJSON.Position[][] = [];
    if (data.type === 'FeatureCollection') {
      for (const feature of data.features) {
        if (feature.properties?.[spec.nameKey] !== name) continue;
        const g = feature.geometry;
        if (g.type === 'LineString') lines.push(g.coordinates);
        if (g.type === 'MultiLineString') lines.push(...g.coordinates);
      }
    }
    return {
      label: `${spec.label} ${name}`,
      geometry: lines.length > 0 ? { type: 'MultiLineString', coordinates: lines } : hit.geometry,
    };
  };

  map.on('click', (e) => {
    if (!nearbyMode) return;
    setNearbyMode(false);
    void originAt(e.point, e.lngLat).then(runNearby);
  });

  const clearNearby = () => {
    if (nearbyMode) setNearbyMode(false);
    nearbyToken++;
    currentOrigin = null;
    nearbyPanel.hidden = true;
    Promise.all([setSourceData('nearby-zone', null), setSourceData('nearby-hits', null)]).catch(
      (e: unknown) => console.error('[nearby] clear failed', e),
    );
  };

  /** 周辺を調べて、パネルと地図に出す。 */
  const runNearby = async (origin: NearbyOrigin) => {
    currentOrigin = origin;
    nearbyPanel.hidden = false;
    nearbyFromSearch.hidden = lastSelection === null;
    const distance = Number(nearbyDistance.value);
    nearbyOriginEl.textContent = `起点: ${origin.label} (${distance} m 以内)`;
    nearbyResultsEl.textContent = '調べています…';
    const token = ++nearbyToken;
    const frame = nearbyFrame(origin, distance, currentBounds());

    try {
      const result = await busy('周辺を調べています…', async () => {
        await ensureSpatial();
        const zone = await conn.query(
          `SELECT ST_AsGeoJSON(${fromMeters(frame, `ST_Buffer(${frame.origin}, ${distance})`)}) AS g;`,
        );
        const zoneGeometry = JSON.parse(
          (zone.toArray()[0].toJSON() as { g: string }).g,
        ) as GeoJSON.Geometry;

        const buildings: NearbyBuildings[] = [];
        for (const source of buildingSources) {
          await source.ensure();
          const found = await fetchNearbyBuildings(conn, source, frame);
          if (found) buildings.push(found);
        }
        const names: [string, { names: string[]; total: number }][] = [];
        for (const source of railwaySources) {
          await source.ensure();
          const expression =
            source.kind === 'railway_station'
              ? `station_name || '駅 (' || line_name || ')'`
              : `line_name || ' (' || operator || ')'`;
          names.push([
            source.kind === 'railway_station' ? '駅' : '鉄道',
            await fetchNearbyNames(conn, source, frame, expression),
          ]);
        }
        if (roadSource) {
          await roadSource.ensure();
          names.push([
            '道路',
            await fetchNearbyNames(
              conn,
              roadSource,
              frame,
              `coalesce(nullif(array_to_string(route_names, '・'), ''), road_name)`,
            ),
          ]);
        }
        for (const source of lineSources) {
          await source.ensure();
          names.push([source.title, await fetchNearbyNames(conn, source, frame, 'name')]);
        }
        // 人口は**いちばん細かいメッシュ**で数える (粗いと範囲からはみ出す分が増える)。
        let population: { population: number; cells: number; label: string } | null = null;
        for (const source of [...meshSources].sort((a, b) => b.digits - a.digits)) {
          if (!source.bbox || !bboxOverlaps(source.bbox, frame.bounds)) continue;
          await source.ensure();
          const found = await fetchNearbyPopulation(conn, source, frame);
          if (found && found.cells > 0) {
            population = { ...found, label: MESH_SIZE_LABELS[source.digits] ?? `${source.digits}桁` };
            break;
          }
        }
        return { zoneGeometry, buildings, names, population };
      });
      if (token !== nearbyToken) return;

      await setSourceData('nearby-zone', result.zoneGeometry);
      // 建物は1棟ずつ段の色で塗るので、属性ごと FeatureCollection で渡す。
      const hitSource = map.getSource('nearby-hits') as GeoJSONSource | undefined;
      await hitSource?.setData({
        type: 'FeatureCollection',
        features: result.buildings.flatMap((b) => b.features),
      });
      renderNearby(result, frame);
    } catch (e) {
      console.error('[nearby] failed', e);
      if (token === nearbyToken) nearbyResultsEl.textContent = '調べられませんでした';
    }
  };

  const renderNearby = (
    result: {
      buildings: NearbyBuildings[];
      names: [string, { names: string[]; total: number }][];
      population: { population: number; cells: number; label: string } | null;
    },
    frame: NearbyFrame,
  ) => {
    const list = document.createElement('dl');
    const row = (term: string, ...value: (string | Node)[]) => {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.append(...value);
      list.append(dt, dd);
    };
    if (result.buildings.length === 0 && buildingSources.length > 0) row('建物', 'なし');
    for (const found of result.buildings) {
      const group = collections.find((c) => c.id === found.source.id)?.group?.title;
      const total = found.counts.reduce((sum, [, n]) => sum + n, 0);
      const breakdown = found.counts
        .filter(([, n]) => n > 0)
        .map(([title, n]) => `${title} ${n.toLocaleString()}`)
        .join(' · ');
      row(`建物${group ? ` (${group})` : ''}`, `${total.toLocaleString()} 棟 — ${breakdown}`);
      if (found.named.length > 0) {
        const shown = found.named.slice(0, 10);
        row(
          '名前のある建物',
          shown.join('、') + (found.named.length > shown.length ? ` ほか${found.named.length - shown.length}件` : ''),
        );
      }
    }
    for (const [label, { names, total }] of result.names) {
      row(
        label,
        total === 0 ? 'なし' : names.join('、') + (total > names.length ? ` ほか${total - names.length}件` : ''),
      );
    }
    if (result.population) {
      row(
        '人口',
        `約 ${Math.round(result.population.population).toLocaleString()} 人 (${result.population.label}メッシュ ${result.population.cells.toLocaleString()} 個の合計)`,
      );
    }
    const notes: string[] = [];
    if (result.population) {
      notes.push('人口は範囲に掛かるメッシュの値の合計なので、範囲より広い分を含みます。');
    }
    if (frame.clipped) {
      notes.push('起点が画面より大きいので、表示範囲の中だけを数えています。');
    }
    if (result.buildings.some((b) => b.features.length >= NEARBY_DRAW_LIMIT)) {
      notes.push(`地図に描く建物は${NEARBY_DRAW_LIMIT.toLocaleString()}件までです (数は全部)。`);
    }
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = notes.join(' ');
    nearbyResultsEl.replaceChildren(list, ...(notes.length > 0 ? [note] : []));
  };

  nearbyDistance.addEventListener('change', () => {
    if (currentOrigin) void runNearby(currentOrigin);
  });
  nearbyFromSearch.addEventListener('click', () => {
    if (!lastSelection) return;
    setNearbyMode(false);
    void runNearby(lastSelection);
  });
  document.querySelector('#nearby-close')!.addEventListener('click', clearNearby);

  // ホバー用。マウスを追うだけなので閉じるボタンは出さない。
  const hoverPopup = new Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 12,
    className: 'hover-popup',
  });

  /**
   * ホバーの中身を組み立てる。
   *
   * **`setText` に改行を渡しても効かない。** テキストノードになるので `\n` は
   * 空白に潰れ、項目が横一列に並んで読めなくなる。かといって `setHTML` は
   * データ由来の文字列 (駅名や事業者名) をそのままHTMLとして解釈するので使わない。
   * 要素を組んで `setDOMContent` に渡す。
   *
   * `rows` は [項目名, 値]。**項目名が空なら見出し**として大きく出す。
   */
  const hoverContent = (rows: [string, string | null][]): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'hover-info';
    for (const [label, value] of rows) {
      if (value === null) continue;
      const line = document.createElement('div');
      if (label) {
        const name = document.createElement('span');
        name.className = 'label';
        name.textContent = label;
        line.append(name, document.createTextNode(value));
      } else {
        line.className = 'title';
        line.textContent = value;
      }
      box.append(line);
    }
    return box;
  };

  if (buildingSources.length > 0) {
    map.on('mousemove', 'buildings-3d', (e) => {
      const building = e.features?.[0];
      if (!building) return;
      hoveringBuilding = true;
      updateCursor();

      const props = building.properties;
      // **どちらの出所の建物か。** PLATEAUとOvertureは同時に出せるので、
      // 重なっているところでは色だけでは見分けにくい。見出しと同じ名前で言う。
      const origin = collections.find((c) => c.id === props.origin);
      hoverPopup
        .setLngLat(e.lngLat)
        .setDOMContent(
          hoverContent([
            ['', (props.name as string | null) ?? '(名称なし)'],
            ['用途', (props.category as string | null) ?? null],
            ['高さ', props.height ? `${props.height as number} m` : null],
            ['重要度', (props.tier as string | null) ?? null],
            ['出所', origin?.group?.title ?? origin?.title ?? null],
          ]),
        )
        .addTo(map);
    });

    map.on('mouseleave', 'buildings-3d', () => {
      hoveringBuilding = false;
      updateCursor();
      hoverPopup.remove();
    });

    // 整備範囲のメッシュ。**どのメッシュか、どの自治体かが読めること。**
    // 塗りの濃さは埋まり具合しか表さないので、中身はここでしか分からない。
    //
    // 道路と同じく、**同じセルの上を動いている間は作り直さない**
    // (セルは1km四方あるので滅多に変わらないが、境目でちらつく)。
    let hoveredCell = '';

    map.on('mousemove', 'buildings-coverage-fill', (e) => {
      // **判定中はホバーを出さない。** 判定の結果も吹き出しで出すので、
      // 2つ並ぶとどちらが押した場所のものか分からなくなる。
      if (picking) return;
      const cell = e.features?.[0];
      if (!cell) return;
      hoveringBuilding = true;
      updateCursor();

      hoverPopup.setLngLat(e.lngLat).addTo(map);

      const code = cell.properties.code as string;
      if (code === hoveredCell) return;
      hoveredCell = code;

      const cities = (cell.properties.cities as string) || '(不明)';
      const filled = cell.properties.filled as number;
      const total = cell.properties.total as number;
      hoverPopup.setDOMContent(
        hoverContent([
          ['', `${MESH_SIZE_LABELS[code.length] ?? `${code.length}桁`}メッシュ`],
          ['メッシュコード', code],
          // **束ねると自治体が増える。** 80kmまで引くと何十も並ぶので、
          // 多いときは数だけにする (全部出すとポップアップが画面を覆う)。
          ['自治体', cities.split('、').length > 6 ? `${cities.split('、').length} 市区町村` : cities],
          // **濃淡を数で裏付ける。** 色だけだと「薄い」が読み取れない。
          // 1kmで見ているときは必ず1/1なので出さない。
          ...(total > 1
            ? ([
                [
                  'データのある1kmセル',
                  `${filled.toLocaleString()} / ${total.toLocaleString()} (${Math.round((filled / total) * 100)}%)`,
                ],
              ] as [string, string][])
            : []),
          ['建物', `${(cell.properties.buildings as number).toLocaleString()} 棟`],
        ]),
      );
    });

    map.on('mouseleave', 'buildings-coverage-fill', () => {
      hoveringBuilding = false;
      hoveredCell = '';
      updateCursor();
      hoverPopup.remove();
    });
  }

  if (railwaySources.length > 0) {
    // 駅を先に置く。路線と重なっている場所では駅の方が知りたいことが多い。
    // (MapLibreは先に登録したレイヤーのイベントが先に来るわけではないので、
    //  重なりは `queryRenderedFeatures` の順ではなくレイヤーごとに拾う)
    for (const layer of ['railway-station', 'railway-line']) {
      map.on('mousemove', layer, (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        hoveringBuilding = true;
        updateCursor();

        const props = feature.properties;
        const station = props.stationName as string | null;
        hoverPopup
          .setLngLat(e.lngLat)
          .setDOMContent(
            hoverContent([
              // 駅なら駅名を見出しにする。路線には駅名が入っていない。
              ['', station ? `${station}駅` : (props.lineName as string)],
              ['路線', station ? (props.lineName as string) : null],
              ['事業者', props.operator as string],
              ['種別', props.institutionType as string],
              ['区分', props.railwayClass as string],
              ['時点', railwayVintage ?? null],
            ]),
          )
          .addTo(map);
      });

      map.on('mouseleave', layer, () => {
        hoveringBuilding = false;
        updateCursor();
        hoverPopup.remove();
      });
    }
  }

  if (roadSource) {
    // **同じ道路の上を動いている間は作り直さない。**
    //
    // 道路は交差点ごとに区間が切れているので、1本の道をなぞるだけで別の地物へ
    // 次々に移る。毎回中身を組み直すと、**同じ道を見ているのに表示がちらつく**。
    // 名前と路線と等級が同じなら同じ道として扱い、位置だけ追わせる。
    let hoveredRoad = '';

    map.on('mousemove', 'road-line', (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      hoveringBuilding = true;
      updateCursor();

      const props = feature.properties;
      const routes = (props.routeNames as string) || '';
      const name = props.roadName as string | null;
      const roadClass = props.roadClass as string;

      hoverPopup.setLngLat(e.lngLat).addTo(map);

      const identity = `${name ?? ''}|${routes}|${roadClass}`;
      if (identity === hoveredRoad) return;
      hoveredRoad = identity;

      hoverPopup.setDOMContent(
        hoverContent([
          // 名前が無い区間もある。その場合は路線名を見出しに繰り上げる。
          ['', name || routes || '(名前なし)'],
          // **路線は複数あることがある。** 見出しに使ったものと同じなら繰り返さない。
          ['路線', routes && routes !== name ? routes : null],
          ['種別', roadClass],
          ['時点', roadVintage ?? null],
        ]),
      );
    });

    map.on('mouseleave', 'road-line', () => {
      hoveringBuilding = false;
      hoveredRoad = '';
      updateCursor();
      hoverPopup.remove();
    });
  }

  // 送電線・川。道路と同じく、同じ線の上を動いている間は作り直さない (ちらつき防止)。
  let hoveredLine = '';
  for (const kind of LINE_KINDS) {
    const layerId = `line-${kind}`;
    map.on('mousemove', layerId, (e) => {
      if (picking) return;
      const feature = e.features?.[0];
      if (!feature) return;
      hoveringBuilding = true;
      updateCursor();
      hoverPopup.setLngLat(e.lngLat).addTo(map);

      const props = feature.properties;
      const identity = `${kind}|${props.name ?? ''}|${props.lineClass}`;
      if (identity === hoveredLine) return;
      hoveredLine = identity;
      const origin = collections.find((c) => c.id === props.origin);
      hoverPopup.setDOMContent(
        hoverContent([
          ['', (props.name as string | null) || '(名前なし)'],
          ['種別', props.lineClass as string],
          ['出所', origin?.group?.title ?? null],
          ['時点', origin?.vintage ?? null],
        ]),
      );
    });
    map.on('mouseleave', layerId, () => {
      hoveringBuilding = false;
      hoveredLine = '';
      updateCursor();
      hoverPopup.remove();
    });
  }

  // 逆ジオコーディング: クリックした地点がどの行政区域かを引き、
  // その区域をハイライトしてポップアップで名前を出す (popup は上で用意している)。
  map.on('click', (e) => {
    if (!picking) return;
    // 1クリックで解除する。押しっぱなしのモードにすると、今どちらの状態かを
    // 覚えていないと次のクリックの結果が読めなくなる。
    setPicking(false);

    const { lng, lat } = e.lngLat;
    // **ホバーの吹き出しを先に片付ける。** 判定の結果も吹き出しで出すので、
    // 残っていると2つ並んでどちらが押した場所のものか分からない。
    // 整備範囲のメッシュは引いた表示で常に出ているぶん、ここに必ず当たる。
    hoverPopup.remove();
    popup.setLngLat(e.lngLat).setText('判定中…').addTo(map);

    busy('地点を判定中…', async () => {
      await ensureSpatial();
      return reverseGeocode(conn, lng, lat);
    })
      .then(async (hit) => {
        if (!hit) {
          popup.setText('該当する行政区域はありません (海上など)');
          return;
        }
        popup.setText(hit.label);
        input.value = hit.label;
        clearButton.hidden = false;
        await showResult({ kind: 'admin', label: hit.label, adminId: hit.adminId });
      })
      .catch((err: unknown) => {
        console.error('[reverseGeocode] failed', err);
        popup.setText('判定に失敗しました');
      });
  });
}

void main();
