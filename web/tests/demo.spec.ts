import { test, expect, type Page } from '@playwright/test';
import type { MapLibreMap, GeoJSONSource } from 'maplibre-gl';

/** main.ts がテスト用に公開しているもの。 */
type TestWindow = { __map?: MapLibreMap; __dataUrl?: (file: string) => string };

/** 行政区域データセット。逆ジオコーディングと転送量の計測がこれを見る。 */
const ADMIN_DATASET = 'overture_admin_jp';
/** 建物データセット。無くても他の機能は動くので、無ければスキップする。 */
const BUILDINGS_DATASET = 'overture_buildings_minato';
/** PLATEAUの建物。高さ・用途を持つので、絞り込みはこちらでしか出ない。 */
const PLATEAU_DATASET = 'plateau_bldg_minato';

interface StacLink {
  rel: string;
  href: string;
}

/**
 * データセットのURLを**STACを辿って**引く。
 *
 * 配信時のパスはItemのアセットが持っている (出所ごとにディレクトリを
 * 切っているので `overture/....parquet` のような形)。テストにパスを書くと、
 * 置き場所を変えるたびに書き換えることになる。**Item IDだけを書く。**
 *
 * 見つからなければ null。開発サーバーは存在しないファイルに index.html を
 * 200で返すので、HEADの成否だけでは「配信されているか」を判定できない。
 */
async function datasetUrl(page: Page, id: string): Promise<string | null> {
  const fetchJson = async <T>(href: string): Promise<T | null> => {
    const response = await page.request.get(await resolveDataUrl(page, href));
    return response.ok() ? ((await response.json()) as T) : null;
  };

  const catalog = await fetchJson<{ links: StacLink[] }>('catalog.json');
  if (!catalog) return null;

  for (const child of catalog.links.filter((link) => link.rel === 'child')) {
    const collection = await fetchJson<{ links: StacLink[] }>(child.href);
    const itemsHref = collection?.links.find((link) => link.rel === 'items')?.href;
    if (!itemsHref) continue;
    const items = await fetchJson<{
      features: { id: string; assets: { data: { href: string } } }[];
    }>(itemsHref);
    const item = items?.features.find((feature) => feature.id === id);
    if (item) return resolveDataUrl(page, item.assets.data.href);
  }
  return null;
}

/** 建物データが配信されているか。 */
async function hasBuildings(page: Page): Promise<boolean> {
  return (await datasetUrl(page, BUILDINGS_DATASET)) !== null;
}

async function hasPlateau(page: Page): Promise<boolean> {
  return (await datasetUrl(page, PLATEAU_DATASET)) !== null;
}

/** PLATEAUの建物が見える状態にする。PLATEAUは既定の出所なので選び直さない。 */
async function showPlateauBuildings(page: Page) {
  await openLayerSettings(page, 'buildings');
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 16 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);
}

/**
 * 配信パスから実際のURLをアプリに解決させる。
 *
 * データは開発時と公開時で置き場所が変わる (同一オリジンの /data/ か、
 * オブジェクトストレージか)。テストにURLを書くと公開URLに対して流せなくなるので、
 * アプリが使っているのと同じ組み立てを借りる。
 */
function resolveDataUrl(page: Page, file: string): Promise<string> {
  return page.evaluate((name) => {
    const resolve = (window as unknown as TestWindow).__dataUrl;
    if (!resolve) throw new Error('__dataUrl が公開されていない');
    return resolve(name);
  }, file);
}

/**
 * このデモは変換済みのGeoParquetを読む。data/ はgit管理外なので、
 * 変換をまだ実行していない環境ではテストを失敗させずスキップする
 * (Rust側の tests/real_data.rs と同じ方針)。
 */
async function skipIfDataMissing(page: Page) {
  const url = await datasetUrl(page, ADMIN_DATASET);
  test.skip(
    url === null,
    `${ADMIN_DATASET} がカタログに無い (READMEの手順で用意してください)`,
  );
}

/**
 * 表示パネルの節を開く。
 *
 * できることは1枚のパネルにまとめてあり、**中身は既定でたたんである**。
 * 見出しだけが並ぶので「何ができるか」は読めるが、操作するには開く必要がある。
 *
 * **データのレイヤーはここには無い** ([`openLayerSettings`])。節を積むと
 * オープンデータが増えるだけ縦に伸びるので、一覧に移してある。
 */
async function openSection(page: Page, id: string) {
  await page.locator(`#${id} > summary`).click();
  await expect(page.locator(`#${id}`)).toHaveAttribute('open', '');
}

/**
 * レイヤーの設定を開く。一覧の ⚙ を押すと、**パネルの中身が入れ替わる**
 * (重ねて出すと結局縦に伸びるため)。
 */
async function openLayerSettings(page: Page, layer: string) {
  await page.locator(`[data-layer="${layer}"] .layer-settings-button`).click();
  await expect(page.locator('#layer-settings')).toBeVisible();
  await expect(page.locator('#layer-list')).toBeHidden();
}

/**
 * レイヤーの表示/非表示を切り替える。
 *
 * **チェックボックスは一覧にある。** 設定を開いていると一覧は隠れているので、
 * 先に戻る。テスト側で開閉の順番を気にしなくて済むようにするため。
 */
async function setLayerVisible(page: Page, layer: string, visible: boolean) {
  if (await page.locator('#layer-settings').isVisible()) {
    await page.locator('#layer-back').click();
    await expect(page.locator('#layer-list')).toBeVisible();
  }
  const toggle = page.locator(`#layer-toggle-${layer}`);
  if (visible) await toggle.check();
  else await toggle.uncheck();
}

const showLayer = (page: Page, layer: string) => setLayerVisible(page, layer, true);
const hideLayer = (page: Page, layer: string) => setLayerVisible(page, layer, false);

/** 初期化 (DuckDB + 地図) の完了を待つ。 */
async function waitForReady(page: Page) {
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('#search-input')).toBeEnabled();
}

/** 指定したGeoJSONソースに入っている地物の数を返す。 */
function sourceFeatureCount(page: Page, sourceId: string) {
  return page.evaluate(async (id) => {
    const map = (window as unknown as TestWindow).__map;
    if (!map) return -1;
    const source = map.getSource(id) as GeoJSONSource | undefined;
    if (!source) return -1;
    const data = await source.getData();
    if (data.type === 'FeatureCollection') return data.features.length;
    return data.type === 'Feature' ? 1 : 0;
  }, sourceId);
}

function highlightFeatureCount(page: Page) {
  return sourceFeatureCount(page, 'highlight');
}

/**
 * 逆ジオコーディングを起こす。📍を押した直後の1クリックしか効かないので、
 * 地図を押す前に必ずツールを立ち上げる。
 *
 * `position` を省くと地図の中央 (= `jumpTo` で指定した座標そのもの) を押す。
 * 狙った1点を判定させたいときはこちらを使う。
 */
async function pickOnMap(page: Page, position?: { x: number; y: number }) {
  await page.locator('#pick-location').click();
  await page.locator('#map canvas').click({ position });
}

/** 地形の標高タイル (Mapterhorn)。取れないときの挙動を見るテストで遮断する。 */
const TERRAIN_TILES = 'https://tiles.mapterhorn.com/*/*/*.webp';

