/**
 * **カタログ (STAC) を読む。** 画面にも地図にも依存しない部分。
 *
 * カタログは [STAC 1.1.0](https://github.com/radiantearth/stac-spec)。
 * Rust側の build_catalog がGeoParquetのメタデータから生成するので、
 * 変換したファイルが増えればUIは自動で追随する。
 *
 * ```text
 * catalog.json                ← Catalog。出所ごとのサブカタログへの child リンク
 * estat/catalog.json          ← Catalog (サブカタログ)。「国勢調査」
 * estat/estat-mesh-pop.json   ← Collection。何があるか。件数で増えない
 * items.parquet               ← 全 Collection の Item (stac-geoparquet)。Collection ごとに行グループ
 * collections.json            ← アプリ用のまとめ (Catalog と Collection を1つに。英語版は .en.json)
 * ```
 *
 * **起動時に読むのはまとめ1つだけ。** 文書を1つずつ辿ると3段・43回の読み込みになっていた。
 * Item は使う段になって、**その Collection の行グループだけ**を Range で読む
 * (DuckDB に読ませるので、DuckDB が起きるまで待つ)。
 *
 * **レイヤーの一覧はこの階層で組む。** サブカタログが見出し、Collectionが行。
 * 画面を読むことがそのままカタログを歩くことになるようにしてある。
 */
export interface StacLink {
  rel: string;
  href: string;
  type?: string;
  title?: string;
  /** 同じ文書の別の言語 (Language extension の `rel: alternate`)。 */
  hreflang?: string;
}

export type DatasetKind =
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
  | 'waterway'
  // **外部のベクトルタイル** (地理院の最適化ベクトルタイル)。SQLでは引けず、重ねて見るだけ。
  | 'vector_tiles'
  // **外部の地図タイル** (背景地図)。いちばん下に敷く。
  | 'raster_tiles'
  // **外部の標高タイル** (地形)。地図を立体にする。
  | 'terrain'
  // **3D Tiles** (Re:Earth Buildings)。この地図 (MapLibre) では描けない。ⓘ からビューアへ。
  | '3d_tiles'
  // **元データ** (基盤地図情報など)。配っていない。派生物の「作られた元」として辿るだけ。
  | 'reference';

/** 範囲 [xmin, ymin, xmax, ymax] (WGS84)。 */
export type Bbox = [number, number, number, number];

/** ベクトルタイルの層1つ (`duck:themes[].layers[]`)。PMTiles のメタデータから来る。 */
export interface VectorLayerInfo {
  /** タイルの中の層のID (`BldA` など)。スタイルの `source-layer` と同じ。 */
  id: string;
  title: string;
  /** **このズームより引くと描かれない** (タイルに入っていない)。 */
  minzoom: number;
  maxzoom: number;
  fields: string[];
  /** 形の種類 ("Point" / "LineString" / "Polygon")。**描き方はこれで決める。** */
  geometry?: string;
  /** 地物の数 (全ズームの延べ)。 */
  count?: number;
}

/**
 * 層を束ねたテーマ (「道路」「水部」…)。**一覧の1行になる。**
 *
 * タイルの層 (地理院なら24) やスタイルの描画の層 (123) をそのまま並べると、
 * 見たいものを探すのが大変になる (地理院地図Vectorの一覧がそう)。
 */
export interface VectorTheme {
  id: string;
  title: string;
  layers: VectorLayerInfo[];
}

/**
 * 標高タイルの形式 (`duck:dem`)。**同じ「標高タイル」でも中身の約束が違う** ので、
 * 使う側が読み方を決められるようにカタログに書く。
 */
export interface DemInfo {
  /** `terrarium` / `mapbox` (Terrain-RGB) / `gsi` (地理院の独自形式)。 */
  encoding: string;
  /** 高さの基準。`orthometric` (海面から) / `ellipsoid` (WGS84 楕円体から)。 */
  vertical: string;
  /** 人向けの説明 (計算式・値なしの扱い)。 */
  description?: string;
}

/** STAC のアセット。外部のタイルセットは Collection が直接持つ。 */
export interface StacAsset {
  href: string;
  type?: string;
  title?: string;
  roles?: string[];
  'file:size'?: number;
  'duck:zoom'?: [number, number];
}

/**
 * 規約の要約 (`duck:terms`)。パイプラインの `catalog::Terms` と同じ形。
 * **規約の本文が正本で、これは要約。** 画面には必ず本文へのリンクを添える。
 */
