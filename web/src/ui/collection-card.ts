/**
 * **ⓘ のカード** (このデータについて)。Collection 1つぶんの中身と、「この範囲を取得」。
 *
 * **カタログに書いてあることだけを出す。** 絞り込みだけでは、行の裏にあるのがどの
 * Collection で、何ファイルあって、元の JSON はどこか、が画面から辿れない。
 */
import type * as duckdb from '@duckdb/duckdb-wasm';
import { dataUrl, itemFile, type Bbox, type Collection, type DatasetKind } from '../lib/stac';
import { EXACT_LOD, bboxOverlaps, type ViewBounds } from '../lib/sources';
import { meshCodesInView } from '../lib/mesh';
import { CITYGML_TYPES, fetchCityGmlFiles, packCityGml, type CityGmlFile } from '../lib/plateau-api';
import { DEM_ENCODING_LABELS, DEM_VERTICAL_LABELS, GEOMETRY_LABELS } from '../lib/tiles';
import { externalLink, termsBadges } from './credits';
import { formatBytes, saveBytes } from './download';

export interface CollectionCardOptions {
  collections: Collection[];
  conn: duckdb.AsyncDuckDBConnection;
  ensureSpatial: () => Promise<void>;
  /** 配信パスを DuckDB に登録する (表示で使っていないファイルも書き出すため)。 */
  registerFiles: (files: string[]) => Promise<void>;
  /** 問い合わせの結果を Parquet にして返す。 */
  exportParquet: (select: string, kv: Record<string, string>) => Promise<Uint8Array>;
  currentBounds: () => ViewBounds;
  /** STAC の文書をページの中で開く。 */
  openStac: (path: string) => void;
  /** 「作られた元」を押したとき、その Collection のカードを出す。 */
  showCollection: (collection: Collection) => void;
}

export interface CollectionCards {
  card: (collection: Collection) => HTMLElement;
  /** 配信している JSON そのものを開くボタン。**カタログが実在することを見せる。** */
  jsonLink: (path: string | undefined, label: string) => HTMLElement;
}

/** 切り出しで書き出す行の上限。DuckDB-WASM のメモリの中にファイルを作るため。 */
const MAX_EXPORT_ROWS = 300_000;

const formatBbox = ([west, south, east, north]: Bbox) =>
  `${west.toFixed(2)}, ${south.toFixed(2)} – ${east.toFixed(2)}, ${north.toFixed(2)}`;

type Fact = (term: string, ...value: (string | Node)[]) => HTMLElement;

/** STAC Browser の置き場所 (末尾は `/`)。開発中は置いていないので空。 */
const STAC_BROWSER_URL: string = import.meta.env.VITE_STAC_BROWSER_URL ?? '';