test.beforeEach(async ({ page }) => {
  // './' であって '/' ではない。baseURL は new URL(url, baseURL) で解決されるので、
  // '/' だとサブパス配信 (GitHub Pagesなど) のときにサイトのルートへ飛んでしまう。
  // URLの解決をアプリに任せるので、先にページを開く。
  await page.goto('./');
  await skipIfDataMissing(page);
  await waitForReady(page);
});

test('初期化が完了し、地図と検索欄が使える状態になる', async ({ page }) => {
  await expect(page.locator('#map canvas')).toBeVisible();
  await expect(page.locator('#search-input')).toBeFocused();
});

// 検索欄と地図しか無いと、クリックやホバーで何が起きるのか分からない。
// 公開して最初に触る人がここで止まるので、操作は画面に書いておく。
test('使い方に操作が一通り書かれている', async ({ page }) => {
  const help = page.locator('#help');
  await expect(help).toBeVisible();
  await expect(help).toContainText('検索');
  await expect(help).toContainText('クリック');
  await expect(help).toContainText('カーソルを合わせる');
  // 出した結果の消し方。ここに書いていないと×とEscに気づけない。
  await expect(help).toContainText('Esc');
});

test('地名を入力すると候補が表示される', async ({ page }) => {
  await page.locator('#search-input').fill('港区');

  const results = page.locator('#results li');
  await expect(results.first()).toBeVisible();
  // 行政区域(全国)と地名(東京都・神奈川県)の両方から引くので、種別バッジが付く。
  await expect(results.first()).toContainText('港区');
});

// 該当が無いときに一覧ごと消えると、読み込み中と区別がつかない。
// 地名は収録した都道府県の分しか無いので、この状態には普通に到達する。
test('該当しない地名を検索するとその旨が出る', async ({ page }) => {
  await page.locator('#search-input').fill('ぬけぬけ村');

  await expect(page.locator('#results li')).toHaveText('該当する地名がありません');
});

test('行政区域を選ぶとポリゴンがハイライトされる', async ({ page }) => {
  expect(await highlightFeatureCount(page)).toBe(0);

  await page.locator('#search-input').fill('港区');
  await page.locator('#results li', { hasText: '行政区域' }).first().click();

  await expect
    .poll(() => highlightFeatureCount(page), { message: 'ハイライトが設定されるまで待つ' })
    .toBe(1);
});

test('📍を押してから地図をクリックすると逆ジオコーディングされる', async ({ page }) => {
  // 東京駅付近へ移動してから中央をクリックする。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7671, 35.6812], zoom: 13 });
  });

  await pickOnMap(page, { x: 400, y: 300 });

  const popup = page.locator('.maplibregl-popup-content');
  await expect(popup).toBeVisible();
  // 「判定中…」から確定した地名に変わることを確認する。
  await expect(popup).toContainText('東京都', { timeout: 30_000 });

  // 逆ジオコーディングの結果は検索欄にも反映される。
  await expect(page.locator('#search-input')).toHaveValue(/東京都/);

  // 1クリックで解除される。押しっぱなしだと、次に建物を触るつもりの
  // クリックでまた地図が引き戻されることになる。
  await expect(page.locator('#pick-location')).toHaveAttribute('aria-pressed', 'false');
});

// 建物を眺めている最中のクリックで行政区域の全体まで引き戻される、という
// 事故を防ぐためにツール化した。押さずにクリックしても何も起きないこと。
test('📍を押さずに地図をクリックしても何も起きない', async ({ page }) => {
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7671, 35.6812], zoom: 13 });
  });
  const before = await page.evaluate(() => (window as unknown as TestWindow).__map!.getZoom());

  await page.locator('#map canvas').click({ position: { x: 400, y: 300 } });

  await expect(page.locator('.maplibregl-popup-content')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as TestWindow).__map!.getZoom())).toBe(before);
  expect(await highlightFeatureCount(page)).toBe(0);
});

// 押したものの気が変わったときの出口。
test('Escで📍を解除できる', async ({ page }) => {
  const pick = page.locator('#pick-location');
  await pick.click();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Escape');
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
});

/**
 * 出した結果を消す手段。ハイライトとポップアップは1つの結果なので、
 * 片方を閉じたら両方消える。
 *
 * Escは判定した直後 (フォーカスが地図側にある状態) でも効く必要がある。
 * 検索欄のkeydownに付けていると、この場面では効かない。
 */
for (const how of ['close-button', 'escape'] as const) {
  test(`判定結果を${how === 'close-button' ? '×' : 'Esc'}で消せる`, async ({ page }) => {
    await page.evaluate(() => {
      const map = (window as unknown as TestWindow).__map!;
      map.jumpTo({ center: [139.7671, 35.6812], zoom: 13 });
    });
    await pickOnMap(page, { x: 400, y: 300 });
    await expect(page.locator('.maplibregl-popup-content')).toContainText('東京都', {
      timeout: 30_000,
    });
    await expect.poll(() => highlightFeatureCount(page)).toBe(1);

    if (how === 'close-button') {
      await page.locator('.maplibregl-popup-close-button').click();
    } else {
      await page.keyboard.press('Escape');
    }

    await expect(page.locator('.maplibregl-popup-content')).toHaveCount(0);
    await expect.poll(() => highlightFeatureCount(page)).toBe(0);
  });
}

// 地図をクリックしただけで結果が消えると、📍ボタン化して取り除いたはずの
// 「勝手に変わる」感覚が戻ってくる。消えるのは×とEscのときだけ。
test('地図をクリックしても判定結果は消えない', async ({ page }) => {
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7671, 35.6812], zoom: 13 });
  });
  await pickOnMap(page, { x: 400, y: 300 });
  await expect(page.locator('.maplibregl-popup-content')).toContainText('東京都', {
    timeout: 30_000,
  });
  // ポップアップの文字はポリゴンの取得より先に出る。揃うまで待ってから押す。
  await expect.poll(() => highlightFeatureCount(page)).toBe(1);

  await page.locator('#map canvas').click({ position: { x: 200, y: 200 } });

  await expect(page.locator('.maplibregl-popup-content')).toBeVisible();
  expect(await highlightFeatureCount(page)).toBe(1);
});

// Overtureの行政区域は class='land' で絞ってもなお東京湾を跨いでいる。
// パイプラインで海域を切り抜いてあることの確認 (data/output を作り直すまで落ちる)。
test('海上を指しても自治体は返らない', async ({ page }) => {
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    // 葛西沖。もっとも近い陸地から2kmほど離れている。
    map.jumpTo({ center: [139.85, 35.55], zoom: 13 });
  });

  // 狙った1点を判定させたいので、中央を押す。
  await pickOnMap(page);

  await expect(page.locator('.maplibregl-popup-content')).toContainText('該当する行政区域', {
    timeout: 30_000,
  });
});

/**
 * 逆ジオコーディングは全国の行政区域 (数十MB) に対する点クエリなので、
 * ファイル全体を読んでしまうと静的ホスティングでは成立しない。
 *
 * 成立させるには3つが噛み合う必要があり、どれが欠けても静かに全件取得に戻る。
 * - GeoParquetが空間的に並べ替えられ、row groupに分かれていること
 *   (pipeline/src/spatial_pack.rs)
 * - DuckDB-WASMの filesystem 設定 (web/src/main.ts)
 * - 配信側がRangeリクエストを正しく扱うこと (開発時は vite.config.ts、
 *   公開時はオブジェクトストレージのCORS設定)
 *
 * どれも実行時に警告が出ないので、転送量そのものを見張る。
 * 公開URLに対しても流せるよう、URLはアプリに解決させている。
 */
