/**
 * **DuckDB-WASM の初期化と、カタログからデータの出所を組み立てる部分。** 画面にも地図にも依存しない。
 *
 * 起動時に読むのは行政区域とその名称だけ。地名・駅・路線・建物などは、
 * 使うときに初めて Item を読み、ファイルを DuckDB に教える (`ensure*` / `source.ensure()`)。
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import { dataUrl, itemFile, itemFiles, resolveHref, type Collection, type DatasetKind } from './stac';
import {
  LINE_KINDS,
  type BuildingCoverage,
  type BuildingSource,
  type LineKind,
  type LineSource,
  type MeshSource,
  type RailwaySource,
  type RoadSource,
} from './sources';

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

/**
 * 初回に一度だけ実行し、以降は同じ結果を返す。
 * 並行して呼ばれても実行は1回で、両方とも完了を待てる。
 */
export function once(run: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | undefined;
  return () => (started ??= run());
}

export interface Database {
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
}

/**
 * DuckDB-WASM を起こし、カタログから出所を組み立てる。
 *
 * 出所は**表示範囲と重なるファイルだけを選ぶ**ために使う (カタログを空間索引として使う)。
 * 建物は都市ごとに1ファイルで、PLATEAUを全国に広げると300を超える。全部を
 * `read_parquet([...])` に渡すと、**ファイルの数だけフッターを読みに行く** (1ファイル1往復)。
 */
export async function initDuckDb(collections: Collection[]): Promise<Database> {
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

  /**
   * Collection の Item を読み、ファイルを DuckDB に教える。**使うときに一度だけ** (`once`)。
   * 建物・メッシュ・鉄道・道路・線で同じ形なので、ここで1つにする。
   */
  const lazyFiles = (collection: Collection, assign: (files: ReturnType<typeof itemFiles>) => void) =>
    once(async () => {
      const files = itemFiles(await collection.items());
      assign(files);
      await register(files.map(({ file }) => file));
      await ensureSpatial();
    });

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
  const adminNamesItem = adminNamesCollection ? (await adminNamesCollection.items())[0] : undefined;
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
    const files = (await Promise.all(oazaCollections.map((c) => c.items()))).flat().map(itemFile);
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
  // 引くときに表示範囲と重なるものだけを渡す (`filesInView`)。
  const buildingCollections = collections.filter(
    (c) => c.kind === 'plateau_buildings' || c.kind === 'buildings',
  );
  const buildingSources: BuildingSource[] = buildingCollections.map((collection) => {
    // **整備範囲を結び付ける。** `duck:covers` がこのCollectionを指しているものを
    // 探す。IDの綴りで判断しない (出所が増えたときに書き足す場所が分かれる)。
    const coverageCollection = byKind('building_coverage').find((c) => c.covers === collection.id);
    let coverage: BuildingCoverage | undefined;
    if (coverageCollection && coverageCollection.meshDigits !== undefined) {
      const cover: BuildingCoverage = {
        files: [],
        meshDigits: coverageCollection.meshDigits,
        ensure: lazyFiles(coverageCollection, (files) => (cover.files = files)),
      };
      coverage = cover;
    }

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
      ensure: lazyFiles(collection, (files) => (source.files = files)),
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
      ensure: lazyFiles(collection, (files) => (source.files = files)),
    };
    return [source];
  });

  // 鉄道。路線と駅で列構成が違うのでCollectionが分かれている。
  // どちらも無ければ鉄道の節を出さないだけで、他の機能は動く。
  const railwaySources: RailwaySource[] = (['railway', 'railway_station'] as const).flatMap((kind) => {
    const collection = byKind(kind)[0];
    if (!collection) return [];
    const source: RailwaySource = {
      id: collection.id,
      kind,
      bbox: collection.bbox,
      files: [],
      coarseLodToleranceM: collection.coarseLodToleranceM,
      ensure: lazyFiles(collection, (files) => (source.files = files)),
    };
    return [source];
  });

  // 道路。無ければ道路の節を出さないだけで、他の機能は動く。
  const roadCollection = byKind('road')[0];
  let roadSource: RoadSource | undefined;
  if (roadCollection) {
    const source: RoadSource = {
      id: roadCollection.id,
      bbox: roadCollection.bbox,
      files: [],
      coarseLodToleranceM: roadCollection.coarseLodToleranceM,
      ensure: lazyFiles(roadCollection, (files) => (source.files = files)),
    };
    roadSource = source;
  }

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
        ensure: lazyFiles(collection, (files) => (source.files = files)),
      };
      return source;
    });

  // 路線の索引と、区間そのもの。**検索とハイライトのときだけ**読む。
  const routeCollection = byKind('road_route')[0];
  const ensureRoutes =
    routeCollection && roadCollection
      ? once(async () => {
          const first = (await routeCollection.items())[0];
          if (!first) return;
          const routeFile = itemFile(first);
          await register([routeFile]);
          await conn.query(`CREATE VIEW road_route AS SELECT * FROM read_parquet('${routeFile}');`);
          // ハイライトは区間の方から引くので、同じ経路で用意しておく。
          const files = (await roadCollection.items()).map(itemFile);
          await register(files);
          const list = files.map((file) => `'${file}'`).join(', ');
          await conn.query(`CREATE VIEW road AS SELECT * FROM read_parquet([${list}]);`);
          await ensureSpatial();
        })
      : undefined;

  // 絞り込みの選択肢はカタログの語彙から作る。**事業者種別の列名をここに書かない**のは
  // 建物の用途と同じ理由で、語彙を出すかどうかをパイプライン側の一箇所で決めるため。
  const railwayCollection = railwaySources[0] ? byKind(railwaySources[0].kind)[0] : undefined;

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
    railwayInstitutionTypes: (railwayCollection?.summaries['institution_type'] ?? []) as string[],
    railwayVintage: railwayCollection?.vintage,
    roadSource,
    lineSources,
    // 等級の語彙もカタログから。鉄道の事業者種別と同じ扱い。
    roadClasses: (roadCollection?.summaries['class'] ?? []) as string[],
    roadVintage: roadCollection?.vintage,
    ensureRoutes,
    ensureSpatial,
    ensureOaza,
    ensureStations,
    ensureSections,
  };
}