export function createCollectionCards(options: CollectionCardOptions): CollectionCards {
  const { collections, conn, ensureSpatial, registerFiles, exportParquet, currentBounds, openStac } = options;

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
          renderCityGml(result, await fetchCityGmlFiles(codes));
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
    const types = [...new Set(files.map((f) => f.type))].sort((a, b) =>
      a === 'bldg' ? -1 : b === 'bldg' ? 1 : a.localeCompare(b),
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
          li.append(
            externalLink(file.url, `${file.code}`),
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

  /**
   * 外部のタイルセットのカード。**ファイルも列も無い** (Itemを持たず、SQLでは引けない)。
   * 代わりに形式・大きさ・ズーム・層と、どう作ったか (簡略化の度合い) を出す。
   */
  const vectorTilesFacts = (collection: Collection, fact: Fact): HTMLElement[] => {
    const data = collection.assets.data;
    if (data) {
      const size = data['file:size'];
      fact('形式', 'PMTiles', size ? ` (${formatBytes(size)})` : '', ' ', externalLink(data.href, 'タイル'));
      const zoom = data['duck:zoom'];
      if (zoom) fact('ズーム', `${zoom[0]}〜${zoom[1]} (それより寄ると拡大して描く)`);
    }
    fact('引き方', '重ねて見るだけ。SQL では引けない (表示用に簡略化されている)');
    // **配布元の描き方は使っていない。** 形の種類 (カタログに載っている) から描いている。
    fact('描き方', 'データだけを読み、形 (面・線・点) ごとにこのアプリが描く');
    if (collection.bbox) fact('範囲', formatBbox(collection.bbox));

    // 層は24あるので、テーマごとにたたんでおく。属性も添える (ホバーで読めるもの)。
    const themes = collection.themes ?? [];
    const layersEl = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `層 (${themes.reduce((sum, theme) => sum + theme.layers.length, 0)})`;
    const list = document.createElement('ul');
    list.className = 'vector-layer-list';
    for (const theme of themes) {
      for (const layer of theme.layers) {
        const item = document.createElement('li');
        const fields = layer.fields.length > 0 ? ` — ${layer.fields.join(', ')}` : '';
        const shape = layer.geometry ? `${GEOMETRY_LABELS[layer.geometry] ?? layer.geometry}・` : '';
        item.textContent = `${theme.title} › ${layer.title} (${layer.id}、${shape}ズーム${layer.minzoom}〜)${fields}`;
        list.append(item);
      }
    }
    layersEl.append(summary, list);

    const nodes: HTMLElement[] = [layersEl];
    // **どう作ったか。** tippecanoe の `-S` (簡略化) などが読める。判定に使えない根拠。
    if (collection.generatorOptions) {
      const generator = document.createElement('details');
      const generatorSummary = document.createElement('summary');
      generatorSummary.textContent = '作り方 (配布元のメタデータ)';
      const code = document.createElement('pre');
      code.className = 'generator-options';
      code.textContent = collection.generatorOptions.replace(/; /g, ';\n');
      generator.append(generatorSummary, code);
      nodes.push(generator);
    }
    return nodes;
  };

  /**
   * 外部の地図タイル・標高のカード。**ファイルも列も無い** (タイルは1ファイルではない)。
   * どこから読んでいるか (タイルのURL・TileJSON) と、タイルがあるズームを出す。
   */
  const tileFacts = (collection: Collection, fact: Fact) => {
    const link = collection.tileLink;
    if (link?.rel === '3d-tiles') {
      fact('形式', '3D Tiles ', externalLink(link.href, 'tileset.json'));
    } else if (link) {
      const tileJson = link.rel === 'tilejson';
      // XYZ のテンプレートはそのままでは開けないので、文字で見せる (TileJSON はリンク)。
      const where = tileJson ? externalLink(link.href, 'TileJSON') : document.createElement('code');
      if (!tileJson) where.textContent = link.href;
      const kind = collection.kind === 'terrain' ? '標高タイル' : '地図タイル';
      fact('形式', `${kind} (${tileJson ? 'TileJSON' : 'XYZ'}) `, where);
    }
    // **標高の中身の約束** (エンコード・高さの基準・値なしの扱い)。同じ「標高タイル」でも違う。
    if (collection.dem) {
      fact('標高の形式', DEM_ENCODING_LABELS[collection.dem.encoding] ?? collection.dem.encoding);
      fact('高さの基準', DEM_VERTICAL_LABELS[collection.dem.vertical] ?? collection.dem.vertical);
      if (collection.dem.description) fact('読み方', collection.dem.description);
    }
    if (collection.zoom && collection.kind !== 'reference') {
      fact('ズーム', `${collection.zoom[0]}〜${collection.zoom[1]} (それより寄ると拡大して描く)`);
    }
    const use: Partial<Record<DatasetKind, string>> = {
      terrain: '地図を立体にするだけ。SQL では引けない',
      raster_tiles: '下に敷いて見るだけ。SQL では引けない',
      '3d_tiles': 'この地図 (MapLibre) では描けない。公式のビューアで見る',
      reference: 'このカタログからは配っていない (作られた元として載せている)',
    };
    if (use[collection.kind]) fact('引き方', use[collection.kind]!);
    if (collection.viewer) fact('ビューア', externalLink(collection.viewer, '公式のビューアで開く'));
    if (collection.bbox) fact('範囲', formatBbox(collection.bbox));
  };

  /**
   * **作られた元** (`derived_from`)。押すとその Collection のカードに移る (カタログを辿れる)。
   * 「Mapterhorn の日本は基盤地図情報」のような関係を、画面から追えるようにする。
   */
  const derivedFromFact = (collection: Collection, fact: Fact) => {
    if (collection.derivedFrom.length === 0) return;
    const buttons = collection.derivedFrom.map((path) => {
      const target = collections.find((c) => c.path === path);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'json-link derived-from';
      button.textContent = target ? `${target.group?.title ?? ''} › ${target.title}` : path;
      button.addEventListener('click', () => {
        if (target) options.showCollection(target);
        else openStac(path);
      });
      return button;
    });
    fact('作られた元', ...buttons.flatMap((button, i) => (i === 0 ? [button] : [' · ', button])));
  };

  const card = (collection: Collection): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'collection-card';
    el.dataset.collection = collection.id;

    const head = document.createElement('div');
    head.className = 'collection-head';
    const id = document.createElement('code');
    id.textContent = collection.id;
    head.append(id, jsonLink(collection.path, 'Collection'));
    // 同じ Collection を STAC Browser (地図ではなくページで辿る閲覧画面) で開く。
    // 公開時だけ一緒に置くので、置き場所が渡されたときだけ出す (deploy.yml)。
    if (STAC_BROWSER_URL && collection.path) {
      const browse = externalLink(`${STAC_BROWSER_URL}#/${collection.path}`, 'STAC Browser');
      browse.classList.add('json-link');
      browse.title = 'STAC Browser で開く (別のタブ)';
      head.append(browse);
    }

    const description = document.createElement('p');
    description.className = 'collection-description';
    description.textContent = collection.description;

    const facts = document.createElement('dl');
    facts.className = 'collection-facts';
    const fact: Fact = (term, ...value) => {
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
        collection.license === 'other' ? externalLink(collection.attributionUrl, '利用規約') : collection.license,
      );
    }
    if (collection.provider) fact('提供', collection.provider);
    if (collection.vintage) fact('版', collection.vintage);
    if (collection.kind === 'vector_tiles') {
      el.append(head, description, facts, ...vectorTilesFacts(collection, fact));
      return el;
    }
    derivedFromFact(collection, fact);
    if (
      collection.kind === 'raster_tiles' ||
      collection.kind === 'terrain' ||
      collection.kind === '3d_tiles' ||
      collection.kind === 'reference'
    ) {
      tileFacts(collection, fact);
      el.append(head, description, facts);
      return el;
    }
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

    el.append(head, description, facts, columns);
    if (collection.itemsPath && collection.columns.has('geometry')) {
      el.append(downloadSection(collection));
    }
    return el;
  };

  return { card, jsonLink };
}