test('逆ジオコーディングはファイル全体のごく一部しか読まない', async ({ page }) => {
  // beforeEach の skipIfDataMissing を通っているので、ここでは必ずある。
  const dataset = (await datasetUrl(page, ADMIN_DATASET))!;
  const totalBytes = Number((await page.request.head(dataset)).headers()['content-length']);
  expect(totalBytes).toBeGreaterThan(0);

  // 初期化を含めて、このファイルの取得量を数える。
  let fetchedBytes = 0;
  page.on('response', (response) => {
    if (response.url() !== dataset) return;
    // HEADは本文を返さないが Content-Length に全体サイズを載せるので数えない。
    if (response.request().method() === 'HEAD') return;
    fetchedBytes += Number(response.headers()['content-length'] ?? 0);
  });
  await page.reload();
  await waitForReady(page);

  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7671, 35.6812], zoom: 13 });
  });
  await pickOnMap(page, { x: 400, y: 300 });
  await expect(page.locator('.maplibregl-popup-content')).toContainText('東京都', {
    timeout: 30_000,
  });

  const measured =`${(fetchedBytes / 1024 / 1024).toFixed(1)} MB / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`;
  console.log(`逆ジオコーディングの転送量: ${measured}`);

  // 0バイトなら「絞り込めている」のではなく「計測できていない」ので、そちらも弾く。
  expect(fetchedBytes, `転送量を計測できていない: ${measured}`).toBeGreaterThan(0);
  expect(fetchedBytes, `読みすぎ: ${measured}`).toBeLessThan(totalBytes * 0.1);
});

// spatial拡張はDuckDB本体と同じく自前配信にしてある (web/duckdb-extensions.ts と
// web/vite.config.ts)。本家 (extensions.duckdb.org) への通信を断ってもINSTALLが
// 成立することを確かめないと、自前配信が効いていなくても他のテストは素通りしてしまう
// (INSTALLはキャッシュがあれば本家へは行かないため)。
test('extensions.duckdb.org を遮断しても逆ジオコーディングできる', async ({ page }) => {
  await page.route('https://extensions.duckdb.org/**', (route) => route.abort());
  await page.reload();
  await waitForReady(page);

  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7671, 35.6812], zoom: 13 });
  });
  await pickOnMap(page, { x: 400, y: 300 });
  await expect(page.locator('.maplibregl-popup-content')).toContainText('東京都', {
    timeout: 30_000,
  });
});

/**
 * カタログをSTACに分けたのは**使わないものを読まないため**。
 *
 * 1ファイルに全部入れていた頃は、人口メッシュ47件を足しただけで72KBになり、
 * 起動時に毎回そこまで待つことになっていた。PLATEAUを306都市に広げれば
 * 460KB前後に達する見込みだった。
 *
 * Collection (何があるか) は件数で増えないので起動時に読む。
 * Item (ファイル1つずつの href と bbox) は使う段になって読む。
 */
test('使わないデータのItemは起動時に読まない', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('-items.json')) requested.push(path.split('/').pop()!);
  });
  await page.reload();
  await waitForReady(page);

  // 行政区域だけは起動時に要る。どのファイルを読むかが決まらないため。
  expect(requested.some((file) => file.startsWith('overture-admin'))).toBe(true);
  // 人口メッシュ (47ファイル・80KB) は、まだ誰も要求していない。
  expect(requested.filter((file) => file.startsWith('estat-mesh-pop'))).toEqual([]);
  // 建物も寄るまで読まない。収録範囲の枠と絞り込みの選択肢はCollectionで足りる。
  expect(requested.filter((file) => file.startsWith('plateau-'))).toEqual([]);

  // 寄れば読みに行く。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 16 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);
  expect(requested.some((file) => file.startsWith('plateau-'))).toBe(true);
});

// 出典は既定でたたんである。出所が6件あって、広げると452×112pxの箱になるため。
// ⓘ を押せば全文が出る。**文言そのものは縮めない** (表示義務があるため)。
test('出典は既定でたたまれていて、押すと全文が出る', async ({ page }) => {
  const attribution = page.locator('.maplibregl-ctrl-attrib');
  await expect(attribution).not.toHaveClass(/maplibregl-compact-show/);

  await page.locator('.maplibregl-ctrl-attrib-button').click();
  // 出典は義務なので、法令・約款が求める文言がそのまま出ていること。
  await expect(attribution).toContainText('（国土交通省）をもとに作成');
  await expect(attribution).toContainText('ODbL');
  await expect(attribution).toContainText('国土地理院');
  // 何のデータの出典なのかが分かること。出典だけ並べても読み取れない。
  await expect(attribution).toContainText('人口メッシュ');
  await expect(attribution).toContainText('建物');
});

/**
 * ⓘ の中身はMapLibreが `" | "` のテキストで繋ぐので、1行に詰まって読みにくい。
 * ⓘ は表示義務を果たす標準の置き場所として残し、**読ませるのはパネルの側**。
 */
test('出典はパネルにデータごとの一覧として出る', async ({ page }) => {
  await openSection(page, 'credits-section');

  const terms = page.locator('#credits dt');
  // 出所は4件 (位置参照情報 / 国勢調査 / PLATEAU / Overture)。
  await expect.poll(() => terms.count()).toBeGreaterThan(2);

  // 見出しがデータ名、中身が出典の文言。1行に混ざっていない。
  const mesh = page.locator('#credits dt', { hasText: '人口メッシュ' }).first();
  await expect(mesh).toBeVisible();
  await expect(mesh.locator('xpath=following-sibling::dd[1]')).toContainText('総務省統計局');
});

/**
 * **ここにあるのは変換した複製で、原典は配布元にある。**
 * 実物が欲しくなった人が辿れるように、配布元へのリンクを出す。
 *
 * カタログでは STACの `rel: "via"` (「このEntityが作られる元になった
 * メタデータ/データ」) として持っている。出典表示のリンク先とは別物で、
 * 例えばOvertureは出典がガイドページを指すのに対し、配布元はデータのページ。
 */
test('出典に配布元へのリンクが出る', async ({ page }) => {
  await openSection(page, 'credits-section');

  const via = page.locator('#credits .via');
  await expect.poll(() => via.count()).toBeGreaterThan(2);

  // 出典の文言そのものではなく、データを取ってきた場所を指していること。
  const hrefs = await page.locator('#credits .via a').evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).href),
  );
  expect(hrefs.some((href) => href.includes('e-stat.go.jp'))).toBe(true);
  expect(hrefs.some((href) => href.includes('nlftp.mlit.go.jp'))).toBe(true);
  // Overtureは出典がガイドページ (docs.../attribution/) なので、そこと違うこと。
  expect(hrefs.some((href) => href.includes('overturemaps.org/guides/'))).toBe(true);
});