export interface Terms {
  name: string;
  url: string;
  /** `allowed_with_notice` は「可。ただし事前に連絡」(JAXA)。 */
  commercial: 'allowed' | 'allowed_with_notice' | 'not_restricted' | 'non_commercial';
  attribution_required: boolean;
  note_modification: boolean;
  share_alike: boolean;
}

/** STAC Catalog。ルートと、出所ごとのサブカタログ。 */
export interface StacCatalog {
  type: 'Catalog';
  id: string;
  title?: string;
  description?: string;
  links: StacLink[];
}

/** STAC Collection。`duck:` の付いたものはSTACに無い独自項目。 */
export interface StacCollection {
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
  /** 外部のタイルセットだけが持つ (`data` がタイル、`style` が描き方)。 */
  assets?: Record<string, StacAsset>;
  /** 外部のベクトルタイルの層を、テーマに束ねたもの。 */
  'duck:themes'?: VectorTheme[];
  /** **どう作ったか** (tippecanoe の引数など)。簡略化の度合いが分かる。 */
  'duck:generator_options'?: string;
  /** 地図タイルが実際にあるズーム [最小, 最大]。外部の地図タイル・標高だけが持つ。 */
  'duck:zoom'?: [number, number];
  /** 地図タイルの大きさ (px)。 */
  'duck:tile_size'?: number;
  /** 標高タイルの形式 (エンコード・高さの基準・値なしの扱い)。地形だけが持つ。 */
  'duck:dem'?: DemInfo;
  /** 同じ役割 (背景地図・地形) の中で既定に使うもの。 */
  'duck:default'?: boolean;
  links: StacLink[];
}