// 初見で何から触ればいいか分かるよう、**できること自体は隠さない**。
// 中身をたたむのは画面を静かにするためで、名前は開かなくても読める。
test('できることは開かなくても分かる', async ({ page }) => {
  const panel = page.locator('#data-panel');

  // データは一覧にそのまま並ぶ。**開く操作すら要らない。**
  for (const layer of ['建物', '人口密度']) {
    await expect(panel.locator('.layer-row', { hasText: layer }).first()).toBeVisible();
  }
  // データ以外は節のまま。**置き場所が違う** — 背景地図は検索欄の下、
  // 使い方と出典は右下 (MapLibreの ⓘ と同じ性格なので同じ側に集めた)。
  await expect(
    page.locator('#search-panel summary', { hasText: '地図' }).first(),
  ).toBeVisible();
  for (const heading of ['使い方', '出典']) {
    await expect(
      page.locator('#info-panel summary', { hasText: heading }).first(),
    ).toBeVisible();
  }
  // 節の中身は既定でたたんである。
  for (const id of ['map-section', 'help', 'credits-section']) {
    await expect(page.locator(`#${id}`)).not.toHaveAttribute('open', '');
  }
  // レイヤーの設定も既定では出さない (一覧が先)。
  await expect(page.locator('#layer-settings')).toBeHidden();
});

/**
 * 出典表示は出所が増えるほど行が増える。
 * 人口メッシュ (47都道府県) を足したときに1行から2行になり、全幅40pxに広がって
 * 左下のパネルを覆い、「建物のある範囲へ移動」が押せなくなった。
 *
 * たたんだいまも、広げれば同じことが起きうる。避けるのはパネル側の役目で、
 * 位置は実測した高さ (`--attribution-height`) から決めている。
 * 固定値に戻すと、出所を足したときにまた覆われる。
 */
test('出典が何行になってもパネルは覆われない', async ({ page }) => {
  // たたまれている状態では重なりようがない。**広げた状態**で見る。
  await page.locator('.maplibregl-ctrl-attrib-button').click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector('.maplibregl-ctrl-attrib')!.getBoundingClientRect().height,
      ),
    )
    .toBeGreaterThan(40);

  const overlap = await page.evaluate(() => {
    const rect = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect() ?? null;
    const attribution = rect('.maplibregl-ctrl-attrib');
    const panels = ['#data-panel', '#info-panel']
      .map((selector) => ({ selector, box: rect(selector) }))
      .filter((panel) => panel.box !== null);
    if (!attribution) throw new Error('出典表示が見つからない');
    if (panels.length === 0) throw new Error('パネルが見つからない');
    return panels
      .filter(
        ({ box }) =>
          box!.bottom > attribution.top &&
          box!.top < attribution.bottom &&
          box!.right > attribution.left &&
          box!.left < attribution.right,
      )
      .map(({ selector }) => selector);
  });
  expect(overlap).toEqual([]);
});

// 建物は一部の範囲しか収録しておらず、しかも寄らないと出てこない。
// 偶然そこへ行かないと機能に気づけないので、移動する手段を用意してある。
// 移動先はカタログの収録範囲から決まるため、データを差し替えても追随する。
test('ボタンを押すと建物のある範囲へ移動する', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データ (Overture) が無い');

  expect(await sourceFeatureCount(page, 'buildings')).toBe(0);

  await openLayerSettings(page, 'buildings');
  await page.locator('#goto-buildings').click();

  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);
  // 建物は立体で描くので、移動と同時に傾ける。傾き0のままだと真上から見ることになり、
  // 立体にした意味が伝わらない。真上に戻したいときはコンパスを押す。
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__map!.getPitch()))
    .toBeGreaterThan(0);
});

/**
 * 初期化のオーバーレイが消えたあとの待ち時間には、以前は合図が何も無かった。
 * 建物のある範囲へ移動しても、数秒のあいだ「空の地図」と見分けがつかない。
 */
test('建物を読み込んでいる間は合図が出る', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データ (Overture) が無い');

  await expect(page.locator('#busy')).toBeHidden();

  await openLayerSettings(page, 'buildings');
  await page.locator('#goto-buildings').click();
  // flyTo に1.5秒かかるので、押した直後から出ていること。
  await expect(page.locator('#busy')).toBeVisible();

  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);
  await expect(page.locator('#busy')).toBeHidden();
});

/**
 * 引いているときに書いた文言が、寄ったあとも残っていた。
 * zoom 16 にいる利用者に「拡大しろ」と言い続けることになる。
 *
 * 手元はデータの取得が速すぎるので、取得を止めて読み込み中のまま観察する。
 * 単に遅らせて最後に見るだけでは、そのころには件数に変わっていて何も検出できない。
 */
test('建物を読み込んでいる間は「寄ると出ます」と言わない', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データ (Overture) が無い');

  // **どこまで寄れば出るかを数字で言う。**文言は BUILDINGS_MIN_ZOOM から作られる。
  const zoomedOutMessage = /ズーム\d+まで寄ると出ます/;
  await expect(page.locator('#building-count')).toHaveText(zoomedOutMessage);

  // 合図を確かめるまでデータを渡さない。
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/*.parquet', async (route) => {
    await held;
    await route.continue();
  });

  await openLayerSettings(page, 'buildings');
  await page.locator('#goto-buildings').click();
  // 取得に入ったことは合図の文言で見分ける (移動中とは別の文言にしてある)。
  await expect(page.locator('#busy')).toContainText('建物を読み込み中…');

  await expect(page.locator('#building-count')).not.toHaveText(zoomedOutMessage);

  release();
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);
});

// 逆ジオコーディングは名前が先に出て、ポリゴンはもう1往復あとに届く。
// その間が無言だと「地名だけ出てポリゴンが表示されない」ように見える。
test('逆ジオコーディング中は合図が出る', async ({ page }) => {
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7671, 35.6812], zoom: 13 });
  });

  await pickOnMap(page, { x: 400, y: 300 });
  await expect(page.locator('#busy')).toBeVisible();

  await expect.poll(() => highlightFeatureCount(page)).toBe(1);
  await expect(page.locator('#busy')).toBeHidden();
});

/**
 * 地図の切り替え。
 *
 * `<select>` の値が変わっただけで実際のタイルが切り替わっていない、を弾きたいので、
 * 選択後のリクエストURLを見る。
 */
test('地図を航空写真に切り替えると写真のタイルを取りに行く', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('cyberjapandata.gsi.go.jp')) requested.push(request.url());
  });

  await openSection(page, 'map-section');
  await page.locator('#basemap').selectOption({ label: '航空写真' });

  await expect.poll(() => requested.some((url) => url.includes('/seamlessphoto/'))).toBe(true);
});

// 地図と地形は別々に選べる。片方の操作で、自分で選んだもう片方が勝手に変わらないこと。
test('地形を切っても地図は変わらない', async ({ page }) => {
  await openSection(page, 'map-section');
  await page.locator('#basemap').selectOption({ label: '航空写真' });

  await page.locator('button[class*="maplibregl-ctrl-terrain"]').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__map!.getTerrain()))
    .toBe(null);

  await expect(page.locator('#basemap')).toHaveValue('photo');
});

test('地形が有効になっていて、コンパスの下のボタンで切れる', async ({ page }) => {
  const hasTerrain = () =>
    page.evaluate(() => (window as unknown as TestWindow).__map!.getTerrain() !== null);

  expect(await hasTerrain()).toBe(true);

  // 自前のトグルは作らず、MapLibre標準の TerrainControl を置いてある。
  // 有効なときだけ class に -enabled が付くので、前方一致で拾う。
  const terrainButton = page.locator('button[class*="maplibregl-ctrl-terrain"]');
  await expect(terrainButton).toHaveClass(/maplibregl-ctrl-terrain-enabled/);

  await terrainButton.click();
  await expect.poll(hasTerrain).toBe(false);

  await terrainButton.click();
  await expect.poll(hasTerrain).toBe(true);
});

/**
 * 地形は外部サービス (Mapterhorn) から読む。**起動をそこに握らせない。**
 *
 * スタイルに terrain を書くと地形タイルの取得が map の 'load' の条件に入り、
 * Mapterhornが落ちていると読み込み中の表示から先へ進めなくなる (実際になった)。
 * 読み込み後に setTerrain で有効にすることで切り離してある。
 */
test('地形タイルが取れなくても地図は使える', async ({ page }) => {
  await page.route(TERRAIN_TILES, (route) => route.abort());
  await page.reload();
  await waitForReady(page);

  await expect(page.locator('#map canvas')).toBeVisible();
  await expect(page.locator('#search-input')).toBeEnabled();
  // 地形そのものは有効なまま (タイルが来ないので起伏が出ないだけ)。
  expect(await page.evaluate(() => (window as unknown as TestWindow).__map!.getTerrain())).not.toBe(
    null,
  );
});

// 出典表示はライセンス上の義務。tilejson 由来のものが実際に出ることを確かめる
// (手で書き足していないので、向こうが文言を変えれば追随する)。
test('出典にMapterhornが出る', async ({ page }) => {
  await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('Mapterhorn');
});

/**
 * 標高が実際に読めることを、値で確かめる。
 *
 * URL・エンコーディング (terrarium)・maxzoom のどれを間違えても起伏は出ないが、
 * 画面を見ただけでは「平野だから平ら」と区別がつかない。高尾山で数値を見る。
 */
test('標高タイルから実際の高さが読める', async ({ page }) => {
  // 高尾山 (標高599m)。ズームを上げないと細かいタイルが来ない。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.2438, 35.6251], zoom: 14 });
  });

  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as unknown as TestWindow).__map!.queryTerrainElevation([139.2438, 35.6251]),
        ),
      { message: '地形タイルが届くまで待つ', timeout: 30_000 },
    )
    .toBeGreaterThan(300);
});

test('十分に寄ると建物が表示され、離すと消える', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データ (Overture) が無い');

  // 港区あたり。建物データを切り出した範囲の中に入る。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7554, 35.6586], zoom: 16 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);

  // 引くと (閾値を下回ると) 件数が多すぎるので表示しない。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7554, 35.6586], zoom: 12 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBe(0);
});

/**
 * カタログを空間索引として使っていることを、通信で確かめる。
 *
 * 建物は都市ごとに1ファイルで、PLATEAUを全国に広げると300を超える。
 * 表示範囲と重ならないファイルまで `read_parquet` に渡すと、**中身が1件も
 * 要らなくてもフッターだけは読みに行く** (1ファイル1往復)。
 *
 * このテストは「起動時に建物のparquetへ一度も触れていない」ことが前提になる。
 * 触れていると手元にフッターが残り、範囲外へ飛んでも通信が出ないので、
 * 絞れていなくても通ってしまう。用途の選択肢をカタログから作るように
 * したのはそのため。
 */
test('表示範囲と重ならない建物データは読みに行かない', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  const plateau = await datasetUrl(page, PLATEAU_DATASET);
  const requested: string[] = [];
  page.on('request', (request) => {
    if (request.url() === plateau) requested.push(request.url());
  });

  // 大阪市の中心部。港区のデータとは重ならない。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [135.5023, 34.6937], zoom: 16 });
  });
  await expect(page.locator('#building-count')).toHaveText('0件');
  expect(requested).toEqual([]);

  // 重なる場所へ行けば読む。これが無いと「そもそも何も通信していない」だけでも
  // 上の判定が通ってしまう。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 16 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);
  expect(requested.length).toBeGreaterThan(0);
});

test('建物はホバーで情報が出て、地図は動かない', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データ (Overture) が無い');

  // 高輪ゲートウェイ駅。建物が確実にある地点を画面中央に置く。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7407, 35.6355], zoom: 17 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);

  const zoomBefore = await page.evaluate(
    () => (window as unknown as TestWindow).__map!.getZoom(),
  );

  // 画面中央に建物が描かれるまで待ってから、そこをなぞる
  // (描画前になぞってもホバーは発火しない)。
  await expect
    .poll(() =>
      page.evaluate(() => {
        const map = (window as unknown as TestWindow).__map!;
        const canvas = map.getCanvas();
        const center: [number, number] = [canvas.clientWidth / 2, canvas.clientHeight / 2];
        return map.queryRenderedFeatures(center, { layers: ['buildings-3d'] }).length;
      }),
    )
    .toBeGreaterThan(0);

  const canvas = page.locator('#map canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.hover({ position: { x: box.width / 2, y: box.height / 2 } });

  await expect(page.locator('.maplibregl-popup-content')).toBeVisible();

  // ホバーは「調べる」だけなので、地図は動かない。
  const zoomAfter = await page.evaluate(
    () => (window as unknown as TestWindow).__map!.getZoom(),
  );
  expect(zoomAfter).toBe(zoomBefore);
});

// 建物の出所ごとに持っている属性が違う。Overtureは高さが1.5%・用途が8.9%しか
// 入っておらず絞る材料にならないので、絞り込みはPLATEAUでだけ出す。
// 何で絞れるかは出所ごとに決め打ちせず、カタログの列構成から決めている。
// 決め打ちにすると「高さがあって立体では見えているのに絞れない」という
// 食い違いが起きる。どちらの出所も height 列を持つので、どちらでも絞れる。
test('絞り込みは列の有無で決まる', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  await expect(page.locator('[data-layer="buildings"]')).toBeVisible();
  await openLayerSettings(page, 'buildings');
  // 属性の揃っているPLATEAUが既定。
  await expect(page.locator('#building-source')).toHaveValue(/plateau/);
  await expect(page.locator('#building-filters')).toBeVisible();
  await expect(page.locator('#height-field')).toBeVisible();

  // 用途の選択肢はコードに書かず、カタログの語彙 (summaries) から作っている。
  // 語彙を持つ列があるかどうかで、用途で絞れるかも決まる。
  await expect.poll(() => page.locator('#usage-options label').count()).toBeGreaterThan(5);

  // Overtureも高さの列を持つので、高さでは絞れる。
  await page.locator('#building-source').selectOption({ label: 'Overture' });
  await expect(page.locator('#height-field')).toBeVisible();
});

// 1つの用途だけ見たいときに、残り13個を手で外させない。
test('用途は一括で切り替えられる', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  await showPlateauBuildings(page);
  const checked = () => page.locator('#usage-options input:checked').count();
  expect(await checked()).toBeGreaterThan(5);

  await page.locator('#usage-none').click();
  await expect.poll(checked).toBe(0);
  // 何も選んでいなければ建物も出ない。
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBe(0);

  await page.locator('#usage-options input').first().check();
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);

  await page.locator('#usage-all').click();
  await expect.poll(checked).toBeGreaterThan(5);
});

// 引くと建物は消えるので、どこにデータがあるかを枠で示す。
// 偶然その場所へ行かないと機能に気づけない、という状態を避けるため。
test('引くと収録範囲が枠で出る', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 10 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings-coverage')).toBe(1);

  // 寄れば建物が出て、枠は消える。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 16 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings-coverage')).toBe(0);
});