/** 建物の重要度の段の規則 (`duck:tiers`)。パイプラインの `catalog::Tiers` と同じ形。 */
export interface Tiers {
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
export function tierExpression(tiers: Tiers): string {
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

/**
 * STAC Item。1つのGeoParquetに対応する。
 *
 * stac-geoparquet から読んだ行を、STAC の Item の形に戻したもの (properties は列から戻す)。
 */
export interface StacItem {
  id: string;
  collection: string;
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
export interface LocatedItem {
  feature: StacItem;
  /** Item を載せていたファイル (stac-geoparquet) の、配信の起点からのパス。 */
  base: string;
}

/**
 * 出所のまとまり (サブカタログ)。**レイヤー一覧の見出しになる。**
 *
 * 「PLATEAU」「Overture Maps」をここで決め打ちしない。カタログが名乗っている
 * ものをそのまま出すので、出所が増えればパイプライン側で1行足すだけで済む。
 */
export interface CatalogGroup {
  id: string;
  title: string;
  description: string;
  /** この文書の、配信の起点からのパス。JSONそのものを見せるのに使う。 */
  path: string;
}

/** Collectionを扱いやすい形にしたもの。Itemは呼ばれるまで読まない。 */
export interface Collection {
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
  /** Item を載せた stac-geoparquet の、配信の起点からのパス。無ければ undefined。 */
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
  /** Collection が直接持つアセット (外部のタイルセット)。hrefは解決済み。 */
  assets: Record<string, StacAsset>;
  /** 外部のベクトルタイルのテーマ。それ以外は undefined。 */
  themes: VectorTheme[] | undefined;
  generatorOptions: string | undefined;
  /**
   * 地図タイルへのリンク (web-map-links 拡張の `rel: "xyz"` / `"tilejson"`)。
   * 外部の地図タイル・標高だけが持つ。タイルは1ファイルではないのでアセットにならない。
   */
  tileLink: StacLink | undefined;
  /** 地図タイルが実際にあるズーム [最小, 最大]。 */
  zoom: [number, number] | undefined;
  tileSize: number | undefined;
  /** 標高タイルの形式。地形だけが持つ。 */
  dem: DemInfo | undefined;
  /** **何から作られたか** (`rel: "derived_from"` の行き先。配信の起点からのパス)。 */
  derivedFrom: string[];
  /** 公式のビューア (この地図で描けないもの)。`rel: "alternate"` の HTML。 */
  viewer: string | undefined;
  /** 公開元が同じデータを配っている STAC (`rel: "alternate"` の JSON)。参照だけのもの (AW3D30) が持つ。 */
  sourceStac: string | undefined;
  /** 同じ役割 (背景地図・地形) の中で既定に使うもの (`duck:default`)。 */
  isDefault: boolean;
  /** 標高のエンコード (`dem.encoding` の近道)。 */
  demEncoding: string | undefined;
  /** Itemを読む。**Collectionごとに1回だけ**読む (その Collection の行グループだけ)。 */
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

export function dataUrl(file: string): string {
  return new URL(`${DATA_BASE_URL}/${file}`, window.location.href).toString();
}

/**
 * アプリが起動時に読むまとめ (言語ごと)。パイプラインの `stac_i18n::BUNDLE_FILE*` と同じ名前。
 *
 * 中身は STAC API の `/collections` と同じ形に、サブカタログ (`duck:catalogs`) と
 * 各文書の置き場所 (`duck:path`) を足したもの。**文書ごとの JSON はそのまま置いてある**
 * (STAC Browser などはそちらを辿る)。
 */
const BUNDLE_PATHS = { ja: 'collections.json', en: 'collections.en.json' } as const;

/** まとめに入っている文書。`duck:path` はその文書の、配信の起点からのパス。 */
type Bundled<T> = T & { 'duck:path': string };

interface Bundle {
  collections: Bundled<StacCollection>[];
  'duck:catalogs': Bundled<StacCatalog>[];
}

/**
 * STACの相対リンクを、配信の起点からのパスに直す。
 *
 * **STACの相対リンクは「その文書からの相対」。** `overture/roads.json` の中の
 * `../items.parquet` は `items.parquet` を、`catalog.json` は `overture/catalog.json` を指す。
 * ここが配信の起点からの相対だと思って読むと、階層を作った瞬間に壊れる。
 *
 * 起点からのパスに正規化して返すのは、**この文字列がDuckDBの登録名を兼ねる**ため
 * (`registerFileURL`)。同じファイルを別の文字列で二重登録しないよう、
 * どの文書から辿っても同じ形にする。
 *
 * `base` は参照元の文書の、起点からのパス (`catalog.json` や `overture/roads.json`)。
 */
export function resolveHref(href: string, base: string): string {
  // 絶対URLはそのまま通す (配布元へのリンクなど、起点の外を指すものがある)。
  if (isAbsoluteUrl(href)) return href;
  // 外の文書 (公開元の STAC) の中の相対リンクは、その文書の URL から解く。
  if (isAbsoluteUrl(base)) return new URL(href, base).href;
  // URLの解決規則に任せる。起点は実在しなくてよいので固定の土台を置く。
  const root = 'https://duck.invalid/';
  return new URL(href, new URL(base, root)).href.slice(root.length);
}

/** `https:` などで始まる絶対URLか (カタログの外を指すもの)。 */
export const isAbsoluteUrl = (href: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(href);

/**
 * STAC の文書を読む。`path` は配信の起点からのパスか、**外の文書の絶対URL**
 * (公開元の STAC。AW3D30 なら JAXA Earth API)。
 *
 * 外の文書は**型を見ずに JSON として読む。** JAXA の置き場所は `binary/octet-stream` で返すので、
 * ブラウザでリンクを開くとダウンロードになってしまう (ページの中で見せる理由)。
 */
export async function fetchStac<T>(path: string): Promise<T> {
  const external = isAbsoluteUrl(path);
  const response = await fetch(external ? path : dataUrl(path));
  if (!response.ok) {
    throw new Error(
      external
        ? `${path} が読めません (${response.status})`
        : `${path} が読めません (${response.status})。` +
            '`cargo run --bin build_catalog -- ../data/output` を実行してください。',
    );
  }
  return (await response.json()) as T;
}

/**
 * 全Collectionを読む。**カタログに書かれた順に返す** (一覧の並びになる。まとめはその順で入っている)。
 *
 * Collectionは**ファイルが増えても大きくならない** (収録範囲は全体の1件だけ、
 * 列構成と語彙は出所ごとに1つ) ので、起動時に全部読んでよい。
 * ファイル1つずつの情報を持つItemは、使う段になってから読む。
 */
export async function fetchCollections(language: keyof typeof BUNDLE_PATHS): Promise<Collection[]> {
  const bundle = await fetchStac<Bundle>(BUNDLE_PATHS[language]);
  // 見出しはサブカタログ。Collection の `parent` リンクがどれを指すかで結ぶ
  // (リンクはその文書からの相対なので、置き場所から解いて比べる)。
  const groups = new Map(
    bundle['duck:catalogs'].map((catalog) => [
      catalog['duck:path'],
      {
        id: catalog.id,
        title: catalog.title ?? catalog.id,
        description: catalog.description ?? '',
        path: catalog['duck:path'],
      } satisfies CatalogGroup,
    ]),
  );
  return bundle.collections.map((document) => {
    const path = document['duck:path'];
    const parent = document.links.find((link) => link.rel === 'parent');
    // ルート直下の Collection は、どのサブカタログにも当たらない (見出しなし)。
    const group = parent ? groups.get(resolveHref(parent.href, path)) : undefined;
    return toCollection(document, path, group);
  });
}

/**
 * stac-geoparquet から Item を読む関数。`collection` を省くと全部。
 *
 * **DuckDB が起きたところで差し込む** (`setItemReader`)。Parquet を読むのに DuckDB を使うので、
 * ここ (カタログを読む側) は DuckDB を知らない。差し込まれる前に呼ばれたら、差し込まれるまで待つ。
 */
export type ItemReader = (file: string, collection?: string) => Promise<StacItem[]>;

let resolveItemReader!: (reader: ItemReader) => void;
const itemReader = new Promise<ItemReader>((resolve) => (resolveItemReader = resolve));

export function setItemReader(reader: ItemReader): void {
  resolveItemReader(reader);
}

/** stac-geoparquet の Item を読む。`file` は配信の起点からのパス。 */
export async function readItems(file: string, collection?: string): Promise<StacItem[]> {
  return (await itemReader)(file, collection);
}

/**
 * **Item を読んだ Collection の ID** (読んだ順)。E2E が「使わないものを読んでいない」ことを確かめる。
 *
 * 以前は `*-items.json` の通信を数えていたが、まとめた今はファイルが1つなので、通信では見分けられない。
 */
export const itemsLoaded: string[] = [];

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

  // Item は stac-geoparquet のアセット (roles に `stac-items`) が指す。
  const itemsHref = Object.values(document.assets ?? {}).find((asset) =>
    asset.roles?.includes('stac-items'),
  )?.href;
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
    // アセットのhrefも文書からの相対。外部のものは絶対URLなのでそのまま通る。
    assets: Object.fromEntries(
      Object.entries(document.assets ?? {}).map(([key, asset]) => [
        key,
        { ...asset, href: resolveHref(asset.href, path) },
      ]),
    ),
    themes: document['duck:themes'],
    generatorOptions: document['duck:generator_options'],
    tileLink: document.links.find(
      (link) => link.rel === 'xyz' || link.rel === 'tilejson' || link.rel === '3d-tiles',
    ),
    derivedFrom: document.links
      .filter((link) => link.rel === 'derived_from')
      .map((link) => resolveHref(link.href, path)),
    viewer: document.links.find((link) => link.rel === 'alternate' && link.type === 'text/html')?.href,
    // `hreflang` の付いたものは同じ文書の別の言語 (Language extension) で、公開元ではない。
    sourceStac: document.links.find(
      (link) => link.rel === 'alternate' && link.type === 'application/json' && !link.hreflang,
    )?.href,
    isDefault: document['duck:default'] === true,
    zoom: document['duck:zoom'],
    tileSize: document['duck:tile_size'],
    dem: document['duck:dem'],
    demEncoding: document['duck:dem']?.encoding,
    bbox,
    summaries: document.summaries ?? {},
    columns: new Set(
      (document.item_assets?.data?.['table:columns'] ?? []).map((column) => column.name),
    ),
    items: () =>
      (items ??= itemsPath
        ? readItems(itemsPath, document.id).then((features) => {
            itemsLoaded.push(document.id);
            // Itemのアセットは**stac-geoparquet のファイルからの相対**。
            return features.map((feature) => ({ feature, base: itemsPath }));
          })
        : Promise.resolve([])),
  };
}

/** Itemのアセットを、配信の起点からのパスに直す。 */
export function itemFile(item: LocatedItem): string {
  return resolveHref(item.feature.assets.data.href, item.base);
}

/** Itemを配信パスと収録範囲の組にする。 */
export function itemFiles(items: LocatedItem[]): ItemFile[] {
  return items.map(({ feature, base }) => ({
    file: resolveHref(feature.assets.data.href, base),
    bbox: feature.bbox?.length === 4 ? (feature.bbox as Bbox) : null,
    sourceLod: parseSourceLod(feature.properties['duck:source_lod']),
  }));
}

/** ファイル1つ分。収録範囲と、原典がどこまで細かいか。 */
export interface ItemFile {
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
export function parseSourceLod(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((lod) => Number.isFinite(lod))
    .sort((a, b) => a - b);
}