/**
 * 傾けると `getBounds()` は地平線方向へ広がる (実測でpitch 50度のとき面積3.1倍)。
 * そのぶん読む量が増えないことを確かめる。
 *
 * 増えないのは、絞り込みが中心からの距離順で上限に当たるため。
 * 範囲が広がっても遠景が切り捨てられるだけで、新しいrow groupを読みに行かない。
 */
test('傾けても読む量が跳ね上がらない', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  const dataset = await datasetUrl(page, PLATEAU_DATASET);
  let fetchedBytes = 0;
  page.on('response', (response) => {
    if (response.url() !== dataset) return;
    if (response.request().method() === 'HEAD') return;
    fetchedBytes += Number(response.headers()['content-length'] ?? 0);
  });

  await showPlateauBuildings(page);
  const flat = fetchedBytes;
  expect(flat, '転送量を計測できていない').toBeGreaterThan(0);

  // 同じ地点・同じズームのまま傾ける。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 16, pitch: 50 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);

  const measured = `真上 ${(flat / 1024).toFixed(0)} KB → 傾き50度 ${(fetchedBytes / 1024).toFixed(0)} KB`;
  console.log(`傾けたときの転送量: ${measured}`);
  expect(fetchedBytes, `傾けて読む量が増えすぎ: ${measured}`).toBeLessThan(flat * 1.5);
});

test('高さの下限を上げると建物が減る', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  await showPlateauBuildings(page);
  const before = await sourceFeatureCount(page, 'buildings');

  await page.locator('#min-height').fill('60');
  await page.locator('#min-height').dispatchEvent('input');

  // 60m以上の建物は港区でもごく一部しかない。
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeLessThan(before);
});

test('用途を外すと建物が減る', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  await showPlateauBuildings(page);
  const before = await sourceFeatureCount(page, 'buildings');

  // 最も件数の多い用途 (住宅) を外す。選択肢は件数の多い順に並んでいる。
  await page.locator('#usage-options input').first().uncheck();

  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeLessThan(before);
});

/** 人口メッシュ (東京都)。無ければ地上リスクの表示は出ない。 */
const MESH_DATASET = 'mesh_pop_13';

async function hasMesh(page: Page): Promise<boolean> {
  return (await datasetUrl(page, MESH_DATASET)) !== null;
}

/** 人口密度を表示し、描かれるまで待つ。 */
async function showPopulationMesh(page: Page, zoom = 13) {
  await page.evaluate((z) => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: z });
  }, zoom);
  // **チェックボックスは一覧にある。**設定を先に開くと一覧が隠れて押せない。
  await showLayer(page, 'mesh');
  await expect.poll(() => sourceFeatureCount(page, 'population-mesh')).toBeGreaterThan(0);
  await openLayerSettings(page, 'mesh');
}

// 地上リスクの中心はSORAのiGRCで、その入力は人口密度。
// 既定では出さない (建物を見に来た人の邪魔になる) が、出せることが分かる形にする。
test('人口密度は切り替えで出せる', async ({ page }) => {
  test.skip(!(await hasMesh(page)), '人口メッシュのデータが無い');

  await expect(page.locator('[data-layer="mesh"]')).toBeVisible();
  // 既定は消えている。チェックするまで読みにも行かない。
  expect(await sourceFeatureCount(page, 'population-mesh')).toBe(0);

  await showPopulationMesh(page);
  await expect(page.locator('#mesh-summary')).toContainText('人/km²');

  // 外せば消える。
  await hideLayer(page, 'mesh');
  await expect.poll(() => sourceFeatureCount(page, 'population-mesh')).toBe(0);
});

/**
 * 色の区切りをSORAの iGRC の区切り (5 / 50 / 500 / 5,000 / 50,000 人/km²) に
 * 合わせてある。連続的なグラデーションだと「濃い/薄い」しか読めないが、
 * 判断の区切りで段を切れば、地図がそのまま iGRC を答える。
 *
 * 機体の寸法で iGRC は変わる。同じ密度でも1mと40mでは4段違う。
 */
test('凡例のiGRCは機体で変わる', async ({ page }) => {
  test.skip(!(await hasMesh(page)), '人口メッシュのデータが無い');

  await showPopulationMesh(page);
  const values = () =>
    page.locator('#mesh-legend tbody tr td:last-child').allTextContents();

  // 既定は最小の機体 (1m / 25m/s)。密度の高い側から並んでいる。
  expect(await values()).toEqual(['7', '6', '5', '4', '3', '2']);

  // 40m機は同じ密度でも4段重い。50,000超はSORAの適用範囲外になる。
  await page.locator('#aircraft-class').selectOption({ label: '40m / 200m/s' });
  expect(await values()).toEqual(['範囲外', '10', '9', '8', '7', '6']);
});

/**
 * **密度は平均ではなく最大を取る。** SORAは運航範囲の中で最も密度の高いところを
 * 採るので、束ねるときに平均にすると危ないセルが薄まって消える。
 *
 * 125m (11桁) から1km (8桁) まで束ねても、最大値は変わらないはず。
 */
test('メッシュを粗くしても最大密度は下がらない', async ({ page }) => {
  test.skip(!(await hasMesh(page)), '人口メッシュのデータが無い');

  const peak = async () => {
    const text = (await page.locator('#mesh-summary').textContent()) ?? '';
    const match = /最大 ([\d,]+) 人/.exec(text);
    if (!match) throw new Error(`最大密度が読めない: ${text}`);
    return Number(match[1].replace(/,/g, ''));
  };

  await showPopulationMesh(page, 15);
  await expect(page.locator('#mesh-summary')).toContainText('125mメッシュ');
  const fine = await peak();

  // 同じ場所を1kmで見る。表示範囲は広がるので、最大は下がらない。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 11 });
  });
  await expect(page.locator('#mesh-summary')).toContainText('1kmメッシュ');
  expect(await peak()).toBeGreaterThanOrEqual(fine);
});

/**
 * 束ねたセルは**親メッシュの矩形**で描く。
 *
 * 当初は中に入っている子メッシュのbboxの和で描いていた。人のいる子だけを
 * 囲った形になるので、左端の列にしか人がいない1kmセルが細い縦帯になり、
 * 地図がメッシュに見えなくなっていた (実際に見て分かった)。
 *
 * **同じ階層のメッシュは全部同じ大きさ**なので、幅と高さが揃っていれば
 * メッシュの形で描けている。
 */
test('メッシュのセルはすべて同じ大きさ', async ({ page }) => {
  test.skip(!(await hasMesh(page)), '人口メッシュのデータが無い');

  await openLayerSettings(page, 'mesh');
  for (const zoom of [15, 13, 11, 8]) {
    await page.evaluate((z) => {
      const map = (window as unknown as TestWindow).__map!;
      map.jumpTo({ center: [139.7454, 35.6586], zoom: z });
    }, zoom);
    if (zoom === 15) await showLayer(page, 'mesh');
    await expect.poll(() => sourceFeatureCount(page, 'population-mesh')).toBeGreaterThan(1);

    const sizes = await page.evaluate(async () => {
      const source = (window as unknown as TestWindow).__map!.getSource('population-mesh');
      const data = await (
        source as unknown as { getData: () => Promise<GeoJSON.FeatureCollection> }
      ).getData();
      const round = (value: number) => Math.round(value * 1e6) / 1e6;
      const unique = new Set<string>();
      for (const feature of data.features) {
        const ring = (feature.geometry as GeoJSON.Polygon).coordinates[0];
        const lons = ring.map((position) => position[0]);
        const lats = ring.map((position) => position[1]);
        unique.add(
          `${round(Math.max(...lons) - Math.min(...lons))}x${round(Math.max(...lats) - Math.min(...lats))}`,
        );
      }
      return [...unique];
    });
    expect(sizes, `ズーム${zoom}でセルの大きさが揃っていない`).toHaveLength(1);
  }
});

/**
 * 引いた表示では、**全国を1kmに束ねたファイル**を読む。
 *
 * 125mから束ねることもできるが、引くほど元の行を多く読むことになる
 * (下限を置く前の実測でズーム7のとき21.1MB)。1kmの全国ファイルは5.5MBで、
 * ここから10km・80kmへさらに束ねられる。
 *
 * **125mのファイルには触らないこと**を見る。触っていたら束ね直しており、
 * 集約ファイルを作った意味が無い。
 */
test('引いた表示では1kmの集約ファイルだけを読む', async ({ page }) => {
  test.skip(!(await hasMesh(page)), '人口メッシュのデータが無い');

  const requested: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('.parquet')) requested.push(path.split('/').pop()!);
  });

  // 都道府県をまたぐ広さ。125mを束ねていたら何十MBも読むことになる。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 8 });
  });
  await openLayerSettings(page, 'mesh');
  await showLayer(page, 'mesh');
  await expect.poll(() => sourceFeatureCount(page, 'population-mesh')).toBeGreaterThan(0);

  expect(requested).toContain('mesh_pop_1km.parquet');
  expect(requested.filter((file) => /^mesh_pop_\d+\.parquet$/.test(file))).toEqual([]);
  // 1kmのファイルから、さらに10kmへ束ねて出している。
  // 配信の細かさと表示の細かさは別物。
  await expect(page.locator('#mesh-summary')).toContainText('10kmメッシュ');
});

// メッシュコードは階層なので、1kmのファイルからさらに粗くできる。
// 全国を俯瞰しても、いちばん危ない125mメッシュの密度が残っていること。
test('全国を俯瞰しても最大密度は残る', async ({ page }) => {
  test.skip(!(await hasMesh(page)), '人口メッシュのデータが無い');

  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [138.0, 37.0], zoom: 5 });
  });
  await openLayerSettings(page, 'mesh');
  await showLayer(page, 'mesh');
  await expect(page.locator('#mesh-summary')).toContainText('80kmメッシュ');

  const text = (await page.locator('#mesh-summary').textContent()) ?? '';
  const peak = Number(/最大 ([\d,]+) 人/.exec(text)![1].replace(/,/g, ''));
  // 全国の125mメッシュの最大は217,219人/km² (パイプライン側で実測)。
  // 束ねる途中で平均を取っていると、ここが桁ごと落ちる。
  expect(peak).toBeGreaterThan(200_000);
});

test('クリアするとハイライトが消える', async ({ page }) => {
  await page.locator('#search-input').fill('港区');
  await page.locator('#results li', { hasText: '行政区域' }).first().click();
  await expect.poll(() => highlightFeatureCount(page)).toBe(1);

  await page.locator('#clear-button').click();

  await expect.poll(() => highlightFeatureCount(page)).toBe(0);
  await expect(page.locator('#search-input')).toHaveValue('');
});

const RAILWAY_DATASET = 'n02_sections_all';

async function hasRailway(page: Page): Promise<boolean> {
  return (await datasetUrl(page, RAILWAY_DATASET)) !== null;
}

/** 鉄道を表示し、描かれるまで待つ。 */
async function showRailway(page: Page, zoom = 12) {
  await page.evaluate((z) => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7671, 35.6812], zoom: z }); // 東京駅
  }, zoom);
  // **チェックボックスは一覧にある。**設定を先に開くと一覧が隠れて押せない。
  await showLayer(page, 'railway');
  await expect.poll(() => sourceFeatureCount(page, 'railway')).toBeGreaterThan(0);
  await openLayerSettings(page, 'railway');
}

// 既定では出さない (建物を見に来た人の邪魔になる)。出せることが分かる形にする。
test('鉄道は切り替えで出せる', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await expect(page.locator('[data-layer="railway"]')).toBeVisible();
  // チェックするまで読みにも行かない。
  expect(await sourceFeatureCount(page, 'railway')).toBe(0);

  await showRailway(page);
  await expect(page.locator('#railway-summary')).toContainText('路線');

  await hideLayer(page, 'railway');
  await expect.poll(() => sourceFeatureCount(page, 'railway')).toBe(0);
});

/**
 * 駅は点ではなく線。原典 (国土数値情報) がホームの延長を線で持っているので、
 * 使いやすさのために点へ潰したりしていないことを見張る。
 */
test('駅は線として配られている', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await showRailway(page);
  await expect.poll(() => sourceFeatureCount(page, 'railway-stations')).toBeGreaterThan(0);

  const types = await page.evaluate(async () => {
    const map = (window as unknown as TestWindow).__map!;
    const source = map.getSource('railway-stations') as GeoJSONSource;
    const data = await source.getData();
    if (data.type !== 'FeatureCollection') return [];
    return [...new Set(data.features.map((feature) => feature.geometry.type))];
  });
  expect(types).toEqual(['LineString']);
});

/**
 * 事業者種別で絞れる。選択肢はカタログの語彙から作っているので、
 * ここが空になると「絞り込みが黙って消えた」ことになる。
 */
test('鉄道は事業者種別で絞れる', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await showRailway(page);
  const boxes = page.locator('#railway-types input[type="checkbox"]');
  expect(await boxes.count()).toBeGreaterThan(0);

  const before = await sourceFeatureCount(page, 'railway');
  await page.locator('#railway-none').click();
  await expect.poll(() => sourceFeatureCount(page, 'railway')).toBe(0);

  await page.locator('#railway-all').click();
  await expect.poll(() => sourceFeatureCount(page, 'railway')).toBe(before);
});

// 引いた表示では出さない。路線のジオメトリ列は4.6MBあり、全国を一度に読むと
// 起動時の転送量 (1.5MB) を大きく超える。
test('引いた表示では鉄道を読みに行かない', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await showRailway(page);

  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [138.0, 37.0], zoom: 6 });
  });
  await expect(page.locator('#railway-summary')).toContainText('まで寄ると出ます');
  expect(await sourceFeatureCount(page, 'railway')).toBe(0);
});

/**
 * 1都市を見るときに、路線ファイル全体を読まないこと。
 *
 * 路線の geometry 列は4.6MBある。row group を空間的に詰めてあるので、
 * 表示範囲に重なる row group だけが読まれるはず。ここが効かなくなると
 * 「鉄道を出した瞬間に数MB」という状態に黙って落ちる。
 *
 * **row group を細かくしても減らない** (実測: 4個で1,715KB、15個で1,548KB)。
 * 東京の路線がそもそも密で、読む量を決めているのは分割の粗さではなく
 * ジオメトリの頂点数の方。減らすなら簡略化だが、それは配るデータを
 * 変えることになるので別の判断になる。
 */
test('鉄道は範囲に重なる分しか読まない', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  const dataset = await datasetUrl(page, RAILWAY_DATASET);
  let fetchedBytes = 0;
  page.on('response', (response) => {
    if (response.url() !== dataset) return;
    if (response.request().method() === 'HEAD') return;
    fetchedBytes += Number(response.headers()['content-length'] ?? 0);
  });

  await showRailway(page);

  expect(fetchedBytes, '転送量を計測できていない').toBeGreaterThan(0);
  console.log(`鉄道 (路線) の転送量: ${(fetchedBytes / 1024).toFixed(0)} KB`);
  // ファイルは5.2MB。半分を超えるようなら row group の詰め方が効いていない。
  expect(fetchedBytes, `路線を読みすぎ: ${(fetchedBytes / 1024).toFixed(0)} KB`).toBeLessThan(
    2.6 * 1024 * 1024,
  );
});

// 出所を見ただけでは版が分からず、古いものを新しいと思って使う事故になる。
// 分かっているものには版を添える (分からないものには**書かない**)。
test('出典にいつ時点のデータかが出る', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await openSection(page, 'credits-section');
  // 鉄道はメタデータXMLから版を読んでいる (N02-25)。
  await expect(page.locator('#credits .vintage').first()).toBeVisible();
  await expect(page.locator('#credits')).toContainText('N02-');
});

// 駅名や路線名が読めないと、線が引いてあるだけで何の路線か分からない。
test('鉄道はホバーで路線名と事業者が出る', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await showRailway(page, 15);
  // 線の上を通るまで動かす。中心に必ず線があるとは限らないので、
  // 描かれた地物の座標をそのまま使う。
  const point = await page.evaluate(async () => {
    const map = (window as unknown as TestWindow).__map!;
    const source = map.getSource('railway') as GeoJSONSource;
    const data = await source.getData();
    if (data.type !== 'FeatureCollection') return null;
    const line = data.features.find((f) => f.geometry.type === 'LineString');
    if (!line || line.geometry.type !== 'LineString') return null;
    const [lng, lat] = line.geometry.coordinates[0] as [number, number];
    map.jumpTo({ center: [lng, lat], zoom: 16 });
    const p = map.project([lng, lat]);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  expect(point, '路線が1本も描かれていない').not.toBeNull();

  await page.locator('#map canvas').hover({ position: point! });
  const popup = page.locator('.maplibregl-popup-content');
  await expect(popup).toBeVisible();
  // 項目名は値と分かれた列になっている (`setText` の改行は潰れるので要素で組んでいる)。
  await expect(popup).toContainText('事業者');
  await expect(popup.locator('.hover-info .label').first()).toBeVisible();
});

/**
 * 収録範囲の枠は、建物が一部の都市にしか無いことを示すためのもの。
 * **全国に広がれば日本を囲む箱になって意味を失う**ので、切れるようにしてある。
 */
test('収録範囲の枠は切り替えられる', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データが無い');

  await openLayerSettings(page, 'buildings');
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 10 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings-coverage')).toBe(1);

  await page.locator('#coverage-toggle').uncheck();
  await expect.poll(() => sourceFeatureCount(page, 'buildings-coverage')).toBe(0);

  await page.locator('#coverage-toggle').check();
  await expect.poll(() => sourceFeatureCount(page, 'buildings-coverage')).toBe(1);
});

/**
 * データは**1行ずつの一覧**になっていて、種別ごとに節を積まない。
 * 節を積むとオープンデータが増えるだけ縦に伸び、頭打ちが無くなる。
 */
test('データはレイヤーの一覧に並ぶ', async ({ page }) => {
  await expect(page.locator('#layer-list')).toBeVisible();
  const rows = page.locator('#layer-rows .layer-row, #layer-absent-rows .layer-row');
  expect(await rows.count()).toBeGreaterThan(0);

  // 行には出所が添えてある。どこのデータかが一覧のまま読める。
  await expect(page.locator('.layer-row .layer-source').first()).toBeVisible();
});

/**
 * 設定は一覧と**入れ替える** (重ねて出すと結局縦に伸びるため)。
 *
 * **高さがレイヤーの数に比例しないことが要点。** 設定そのものは縦長でありうる
 * (建物は用途が14個ある) が、それは「いちばん複雑な1つ」で頭打ちになる。
 * データを足しても増えるのは一覧の1行だけ。
 *
 * ここで見張るのは**画面からはみ出さないこと**。パネルが画面より高くなると、
 * 下にあるものへ到達できなくなる。
 */
test('設定を開いてもパネルは画面に収まる', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データが無い');

  const panel = page.locator('#data-panel');
  const viewport = page.viewportSize()!.height;

  await openLayerSettings(page, 'buildings');
  const opened = (await panel.boundingBox())!.height;
  expect(opened, `設定がはみ出している: ${opened}px / 画面 ${viewport}px`).toBeLessThan(viewport);

  // 一覧に戻れること。戻れないと他のレイヤーを触れなくなる。
  await page.locator('#layer-back').click();
  await expect(page.locator('#layer-list')).toBeVisible();
  await expect(page.locator('#layer-settings')).toBeHidden();
});

/**
 * 検索と逆ジオコーディングが使っているデータは**切れてはいけない**
 * (外すと検索が壊れる)。一覧には出すが、チェックボックスは付けない。
 */
test('検索に使うデータは一覧に出るが切り替えられない', async ({ page }) => {
  const support = page.locator('#layer-support');
  await expect(support).toBeVisible();
  await expect(support).toContainText('行政区域');
  expect(await support.locator('input[type="checkbox"]').count()).toBe(0);
});

/**
 * 収録範囲の外へ行くと「この範囲には無い」へ移る。**隠さない** —
 * 「無い」と分かるのも情報なので、薄く出したままにする。
 */
test('収録範囲の外では「この範囲には無い」に移る', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データが無い');

  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 14 }); // 港区
  });
  await expect(page.locator('#layer-rows [data-layer="buildings"]')).toBeVisible();

  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [141.35, 43.06], zoom: 14 }); // 札幌 (建物の収録なし)
  });
  await expect(page.locator('#layer-absent [data-layer="buildings"]')).toBeVisible();
  await expect(page.locator('#layer-absent')).toContainText('この範囲には無い');
});

/**
 * **出ない理由は一覧のまま読めること。**
 *
 * 要約 (`#building-count` など) は設定の中にあるので、そこだけに出すと
 * 設定を開かない限り「なぜ出ないのか」が分からない。行へ写している。
 *
 * あわせて、**どこまで寄れば出るかを数字で言う**。「拡大すると」だけでは
 * どれだけ動かせばいいのか分からない。
 */
test('出ない理由が一覧に出て、寄る先が数字で分かる', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データが無い');

  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 12 });
  });

  const status = page.locator('[data-layer-status="buildings"]');
  await expect(status).toContainText('ズーム');
  await expect(status).toContainText('まで寄ると出ます');
});

/** 一覧の🔍は**いまの位置のまま**寄る。場所ごと動かす「範囲へ移動」とは別。 */
test('レイヤーの🔍はその場でズームする', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データが無い');

  const center = await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 12 });
    const c = map.getCenter();
    return { lng: c.lng, lat: c.lat };
  });

  await page.locator('[data-layer="buildings"] .layer-zoom-button').click();

  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__map!.getZoom()))
    .toBeGreaterThanOrEqual(15);

  // 場所は動かさない。見たい場所は既に画面にあることが多い。
  const after = await page.evaluate(() => {
    const c = (window as unknown as TestWindow).__map!.getCenter();
    return { lng: c.lng, lat: c.lat };
  });
  expect(Math.abs(after.lng - center.lng)).toBeLessThan(0.001);
  expect(Math.abs(after.lat - center.lat)).toBeLessThan(0.001);
});
