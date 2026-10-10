import { test, expect, type Page } from '@playwright/test';
import type { MapLibreMap, GeoJSONSource } from 'maplibre-gl';

/** main.ts がテスト用に公開しているもの。 */
type TestWindow = {
  __map?: MapLibreMap;
  __dataUrl?: (file: string) => string;
  __itemsLoaded?: readonly string[];
  __itemPaths?: () => Promise<Record<string, string>>;
};

/**
 * データを読み終えるのを待つ長さ。**データの置き場所で決まる** (playwright.config.ts と同じ考え方)。
 *
 * R2 の公開URL (r2.dev) は読み込み1回ごとに約0.45秒待たされ (2026-10-08 に測った)、
 * 逆ジオコーディング1回 (約30回の読み込み) だけで13〜16秒かかる。30秒では、並列で流して
 * 混んだときに落ちていた。ここは「動くか」を見るテストで、速さは転送量のテストが見張る。
 */
const DATA_TIMEOUT =
  process.env.PLAYWRIGHT_BASE_URL ||
  /^https?:/.test(process.env.VITE_DATA_BASE_URL ?? '') ||
  Number(process.env.DATA_LATENCY_MS ?? 0) > 0
    ? 90_000
    : 30_000;

/** 行政区域データセット。逆ジオコーディングと転送量の計測がこれを見る。 */
const ADMIN_DATASET = 'overture_admin_jp';
/** 建物データセット。無くても他の機能は動くので、無ければスキップする。 */
const BUILDINGS_COLLECTION = 'overture-buildings';
/** PLATEAUの建物。高さ・用途を持つので、絞り込みはこちらでしか出ない。 */
const PLATEAU_DATASET = 'plateau_bldg_13103';

/**
 * Item ID → 配信の起点からのパス。**worker内で使い回す。**
 *
 * 結果はページに依存せず、走っている間にカタログは変わらないので、1回だけ引けばよい。
 */
const datasetPaths = new Map<string, string>();

/**
 * データセットのURLを**STACのItemから**引く。
 *
 * 配信時のパスはItemのアセットが持っている (出所ごとにディレクトリを
 * 切っているので `overture/....parquet` のような形)。テストにパスを書くと、
 * 置き場所を変えるたびに書き換えることになる。**Item IDだけを書く。**
 *
 * Item は stac-geoparquet (items.parquet) に入っているので、**アプリの DuckDB に読ませる**
 * (`__itemPaths`)。テストの側に Parquet を読む仕組みを別に持たない。
 * そのため、アプリの起動が済んでから呼ぶ (beforeEach の後なら済んでいる)。
 *
 * 見つからなければ null。
 */
async function datasetUrl(page: Page, id: string): Promise<string | null> {
  if (datasetPaths.size === 0) {
    await page.waitForFunction(() => '__itemPaths' in window, undefined, { timeout: DATA_TIMEOUT });
    const paths = await page.evaluate(() => (window as unknown as TestWindow).__itemPaths!());
    for (const [itemId, path] of Object.entries(paths)) datasetPaths.set(itemId, path);
  }
  const path = datasetPaths.get(id);
  return path === undefined ? null : resolveDataUrl(page, path);
}

/** アプリが起動時に読むまとめ (`collections.json` / `collections.en.json`) の中身。 */
interface Bundle {
  collections: Record<string, unknown>[];
  'duck:catalogs': { id: string; title?: string }[];
}

/**
 * まとめを読む。**画面と突き合わせるときは、文書ごとの JSON ではなくこれを読む** —
 * アプリが読んでいるのはこちらで、公開の途中 (新しいアプリを先に出し、文書を後から
 * 上げ直す間) は文書ごとの JSON が古いことがある。
 */
async function readBundle(page: Page, file = 'collections.json'): Promise<Bundle> {
  const response = await page.request.get(await resolveDataUrl(page, file));
  // 開発サーバーは無いファイルに index.html を200で返すので、JSON として読めるかで確かめる。
  const body = response.ok() ? await response.text() : '';
  try {
    return JSON.parse(body) as Bundle;
  } catch {
    return { collections: [], 'duck:catalogs': [] };
  }
}

/** まとめから Collection を1つ引く。無ければ undefined。 */
async function bundledCollection<T>(page: Page, id: string): Promise<T | undefined> {
  return (await readBundle(page)).collections.find((collection) => collection.id === id) as T | undefined;
}

/**
 * Overture の建物が配信されているか。**Collection の有無で見る。**
 *
 * 以前は港区のファイル (`overture_buildings_minato`) を名指ししていたが、全国にして
 * QuadKey で分けたので、ファイル名は分け方で変わる。名指しのままだと、見つからずに
 * 建物のテストが**失敗せずにスキップされる**。全国を覆っているので、Collection が
 * あれば港区も入っている。
 */
async function hasBuildings(page: Page): Promise<boolean> {
  return (await bundledCollection(page, BUILDINGS_COLLECTION)) !== undefined;
}

async function hasPlateau(page: Page): Promise<boolean> {
  return (await datasetUrl(page, PLATEAU_DATASET)) !== null;
}

/** PLATEAUの建物が見える状態にする。PLATEAUは既定の出所なので選び直さない。 */
async function showPlateauBuildings(page: Page) {
  await openLayerSettings(page, LAYER.plateauBuildings);
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
  // アプリが起動時に読むまとめで見る (起動が済む前に呼ばれるので、Item は引けない)。
  // 開発サーバーは無いファイルに index.html を200で返すので、中身で確かめる。
  const { collections } = await readBundle(page);
  test.skip(
    !collections.some((collection) => collection['duck:kind'] === 'admin'),
    '行政区域がカタログに無い (READMEの手順で用意してください)',
  );
}

/**
 * 右下のダイアログ (使い方・検索できるもの・出典・使っている技術) を開く。右下のパネルは
 * 狭く、長い文言が細切れに折り返すので、どれも節ではなくダイアログで出している。
 */
async function openInfoDialog(
  page: Page,
  id: 'credits-dialog' | 'tech-dialog' | 'help-dialog' | 'search-dialog',
) {
  await page.locator(`.info-open[data-dialog="${id}"]`).click();
  await expect(page.locator(`#${id}`)).toBeVisible();
}

/**
 * レイヤーの設定を開く。一覧の ⚙ を押すと、**パネルの中身が入れ替わる**
 * (重ねて出すと結局縦に伸びるため)。
 */
/**
 * 「＋ 追加」でカタログのダイアログを開き、その行のタブへ切り替える。
 * 行がどちらの区分 (データ / 地図タイル) かは、ダイアログの中で探して決める。
 */
async function openCatalogFor(page: Page, layer: string) {
  await closeLayerDetails(page);
  const dialog = page.locator('#layer-catalog-dialog');
  if (!(await dialog.isVisible())) {
    await page.locator('.layer-add-button[data-section="data"]').click();
    await expect(dialog).toBeVisible();
  }
  for (const section of ['data', 'tile', 'view']) {
    await dialog.locator(`.catalog-tab[data-section="${section}"]`).click();
    if ((await dialog.locator(`[data-catalog-layer="${layer}"]`).count()) > 0) return;
  }
  throw new Error(`${layer} がカタログに無い`);
}

/**
 * 一覧の行を、行の ⋮⋮ を掴んで `target` の行の位置へドラッグする (`where` はその上か下か)。
 * マウスの操作で動かす (Pointer Events で書いてあるので、指でも同じ経路を通る)。
 */
async function dragRow(page: Page, layer: string, target: string, where: 'above' | 'below') {
  const handle = page.locator(`.layer-row[data-layer="${layer}"] .layer-drag-handle`);
  const from = (await handle.boundingBox())!;
  const to = (await page.locator(`.layer-row[data-layer="${target}"]`).boundingBox())!;
  const y = where === 'above' ? to.y + 2 : to.y + to.height - 2;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, y, { steps: 8 });
  await page.mouse.up();
}

/** カタログのダイアログを開いていれば閉じる。 */
async function closeCatalog(page: Page) {
  const dialog = page.locator('#layer-catalog-dialog');
  if (!(await dialog.isVisible())) return;
  await dialog.locator('.info-dialog-close').click();
  await expect(dialog).toBeHidden();
}

/**
 * 行が一覧にあるようにする。**一覧には使うものだけを置く**ので、無ければ
 * 「＋ 追加」のダイアログから足す (足すと出した状態になる)。
 */
async function revealLayer(page: Page, layer: string) {
  const row = page.locator(`.layer-row[data-layer="${layer}"]`);
  if (await row.isVisible()) return;
  await openCatalogFor(page, layer);
  await page.locator(`[data-catalog-layer="${layer}"] .catalog-add`).click();
  await closeCatalog(page);
  await expect(row).toBeVisible();
}

/**
 * 行の ⚙ で、絞り込み・色分けを**その行の下に**開く (地図を覆わない)。
 * 開いていればそのまま。
 */
async function openLayerSettings(page: Page, layer: string) {
  await closeLayerDetails(page);
  await revealLayer(page, layer);
  const button = page.locator(`[data-layer="${layer}"] .layer-settings-button`);
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  await expect(page.locator(`[data-layer="${layer}"] .layer-settings-slot`)).toBeVisible();
}

/** 行の ⓘ で「このデータについて」(カタログ・使う条件・取得) をダイアログで開く。 */
async function openLayerDetails(page: Page, layer: string) {
  await closeLayerDetails(page);
  await revealLayer(page, layer);
  await page.locator(`[data-layer="${layer}"] .layer-detail-button`).click();
  await expect(page.locator('#layer-detail-dialog')).toBeVisible();
}

/** 「このデータについて」を開いていれば閉じる (開いたままだと一覧を押せない)。 */
async function closeLayerDetails(page: Page) {
  const dialog = page.locator('#layer-detail-dialog');
  if (!(await dialog.isVisible())) return;
  await dialog.locator('.info-dialog-close').click();
  await expect(dialog).toBeHidden();
}

/**
 * レイヤーの表示/非表示を切り替える。
 *
 * **チェックボックスは一覧にある。** 「このデータについて」を開いていると押せないので、
 * 先に閉じる。テスト側で開閉の順番を気にしなくて済むようにするため。
 */
async function setLayerVisible(page: Page, layer: string, visible: boolean) {
  await closeLayerDetails(page);
  await revealLayer(page, layer);
  const toggle = page.locator(`#layer-toggle-${layer}`);
  if (visible) await toggle.check();
  else await toggle.uncheck();
}

const showLayer = (page: Page, layer: string) => setLayerVisible(page, layer, true);
const hideLayer = (page: Page, layer: string) => setLayerVisible(page, layer, false);

/**
 * 一覧の行ID。**行はCollectionなので、Collection IDと同じ。**
 *
 * 地図のソースID (`'buildings'` `'railway'` など) とは別物。以前は行も
 * 「建物」「鉄道」のように使う側のまとまりで、IDも手書きだった。
 */
const LAYER = {
  plateauBuildings: 'plateau-buildings',
  overtureBuildings: 'overture-buildings',
  mesh: 'estat-mesh-pop',
  railway: 'ksj-railway',
  stations: 'ksj-railway-stations',
  road: 'overture-roads',
  powerLines: 'overture-power-lines',
  waterways: 'overture-waterways',
} as const;

/**
 * 建物をOvertureだけにして、その設定を開く。
 *
 * 以前は設定の中の選択欄で出所を切り替えていた。いまは一覧で出所ごとに
 * 行が分かれているので、**PLATEAUを外してOvertureを入れる**。
 */
async function useOvertureBuildings(page: Page) {
  await hideLayer(page, LAYER.plateauBuildings);
  await showLayer(page, LAYER.overtureBuildings);
  await openLayerSettings(page, LAYER.overtureBuildings);
}

/** 初期化 (DuckDB + 地図) の完了を待つ。 */
async function waitForReady(page: Page) {
  // 単独なら5秒前後だが、並列で流して CPU を取り合うと15秒を超えることがあった。
  await expect(page.locator('#loading')).toBeHidden({ timeout: DATA_TIMEOUT });
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
  await openInfoDialog(page, 'help-dialog');
  const help = page.locator('#help');
  await expect(help).toBeVisible();
  await expect(help).toContainText('検索');
  await expect(help).toContainText('クリック');
  await expect(help).toContainText('カーソルを合わせる');
  // 画面のボタンは、同じ記号で全部説明されていること。
  for (const mark of ['📍', '◎', '⚙', 'ⓘ', '▸']) await expect(help).toContainText(mark);
  await expect(help).toContainText('背景地図');
  await expect(help).toContainText('周り');
  await expect(help).toContainText('絞り込');
  await expect(help).toContainText('この範囲を取得');
  // 出した結果の消し方。ここに書いていないと×とEscに気づけない。
  await expect(help).toContainText('Esc');
});

/**
 * **英語の画面。** 言語は ?lang= かブラウザの言語で決まる (src/i18n)。テストは日本語に固定してあるので、
 * ここで ?lang=en を開いて、画面の文言が英語になり、日本語へ戻れることを確かめる。
 * カタログの題名は英語版のカタログ (`*.en.json`) から出る。地名は訳さないので見ない。
 */
test('英語の画面に切り替えられ、日本語へ戻れる', async ({ page }) => {
  await page.goto('./?lang=en');
  await waitForReady(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#search-input')).toHaveAttribute('placeholder', /Japanese/);
  await expect(page.locator('.layer-add-button[data-section="data"]')).toHaveText('+ Add');

  // TS で作る文言 (使い方のダイアログ・カタログのタブ) も英語。
  await openInfoDialog(page, 'help-dialog');
  await expect(page.locator('#help')).toContainText('Search');
  await expect(page.locator('#help')).toContainText('Esc');
  await page.locator('#help-dialog .info-dialog-close').click();
  await page.locator('.layer-add-button[data-section="data"]').click();
  await expect(page.locator('.catalog-tab[data-section="view"]')).toContainText('View only');
  await expect(page.locator('[data-catalog-layer] .catalog-add').first()).toHaveText(/Add|Added/);
  // 見出しは英語版のカタログの題名 (「国土数値情報」ではなく National Land Numerical Information)。
  const groups = (await readBundle(page, 'collections.en.json'))['duck:catalogs'].map((c) => c.title);
  const headings = await page.locator('#layer-catalog-dialog .catalog-group-title').allTextContents();
  expect(headings.length).toBeGreaterThan(0);
  expect(groups).toEqual(expect.arrayContaining(headings));
  expect(headings.join()).not.toMatch(/[ぁ-んァ-ン一-龠]/);
  await closeCatalog(page);

  // **いまの言語が分かる。** English は太字の文字 (押せない)、日本語は押せるリンク。
  const switcher = page.locator('#lang-switch');
  await expect(switcher.locator('[aria-current="true"]')).toHaveText('English');
  const toJapanese = switcher.locator('a', { hasText: '日本語' });
  await expect(toJapanese).toBeVisible();
  await toJapanese.click();
  await waitForReady(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('.layer-add-button[data-section="data"]')).toHaveText('＋ 追加');
  await expect(switcher.locator('[aria-current="true"]')).toHaveText('日本語');
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

  const popup = page.locator('.result-popup .maplibregl-popup-content');
  await expect(popup).toBeVisible();
  // 「判定中…」から確定した地名に変わることを確認する。
  await expect(popup).toContainText('東京都', { timeout: DATA_TIMEOUT });

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

  await expect(page.locator('.result-popup .maplibregl-popup-content')).toHaveCount(0);
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
    await expect(page.locator('.result-popup .maplibregl-popup-content')).toContainText('東京都', {
      timeout: DATA_TIMEOUT,
    });
    await expect.poll(() => highlightFeatureCount(page)).toBe(1);

    if (how === 'close-button') {
      await page.locator('.maplibregl-popup-close-button').click();
    } else {
      await page.keyboard.press('Escape');
    }

    await expect(page.locator('.result-popup .maplibregl-popup-content')).toHaveCount(0);
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
  await expect(page.locator('.result-popup .maplibregl-popup-content')).toContainText('東京都', {
    timeout: DATA_TIMEOUT,
  });
  // ポップアップの文字はポリゴンの取得より先に出る。揃うまで待ってから押す。
  await expect.poll(() => highlightFeatureCount(page)).toBe(1);

  // **地図の右側を押す。** 左側はデータの一覧が覆っていて、そこを押すとパネルに
  // 取られる (一覧をカタログの階層にして縦に伸びたときに、(200, 200) が覆われた)。
  await page.locator('#map canvas').click({ position: { x: 900, y: 400 } });

  await expect(page.locator('.result-popup .maplibregl-popup-content')).toBeVisible();
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

  await expect(page.locator('.result-popup .maplibregl-popup-content')).toContainText('該当する行政区域', {
    timeout: DATA_TIMEOUT,
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
  await expect(page.locator('.result-popup .maplibregl-popup-content')).toContainText('東京都', {
    timeout: DATA_TIMEOUT,
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
  await expect(page.locator('.result-popup .maplibregl-popup-content')).toContainText('東京都', {
    timeout: DATA_TIMEOUT,
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
 *
 * Item は stac-geoparquet 1つにまとめたので、通信の数では見分けられない。アプリが
 * Item を読んだ Collection を数える (`__itemsLoaded`)。ファイルは **Range で部分だけ**読む。
 */
test('使わないデータのItemは起動時に読まない', async ({ page }) => {
  const itemsRequests: (string | undefined)[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') return;
    if (new URL(request.url()).pathname.endsWith('/items.parquet')) {
      itemsRequests.push(request.headers()['range']);
    }
  });
  await page.reload();
  await waitForReady(page);
  const loaded = () =>
    page.evaluate(() => [...((window as unknown as TestWindow).__itemsLoaded ?? [])]);

  // 行政区域だけは起動時に要る。どのファイルを読むかが決まらないため。
  expect(await loaded()).toContain('overture-admin');
  // 人口メッシュ (47ファイル) は、まだ誰も要求していない。
  expect((await loaded()).filter((id) => id.startsWith('estat-mesh-pop'))).toEqual([]);

  // **都市ごとのItemは引いた表示で読まない。** 306都市あり、フッターを引くだけで
  // 1回の表示が600往復を超える。読むのは整備範囲 (1ファイル) の方。
  await expect.poll(loaded).toContain('plateau-buildings-coverage');
  expect(await loaded()).not.toContain('plateau-buildings');

  // まとめたファイルは丸ごと取らない (どの読み込みにも Range が付いている)。
  expect(itemsRequests.length).toBeGreaterThan(0);
  expect(itemsRequests.filter((range) => range === undefined)).toEqual([]);

  // 寄ると都市ごとの方に切り替わる。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 16 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);
  expect(await loaded()).toContain('plateau-buildings');
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
  await openInfoDialog(page, 'credits-dialog');

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
/**
 * **使っている技術にも、データと同じように謝辞を出す。**
 *
 * ライブラリは依存を見れば分かるが、考え方や仕様だけを借りたもの
 * (STRの並べ替え、COGPの段の並び) はコードのどこにも名前が出ない。
 * 両方が、どこで使っているかと一緒に出ること。
 */
test('使っている技術は、ライブラリと借りた考え方を分けて謝辞を出す', async ({ page }) => {
  await openInfoDialog(page, 'tech-dialog');
  const credits = page.locator('#tech-credits');

  await expect(credits.locator('.tech-heading')).toHaveCount(3);
  await expect(credits).toContainText('ライブラリ');
  await expect(credits).toContainText('ライブラリは使っていません');

  // 実際に使っているライブラリと、借りただけの考え方の両方がある。
  for (const name of ['DuckDB-WASM', 'MapLibre GL JS', 'PLATEAU GIS Converter', 'STR', 'Cloud Optimized GeoParquet']) {
    await expect(credits.locator('dt', { hasText: name }).first()).toBeVisible();
  }
  // **名前を並べるだけにしない。** どれにも「どこで使っているか」が付く。
  const terms = await credits.locator('dt').count();
  const uses = await credits.locator('dd').allTextContents();
  expect(uses).toHaveLength(terms);
  expect(uses.every((use) => use.trim().length > 0)).toBe(true);
  // 名前は出典へのリンク。
  expect(await credits.locator('dt a[href^="http"]').count()).toBe(terms);
});

/**
 * **配っているライブラリのライセンスの全文へ辿れる** (本番ビルドだけ。ビルドで書き出すため)。
 *
 * MIT や BSD は「複製に著作権表示と許諾文を含める」のが条件で、縮めた JS からは消える。
 * DuckDB の本体と拡張は写して配っているので、別に置いた表示 (spatial が中に持つ GEOS の LGPL も) がある。
 */
test('本番ビルドでは、ライブラリのライセンスの全文へ辿れる', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_TARGET !== 'dist', 'ライセンスの一覧はビルドで書き出す');
  await openInfoDialog(page, 'tech-dialog');
  const links = page.locator('#tech-credits .tech-licenses a');
  await expect(links).toHaveCount(2);

  const [bundled, duckdb] = await Promise.all(
    [0, 1].map(async (i) => {
      const response = await page.request.get(new URL((await links.nth(i).getAttribute('href'))!, page.url()).href);
      expect(response.status()).toBe(200);
      return response.text();
    }),
  );
  // 束ねた依存は著作権表示まで入っている。
  expect(bundled).toContain('## maplibre-gl');
  expect(bundled).toContain('MapLibre contributors');
  // DuckDB は MIT の本文、spatial の GEOS は LGPL の本文へのリンクとソースの在りか。
  expect(duckdb).toContain('Stichting DuckDB Foundation');
  expect(duckdb).toContain('LGPL-2.1');
  const lgpl = await page.request.get(new URL('LGPL-2.1.txt', new URL((await links.nth(1).getAttribute('href'))!, page.url())).href);
  expect(await lgpl.text()).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
});

/**
 * **使うときの条件 (商用可か・出典表示・継承) が一目で分かる。**
 *
 * ライセンスの識別子 (`other` を含む) だけでは、規約を読みに行かないと何ができるか
 * 分からない。カタログの `duck:terms` (規約を読んだ結果の要約) から、出典ダイアログの
 * 一覧表と ⚙ のバッジを出す。文言を書き写さず、カタログと突き合わせる。
 */
test('使うときの条件が一覧表とバッジで出る', async ({ page }) => {
  await openInfoDialog(page, 'credits-dialog');
  const table = page.locator('#terms-summary table');
  await expect(table).toBeVisible();
  // **要約は独自に読んだ参考情報で、正本は規約の本文。** 表の下で断る。
  await expect(page.locator('#terms-summary .terms-note')).toContainText('参考情報');

  // Overture は ODbL なので継承がある。PLATEAU は CC BY で継承は無い。
  const overture = table.locator('tbody tr', { hasText: 'Overture' }).first();
  await expect(overture).toContainText('あり');
  await expect(overture.locator('a')).toHaveAttribute('href', /opendatacommons\.org/);
  const plateau = table.locator('tbody tr', { hasText: 'PLATEAU' }).first();
  await expect(plateau.locator('td').nth(1)).toHaveText('可');
  await expect(plateau.locator('td').nth(4)).toHaveText('—');
  // 位置参照情報は商用を認めるとも禁じるとも書いていない。**「可」と言い切らない。**
  await expect(table.locator('tbody tr', { hasText: '町丁目' }).locator('td').nth(1)).toHaveText('記載なし');
  await page.locator('#credits-dialog .info-dialog-close').click();

  // ⚙ のカードにもバッジ。カタログの duck:terms と一致すること。
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');
  const collection = (await bundledCollection<{
    'duck:terms': { commercial: string; share_alike: boolean };
  }>(page, LAYER.plateauBuildings))!;
  expect(collection['duck:terms'].commercial).toBe('allowed');
  await openLayerDetails(page, LAYER.plateauBuildings);
  const card = page.locator(`.collection-card[data-collection="${LAYER.plateauBuildings}"]`);
  await expect(card.locator('.terms-badge', { hasText: '商用可' })).toBeVisible();
  await expect(card.locator('.terms-badge', { hasText: '継承あり' })).toHaveCount(0);
});

test('出典に配布元へのリンクが出る', async ({ page }) => {
  await openInfoDialog(page, 'credits-dialog');

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

  // 一覧には使うもの (既定は建物と淡色地図) だけ。カタログ全体は「＋ 追加」から開く。
  await expect(panel.locator('.layer-row', { hasText: '建物' }).first()).toBeVisible();
  for (const section of ['data', 'tile']) {
    await expect(panel.locator(`.layer-add-button[data-section="${section}"]`)).toBeVisible();
  }
  await expect(page.locator('#layer-catalog-dialog')).toBeHidden();
  // レイヤーをまたぐ設定 (表示量) は一覧の最後。背景地図はもう一覧の行。
  await expect(panel.locator('#detail-section')).toContainText('表示量');
  // 使い方・検索できるもの・出典・使っている技術は右下 (MapLibreの ⓘ と同じ性格なので同じ側)。
  for (const heading of ['使い方', '検索できるもの', '出典', '使っている技術']) {
    await expect(page.locator('#info-panel .info-open', { hasText: heading })).toBeVisible();
  }
  // 中身は既定で出さない (どれもダイアログで、閉じている)。
  for (const id of ['help-dialog', 'search-dialog', 'credits-dialog', 'tech-dialog']) {
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  // レイヤーの絞り込みも「このデータについて」も既定では出さない (一覧が先)。
  await expect(page.locator('.layer-settings-slot')).toHaveCount(0);
  await expect(page.locator('#layer-detail-dialog')).toBeHidden();
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

/**
 * 初期化のオーバーレイが消えたあとの待ち時間には、以前は合図が何も無かった。
 * 寄っても、数秒のあいだ「空の地図」と見分けがつかない。
 *
 * **取得を止めて観察する。** 手元はデータの取得が速すぎて、合図が一瞬で消える。
 * (以前は「建物のある範囲へ移動」ボタンで寄せていたが、ボタンはやめた。)
 */
test('建物を読み込んでいる間は合図が出る', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  await expect(page.locator('#busy')).toBeHidden();

  // 合図を確かめるまでデータを渡さない。
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/*.parquet', async (route) => {
    await held;
    await route.continue();
  });

  // 港区で、原寸が出るところまで寄る。
  await page.evaluate(() => {
    (window as unknown as TestWindow).__map!.jumpTo({ center: [139.7454, 35.6586], zoom: 16 });
  });
  await expect(page.locator('#busy')).toContainText('建物を読み込み中…');

  release();
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

  // **Overtureで観察する。** PLATEAUは引いた表示でも整備範囲が出るので
  // この文言が出ない。整備範囲を持たない出所ではまだ出る。
  await useOvertureBuildings(page);

  // **どこまで寄れば出るかを数字で言う。**文言は表示量の設定から作られる。
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

  // Overtureが収録している港区で、原寸が出るところまで寄る。
  await page.evaluate(() => {
    (window as unknown as TestWindow).__map!.jumpTo({ center: [139.7454, 35.6586], zoom: 16 });
  });
  await expect(page.locator('#busy')).toContainText('建物を読み込み中…');

  await expect(page.locator('#building-count')).not.toHaveText(zoomedOutMessage);

  release();
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);
});

/**
 * 逆ジオコーディングは名前が先に出て、ポリゴンはもう1往復あとに届く。
 * その間が無言だと「地名だけ出てポリゴンが表示されない」ように見える。
 *
 * **行政区域の取得を止めて観察する。** 引いた表示でも建物を出すようにしてから、
 * クリックする時点では空間関数もファイルのフッターも既に温まっていて、
 * 合図が一瞬で消えるようになった (このテストはそれで落ちた)。
 */
test('逆ジオコーディング中は合図が出る', async ({ page }) => {
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7671, 35.6812], zoom: 13 });
  });
  // 先に建物側を出し切って、合図が建物のものでないことを確かめられる状態にする。
  // **このズームの建物は段で間引いたタイル** (公共施設だけ。全部はズーム15から)。数えられないので、
  // 状態の欄に段が出る (引き直しが終わった) のを待つ。
  await expect(page.locator(`[data-layer-status="${LAYER.plateauBuildings}"]`)).toContainText('のみ', {
    timeout: DATA_TIMEOUT,
  });
  await expect(page.locator('#busy')).toBeHidden();

  // 合図を確かめるまで行政区域を渡さない。
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admin = (await datasetUrl(page, ADMIN_DATASET))!;
  await page.route(admin, async (route) => {
    await held;
    await route.continue();
  });

  await pickOnMap(page, { x: 400, y: 300 });
  await expect(page.locator('#busy')).toBeVisible();

  release();
  await expect.poll(() => highlightFeatureCount(page)).toBe(1);
  await expect(page.locator('#busy')).toBeHidden();
});

/** 背景地図の行 (カタログの Collection ID)。 */
const BASEMAP = {
  pale: 'gsi-pale',
  photo: 'gsi-photo',
  blank: 'gsi-blank',
  /** 地形の欄 (標高を1つ選ぶ)。行ID。 */
  terrain: 'terrain',
} as const;

/** 地形に使える標高 (カタログの Collection ID)。 */
const TERRAIN = {
  mapterhorn: 'mapterhorn-terrain',
  reearth: 'reearth-terrain',
  gsi: 'gsi-dem',
} as const;

/** 出している地図タイルの行ID (一覧の上から = 上に重なる順)。 */
function shownTiles(page: Page): Promise<string[]> {
  return page
    .locator('#tile-rows > [data-layer]')
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.layer!));
}

/** 背景地図の地図上の層の並び (下から)。出しているものだけ。 */
function visibleBasemaps(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as TestWindow)
      .__map!.getStyle()
      .layers.filter((l) => l.id.startsWith('basemap/') && l.layout?.visibility !== 'none')
      .map((l) => l.id.slice('basemap/'.length)),
  );
}

/**
 * **背景地図も一覧の行** (QGISと同じく、重ねられるレイヤーの1つ)。既定では淡色地図だけ。
 * カタログから足すと実際にそのタイルを取りに行き、**いちばん上に入る** (足したものが見えるように)。
 * **隠しても一覧からは消えず、重ね順も変わらない** (以前は隠すと一覧から外れ、出し直すと
 * いちばん上へ動いた)。順番は並べ替え (ドラッグ) だけが変える。
 */
test('背景地図はカタログから足すと上に重なり、隠しても一覧と順番に残る', async ({ page }) => {
  expect(await visibleBasemaps(page)).toEqual([BASEMAP.pale]);
  const requested: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('cyberjapandata.gsi.go.jp')) requested.push(request.url());
  });

  await showLayer(page, BASEMAP.photo);
  await expect.poll(() => requested.some((url) => url.includes('/seamlessphoto/'))).toBe(true);
  // 淡色地図の上に写真。
  expect(await visibleBasemaps(page)).toEqual([BASEMAP.pale, BASEMAP.photo]);
  expect(await shownTiles(page)).toEqual([BASEMAP.photo, BASEMAP.pale]);

  // 隠して出し直しても、行は残り、順番は変わらない。
  await hideLayer(page, BASEMAP.pale);
  expect(await shownTiles(page)).toEqual([BASEMAP.photo, BASEMAP.pale]);
  await showLayer(page, BASEMAP.pale);
  expect(await visibleBasemaps(page)).toEqual([BASEMAP.pale, BASEMAP.photo]);

  // 淡色地図を写真の上へドラッグ。
  await dragRow(page, BASEMAP.pale, BASEMAP.photo, 'above');
  await expect.poll(() => visibleBasemaps(page)).toEqual([BASEMAP.photo, BASEMAP.pale]);

  // 不透明度は行の ⚙ で変えられる (地図を見ながら動かすので、行の下に開く)。
  await openLayerSettings(page, BASEMAP.pale);
  await page.locator(`[data-layer="${BASEMAP.pale}"] .layer-settings-slot input[type="range"]`).fill('40');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as TestWindow).__map!.getPaintProperty('basemap/gsi-pale', 'raster-opacity'),
      ),
    )
    .toBe(0.4);
});

/**
 * **どこから来ているかが ⓘ で分かる。** 背景地図も地形もカタログの Collection で、
 * タイルのURL (XYZ) や TileJSON、使う条件・出典 (地形は測量法の承認番号) が出る。
 */
test('背景地図と地形の出所が ⓘ で分かる', async ({ page }) => {
  await openLayerDetails(page, BASEMAP.blank);
  const blank = page.locator(`.collection-card[data-collection="${BASEMAP.blank}"]`);
  await expect(blank).toContainText('/xyz/blank/{z}/{x}/{y}.png');
  await expect(blank).toContainText('5〜14');
  await expect(blank.locator('.terms-badge', { hasText: '商用可' })).toBeVisible();

  await openLayerDetails(page, BASEMAP.terrain);
  const terrain = page.locator(`.collection-card[data-collection="${TERRAIN.mapterhorn}"]`);
  await expect(page.locator('#layer-detail-title')).toContainText('Mapterhorn');
  await expect(terrain.locator('a', { hasText: 'TileJSON' })).toHaveAttribute('href', /tilejson\.json$/);
  // **標高の形式と高さの基準**が読める。
  await expect(terrain).toContainText('Terrarium');
  await expect(terrain).toContainText('海面から');
  // **作られた元**を辿れる: Mapterhorn の日本は基盤地図情報 (地理院)。押すとそのカードへ。
  await terrain.locator('.derived-from', { hasText: '基盤地図情報' }).click();
  const source = page.locator('.collection-card[data-collection="gsi-dem-source"]');
  await expect(source).toContainText('測量法');
});

/**
 * **白地図はズーム5〜14しか無い** (カタログの `duck:zoom`)。寄っても15以上を取りに行かず
 * (404を撃たない)、14を拡大して描く。背景はいちばん下のまま (データの上に被らない)。
 */
test('白地図を入れると、無いズームのタイルを取りに行かない', async ({ page }) => {
  const blank: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/xyz/blank/')) blank.push(request.url());
  });
  await showLayer(page, BASEMAP.blank);
  await page.evaluate(() => {
    (window as unknown as TestWindow).__map!.jumpTo({ center: [139.7671, 35.6812], zoom: 16.5 });
  });
  await expect.poll(() => blank.length).toBeGreaterThan(0);
  await page.waitForTimeout(1000);
  const zooms = blank.map((url) => Number(url.match(/\/xyz\/blank\/(\d+)\//)![1]));
  expect(Math.max(...zooms)).toBeLessThanOrEqual(14);
  // 背景はいちばん下 (背景地図の層の上に、データの層が来る)。
  const ids = await page.evaluate(() =>
    (window as unknown as TestWindow).__map!.getStyle().layers.map((l) => l.id),
  );
  const lastBasemap = ids.findLastIndex((id) => id.startsWith('basemap/'));
  expect(ids.slice(0, lastBasemap + 1).every((id) => id.startsWith('basemap/'))).toBe(true);
});

// 地図と地形は別々に選べる。片方の操作で、自分で選んだもう片方が勝手に変わらないこと。
// 地図右上のボタンで切ると、一覧の地形の行も追随する (同じものを2か所で切れる)。
test('地形を切っても地図は変わらず、一覧の行も追随する', async ({ page }) => {
  await showLayer(page, BASEMAP.photo);

  await page.locator('button[class*="maplibregl-ctrl-terrain"]').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__map!.getTerrain()))
    .toBe(null);

  expect(await visibleBasemaps(page)).toContain(BASEMAP.photo);
  await expect(page.locator('#terrain-toggle')).not.toBeChecked();

  // 一覧から入れ直せる。
  await page.locator('#terrain-toggle').check();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__map!.getTerrain() !== null))
    .toBe(true);
});

/**
 * **地形は1つだけ選ぶ** (Mapterhorn・Re:Earth Terrain・地理院の標高)。選び直すと、
 * そのタイルを取りに行く。地理院の標高は独自形式なので、読み込むときに直す:
 * 値なし (海) を 0 m に、負の値を負のまま。そのまま読むと 8万m台の針が立つ。
 */
test('地形の標高を選び直せ、地理院の標高は値なしと負の値を直して使う', async ({ page }) => {
  const options = await page
    .locator('#terrain-source option')
    .evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
  expect(options).toEqual(expect.arrayContaining([TERRAIN.mapterhorn, TERRAIN.reearth, TERRAIN.gsi]));

  const asked: string[] = [];
  page.on('request', (request) => {
    if (/reearth|dem_png/.test(request.url())) asked.push(request.url());
  });
  await page.evaluate(() => {
    // 富士山の山頂付近と、東京湾 (海 = 値なし)。
    (window as unknown as TestWindow).__map!.jumpTo({ center: [138.73, 35.36], zoom: 11, pitch: 0 });
  });
  await page.locator('#terrain-source').selectOption(TERRAIN.reearth);
  await expect.poll(() => asked.some((url) => url.includes('terrain.reearth.land'))).toBe(true);
  // **選び直しても地形は付いたまま** (差し替えのためにいったん外した通知で、
  // チェックが外れて地形が消えていた)。
  await expect(page.locator('#terrain-toggle')).toBeChecked();
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).__map!.getTerrain() !== null),
  ).toBe(true);

  await page.locator('#terrain-source').selectOption(TERRAIN.gsi);
  // タイルの取得はブラウザのキャッシュから出ると記録に現れないので、地形のソースの中身で見る。
  // 独自形式なので、読み込むときに直す仕組み (gsidem://) を通す。
  await expect
    .poll(() =>
      page.evaluate(() => {
        const source = (window as unknown as TestWindow).__map!.getSource('terrain') as unknown as {
          tiles?: string[];
        };
        return source?.tiles?.[0] ?? '';
      }),
    )
    .toMatch(/^gsidem:\/\/https:\/\/cyberjapandata\.gsi\.go\.jp\/xyz\/dem_png\//);
  const elevation = (lng: number, lat: number) =>
    page.evaluate(
      ([lng, lat]) => (window as unknown as TestWindow).__map!.queryTerrainElevation([lng, lat]),
      [lng, lat],
    );
  // 富士山頂 (3,776 m) の近く。読み込みを待つ。
  await expect.poll(() => elevation(138.7274, 35.3606), { timeout: DATA_TIMEOUT }).toBeGreaterThan(3000);
  expect(await elevation(138.7274, 35.3606)).toBeLessThan(4000);

  // 海 (値なし) は 0 m 付近。針 (8万m) が立っていない。
  await page.evaluate(() => {
    (window as unknown as TestWindow).__map!.jumpTo({ center: [139.85, 35.5], zoom: 11 });
  });
  await expect.poll(() => elevation(139.85, 35.5), { timeout: DATA_TIMEOUT }).not.toBeNull();
  const sea = (await elevation(139.85, 35.5)) as number;
  expect(Math.abs(sea)).toBeLessThan(10);
});

/**
 * **3D Tiles (Re:Earth Buildings) は、この地図では描けない。** それでもカタログにあることは
 * 見せる: 行のチェックは押せず、理由を書き、ⓘ から公式のビューアへ案内する。
 */
test('3D Tiles は描けない理由を出し、ⓘ からビューアへ案内する', async ({ page }) => {
  // カタログには出すが、一覧には足せない (この地図では描けない)。
  await openCatalogFor(page, 'reearth-buildings');
  const row = page.locator('[data-catalog-layer="reearth-buildings"]');
  await expect(row.locator('.catalog-add')).toBeDisabled();
  await expect(row).toContainText('描けません');
  await row.locator('.layer-detail-button').click();
  await expect(page.locator('#layer-detail-dialog')).toBeVisible();
  const card = page.locator('.collection-card[data-collection="reearth-buildings"]');
  await expect(card.locator('a', { hasText: 'ビューア' })).toHaveAttribute('href', 'https://buildings.reearth.land/');
  await expect(card).toContainText('楕円体');
  await expect(card.locator('.derived-from', { hasText: '建物' })).toBeVisible();
});

/**
 * **配っていない元データ (AW3D30) も、カタログにあることは見せる。** 足せないが、
 * ⓘ から公開元の STAC (COG) と使う条件 (商用は事前に連絡) が分かる。
 */
test('参照だけの元データは足せず、ⓘ から公開元の STAC と使う条件が分かる', async ({ page }) => {
  await openCatalogFor(page, 'jaxa-aw3d30');
  const row = page.locator('[data-catalog-layer="jaxa-aw3d30"]');
  await expect(row.locator('.catalog-add')).toBeDisabled();
  await expect(row).toContainText('配っていません');
  await row.locator('.layer-detail-button').click();
  const card = page.locator('.collection-card[data-collection="jaxa-aw3d30"]');
  await expect(card).toContainText('DSM');
  await expect(card.locator('.terms-badge', { hasText: '商用は事前に連絡' })).toBeVisible();

  // **公開元の STAC はページの中で開く。** 置き場所 (Wasabi) が binary/octet-stream で返すので、
  // ブラウザで開くとダウンロードになる。外の配信は叩かず、同じ型で返す応答に差し替える。
  await page.route(/AW3D30\.v4\.1_global\/collection\.json$/, (route) =>
    route.fulfill({
      contentType: 'binary/octet-stream',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        type: 'Collection',
        id: 'JAXA.EORC_ALOS.PRISM_AW3D30.v4.1_global',
        title: 'ALOS World 3D - 30m (AW3D30)',
        links: [{ rel: 'child', href: './2024-04/catalog.json', type: 'application/json' }],
      }),
    }),
  );
  await card.locator('button', { hasText: 'Collection を見る' }).click();
  const viewer = page.locator('#stac-viewer');
  await expect(viewer.locator('#stac-title')).toHaveText('ALOS World 3D - 30m (AW3D30)');
  // 中の相対リンクは、その文書の URL から解く (うちの配信の起点からではない)。
  await expect(viewer.locator('.stac-link').first()).toContainText(
    'https://s3.ap-northeast-1.wasabisys.com/je-pds/cog/v1/JAXA.EORC_ALOS.PRISM_AW3D30.v4.1_global/2024-04/catalog.json',
  );
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
      { message: '地形タイルが届くまで待つ', timeout: DATA_TIMEOUT },
    )
    .toBeGreaterThan(300);
});

/**
 * **引いたら整備範囲が出る。** 「ズームしないとデータがあるか見えない」のを
 * やめた。建物そのものを引いた表示で出す道は無い (簡略化はフットプリントが
 * 1px未満で効かず、高さで選ぶのは基準に意味を持たせられない) ので、
 * **どこまで整備されているか**を1kmのメッシュで見せる。
 *
 * **bboxではなくメッシュなのが肝。** 306都市のbboxの和は日本をほぼ覆うので、
 * 収録の無い山間部でも「ある」ことになってしまう。
 */
test('引くと整備範囲がメッシュで出て、寄ると建物に切り替わる', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  // 港区あたり。建物データを切り出した範囲の中に入る。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7554, 35.6586], zoom: 16 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);
  // 寄ったら整備範囲は出さない。**実物が出るので重ねる意味が無い。**
  await expect.poll(() => sourceFeatureCount(page, 'buildings-coverage')).toBe(0);

  // 引くと入れ替わる。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7554, 35.6586], zoom: 9 });
  });
  // **メッシュが複数出る。** 1つしか出ないならbboxの箱に戻ってしまっている。
  await expect.poll(() => sourceFeatureCount(page, 'buildings-coverage')).toBeGreaterThan(1);
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBe(0);

  // 何を見ているかを言う。「ズームしろ」とは言わない。
  await expect(page.locator('#building-count')).toContainText('整備範囲');
  await expect(page.locator('#building-count')).not.toContainText('寄ると出ます');
});

/**
 * **メッシュの中身はホバーでしか分からない。** 塗りに濃淡を付けていない
 * (建物の数で濃くすると人口密集部が濃くなるだけで、整備されているかとは
 * 別のものを見せてしまう) ので、どのメッシュでどの自治体かはここで読む。
 */
test('整備範囲はホバーでメッシュコードと自治体が出る', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  // 東京駅あたり。**1kmメッシュが出るズーム**で、確実にセルがある場所。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7671, 35.6812], zoom: 12 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings-coverage')).toBeGreaterThan(0);

  // セルが描かれるまで待ってから、そこをなぞる。
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as TestWindow).__map!.queryRenderedFeatures(
            { x: 400, y: 300 } as unknown as never,
            { layers: ['buildings-coverage-fill'] },
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  await page.locator('#map canvas').hover({ position: { x: 400, y: 300 } });

  const info = page.locator('.hover-info');
  await expect(info).toBeVisible();
  // **メッシュコードそのものが読めること。** 3次メッシュは8桁。
  await expect(info).toContainText(/\d{8}/);
  await expect(info).toContainText('メッシュコード');
  // **どの自治体が整備されているかが読めること。**
  await expect(info).toContainText('自治体');
  await expect(info).toContainText('都');
});

/**
 * **整備範囲は起動時に読まれるので、転送量に効く。**
 *
 * ファイルは0.71MBだが、UIが要るのは `mesh_code` と `buildings` と `bbox` だけで、
 * `geometry` 列 (row groupあたり212KB) は読まない — 矩形はコードから計算する。
 * ここが効かなくなると**起動するだけで数百KB余分に取る**ようになる。
 */
test('整備範囲はジオメトリ列を読まない', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  const dataset = await datasetUrl(page, 'plateau_bldg_coverage');
  expect(dataset, '整備範囲がカタログに無い').not.toBeNull();

  let fetchedBytes = 0;
  page.on('response', (response) => {
    if (response.url() !== dataset) return;
    if (response.request().method() === 'HEAD') return;
    fetchedBytes += Number(response.headers()['content-length'] ?? 0);
  });

  await page.reload();
  await waitForReady(page);
  await expect.poll(() => sourceFeatureCount(page, 'buildings-coverage')).toBeGreaterThan(0);

  console.log(`整備範囲の転送量: ${(fetchedBytes / 1024).toFixed(0)} KB`);
  expect(fetchedBytes, '転送量を計測できていない').toBeGreaterThan(0);
  // 1 row group ぶんの必要な列で約154KB。ジオメトリ列まで読むと倍以上になる。
  expect(
    fetchedBytes,
    `整備範囲を読みすぎ: ${(fetchedBytes / 1024).toFixed(0)} KB。` +
      'ジオメトリ列 (212KB/group) を読んでいる可能性がある',
  ).toBeLessThan(400 * 1024);
});

/**
 * **整備範囲は引くほど粗く束ねる。** 1kmで配ってあるものを、コードを前から
 * 切って10kmや80kmにする (人口メッシュと同じ仕組み)。束ねないと全国で
 * 35,645セルを描くことになる。
 */
test('整備範囲は引くほど粗いメッシュになる', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  /**
   * セル1つの幅 (経度の度数)。**件数では比べられない** — ズームを変えると
   * 表示範囲も変わるので、粗い方が多いことすらある (実測でどちらも239セル)。
   * 粗くなったかどうかは**セルの大きさ**に出る。
   */
  const cellWidthAt = async (zoom: number, size: string) => {
    await page.evaluate((z) => {
      const map = (window as unknown as TestWindow).__map!;
      map.jumpTo({ center: [139.7554, 35.6586], zoom: z });
    }, zoom);
    // **件数で待たない。** 前のズームのセルがまだ残っているので、
    // 新しい粒度が届く前に「0件より多い」が通ってしまう (それで最初は
    // ズーム7で1kmのセルを測っていた)。粒度の表示が変わるのを待つ。
    await expect(page.locator('#building-count')).toContainText(size);
    return page.evaluate(async () => {
      const map = (window as unknown as TestWindow).__map!;
      const source = map.getSource('buildings-coverage') as GeoJSONSource;
      const data = await source.getData();
      if (data.type !== 'FeatureCollection') return 0;
      const ring = (data.features[0].geometry as GeoJSON.Polygon).coordinates[0];
      return Math.max(...ring.map((c) => c[0])) - Math.min(...ring.map((c) => c[0]));
    });
  };

  // 3次メッシュ (1km) は経度45秒 = 1/80度。2次メッシュ (10km) は7分30秒 = 1/8度。
  expect(await cellWidthAt(12, '1km')).toBeCloseTo(1 / 80, 5);
  expect(await cellWidthAt(7, '10km')).toBeCloseTo(1 / 8, 5);
});

/**
 * **束ねたセルは「埋まり具合」を持つ。**
 *
 * 1つでも子があれば塗る形だと、日本全体が見えるまで引いたときにほぼ全国が
 * 埋まって見える。実測では10kmメッシュ939個の平均充足率は38%で、
 * 満杯なのは36個しかない (159個は5セル以下)。
 *
 * **塗りの濃さは測れない**ので (MapLibreの解決後の値は取り出せない)、
 * ソースの `ratio` が実際に散らばっていることで確かめる。
 */
test('束ねた整備範囲は埋まり具合で濃淡が付く', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  const ratios = async (zoom: number, size: string, center: [number, number]) => {
    await page.evaluate(
      ([z, lon, lat]) => {
        const map = (window as unknown as TestWindow).__map!;
        map.jumpTo({ center: [lon, lat], zoom: z });
      },
      [zoom, center[0], center[1]] as const,
    );
    // 件数ではなく粒度の表示で待つ (前のズームのセルが残っているため)。
    await expect(page.locator('#building-count')).toContainText(size);
    return page.evaluate(async () => {
      const map = (window as unknown as TestWindow).__map!;
      const source = map.getSource('buildings-coverage') as GeoJSONSource;
      const data = await source.getData();
      if (data.type !== 'FeatureCollection') return [];
      return data.features.map((f) => f.properties as { ratio: number; filled: number; total: number });
    });
  };

  // **本州の中ほどを広く映す。** 東京だけを見ていると満杯のセルしか拾えない。
  const coarse = await ratios(7, '10km', [137.0, 36.5]);
  expect(coarse.length, 'セルが取れていない').toBeGreaterThan(0);

  // 10kmメッシュの上限は1kmセル100個。
  expect(coarse.every((c) => c.total === 100)).toBe(true);
  expect(coarse.every((c) => c.filled >= 1 && c.filled <= c.total)).toBe(true);

  // **満杯ではないセルが実在すること。** ここが本題 — 全部1.0なら濃淡に意味がない。
  expect(coarse.some((c) => c.ratio < 1)).toBe(true);
  // 一様でないこと。最小と最大が離れていることで見る。
  const values = coarse.map((c) => c.ratio);
  expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.2);

  // **濃淡を数で裏付ける。** 色だけでは「薄い」が読み取れないので、
  // 束ねているときはホバーに「N / 100」が出る。
  //
  // **固定のピクセルを指さない。** 10kmに束ねると画面内のどこにセルがあるかは
  // 中心の緯度経度で変わり、決め打ちだと空振りする。しかも左下のパネルが
  // 地図をかなり覆っていて、その上を指すとパネルがイベントを取ってしまう
  // (最初この2つで落ちた)。**キャンバスが実際に受け取れる点**を探す。
  const point = await page.evaluate(async () => {
    const map = (window as unknown as TestWindow).__map!;
    const source = map.getSource('buildings-coverage') as GeoJSONSource;
    const data = await source.getData();
    if (data.type !== 'FeatureCollection') return null;
    const canvas = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    for (const feature of data.features) {
      const ring = (feature.geometry as GeoJSON.Polygon).coordinates[0];
      const at = map.project([(ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2]);
      // 縁ぎりぎりだと隣のセルに乗るので、余白を取った内側だけを使う。
      const inside =
        at.x > 40 && at.y > 40 && at.x < canvas.clientWidth - 40 && at.y < canvas.clientHeight - 40;
      if (!inside) continue;
      // パネルや検索欄に覆われていないこと。覆われているとhoverが届かない。
      if (document.elementFromPoint(rect.left + at.x, rect.top + at.y) !== canvas) continue;
      return { x: Math.round(at.x), y: Math.round(at.y) };
    }
    return null;
  });
  expect(point, '画面に出ていて、かつ覆われていないセルが無い').not.toBeNull();

  await page.locator('#map canvas').hover({ position: point! });
  await expect(page.locator('.hover-info')).toContainText('データのある1kmセル');
  await expect(page.locator('.hover-info')).toContainText(/\d+ \/ 100 \(\d+%\)/);

  // 1kmで見ているときは束ねていないので、必ず1/1になる。
  // **東京に寄る。** さきほどの中心 (山間部) はそもそも整備されていないので、
  // そのまま寄ると0件になる — それ自体がこの機能の存在理由でもある。
  const fine = await ratios(12, '1km', [139.7671, 35.6812]);
  expect(fine.length).toBeGreaterThan(0);
  expect(fine.every((c) => c.total === 1 && c.filled === 1)).toBe(true);
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

  // 大阪市の中心部。**港区のファイルとは重ならない。**
  //
  // 大阪にもPLATEAUの建物はある (306都市を整備した) ので、件数は0にならない。
  // ここで見たいのは**港区のファイルに触らないこと**なので、そちらだけを数える。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [135.5023, 34.6937], zoom: 16 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);
  expect(requested).toEqual([]);

  // 重なる場所へ行けば読む。これが無いと「そもそも何も通信していない」だけでも
  // 上の判定が通ってしまう。
  //
  // **件数で待たない。** 大阪の建物がまだソースに残っているので、
  // 港区のデータが届く前に「0件より多い」が通ってしまう。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 16 });
  });
  await expect.poll(() => requested.length, { timeout: DATA_TIMEOUT }).toBeGreaterThan(0);
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

  // **ホバーの吹き出し。** 判定の結果 (`.result-popup`) とは別物で、
  // 整備範囲のメッシュを足してから両方が同時に出る場面ができた。
  await expect(page.locator('.hover-popup .maplibregl-popup-content')).toBeVisible();

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

  await expect(page.locator(`[data-layer="${LAYER.plateauBuildings}"]`)).toBeVisible();
  await openLayerSettings(page, LAYER.plateauBuildings);
  // **どの出所の設定かは、開いた行で分かる。** 設定の要素は出所の間で共有している。
  await expect(
    page.locator(`[data-layer="${LAYER.plateauBuildings}"] .layer-settings-slot #building-filters`),
  ).toBeVisible();
  await expect(page.locator('#height-field')).toBeVisible();

  // 用途の選択肢はコードに書かず、カタログの語彙 (summaries) から作っている。
  // 語彙を持つ列があるかどうかで、用途で絞れるかも決まる。
  await expect.poll(() => page.locator('#usage-options label').count()).toBeGreaterThan(5);

  // Overtureも高さの列を持つので、高さでは絞れる。
  await useOvertureBuildings(page);
  await expect(
    page.locator(`[data-layer="${LAYER.overtureBuildings}"] .layer-settings-slot #height-field`),
  ).toBeVisible();
});

// 1つの用途だけ見たいときに、残り13個を手で外させない。
test('用途は一括で切り替えられる', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  await showPlateauBuildings(page);
  // 用途の1つ1つはたたんである (まず重要度の段で足りるため)。
  await page.locator('#usage-field > summary').click();
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
  await page.locator('#usage-field > summary').click();
  await page.locator('#usage-options input').first().uncheck();

  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeLessThan(before);
});

/**
 * **重要度の段で絞り、色分けできる。** 用途は十数個あり、1つずつ切り替えるのは
 * 重い。段 (公共施設 / 商業・業務 / 住宅・その他) にまとめてある。
 *
 * 段の規則はカタログ (`duck:tiers`) から来る。画面の文言を書き写さず、
 * カタログと突き合わせる。
 */
test('重要度の段で絞り込めて、色分けできる', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  await showPlateauBuildings(page);

  // 段の題名はカタログのとおりに並ぶ。
  const collection = (await bundledCollection<{
    'duck:tiers': { tiers: { id: string; title: string }[] };
  }>(page, LAYER.plateauBuildings))!;
  const titles = collection['duck:tiers'].tiers.map((t) => t.title);
  await expect(page.locator('#tier-options label')).toHaveText(titles);

  /** 描かれている建物の段の題名 (重複なし)。 */
  const tiersShown = () =>
    page.evaluate(async () => {
      const map = (window as unknown as TestWindow).__map!;
      const data = await (map.getSource('buildings') as GeoJSONSource).getData();
      if (data.type !== 'FeatureCollection') return [];
      return [...new Set(data.features.map((f) => f.properties?.tier as string))].sort();
    });

  // 港区なら3段とも出ている。
  await expect.poll(async () => (await tiersShown()).length).toBe(titles.length);

  // **いちばん重要な段だけにする。** 学校や官公庁は港区にもある。
  const boxes = page.locator('#tier-options input');
  for (let i = 1; i < titles.length; i++) await boxes.nth(i).uncheck();
  await expect.poll(tiersShown).toEqual([titles[0]]);

  // **重要度で色分けする。** 引き直さず塗りだけ替える。
  const paint = () =>
    page.evaluate(() =>
      JSON.stringify(
        (window as unknown as TestWindow).__map!.getPaintProperty('buildings-3d', 'fill-extrusion-color'),
      ),
    );
  expect(await paint()).not.toContain('tierRank');
  await page.locator('#tier-color').check();
  expect(await paint()).toContain('tierRank');
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
  await showLayer(page, LAYER.mesh);
  await expect.poll(() => sourceFeatureCount(page, 'population-mesh')).toBeGreaterThan(0);
  await openLayerSettings(page, LAYER.mesh);
}

// 地上リスクの中心はSORAのiGRCで、その入力は人口密度。
// 既定では出さない (建物を見に来た人の邪魔になる) が、出せることが分かる形にする。
test('人口密度は切り替えで出せる', async ({ page }) => {
  test.skip(!(await hasMesh(page)), '人口メッシュのデータが無い');

  // 既定では一覧に無い。足すまで読みにも行かない。
  expect(await sourceFeatureCount(page, 'population-mesh')).toBe(0);

  // カタログから足すと出る。
  await showPopulationMesh(page);
  await expect(page.locator('#mesh-summary')).toContainText('人/km²');

  // 外せば消える。
  await hideLayer(page, LAYER.mesh);
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

  await openLayerSettings(page, LAYER.mesh);
  for (const zoom of [15, 13, 11, 8]) {
    await page.evaluate((z) => {
      const map = (window as unknown as TestWindow).__map!;
      map.jumpTo({ center: [139.7454, 35.6586], zoom: z });
    }, zoom);
    if (zoom === 15) await showLayer(page, LAYER.mesh);
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
  await openLayerSettings(page, LAYER.mesh);
  await showLayer(page, LAYER.mesh);
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
  await openLayerSettings(page, LAYER.mesh);
  await showLayer(page, LAYER.mesh);
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
  // 路線と駅は別のCollectionなので一覧でも別の行。両方入れる。
  await showLayer(page, LAYER.railway);
  await showLayer(page, LAYER.stations);
  await expect.poll(() => sourceFeatureCount(page, 'railway')).toBeGreaterThan(0);
  await openLayerSettings(page, LAYER.railway);
}

// 既定では出さない (建物を見に来た人の邪魔になる)。出せることが分かる形にする。
test('鉄道は切り替えで出せる', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  // 既定では一覧に無い。足すまで読みにも行かない。
  expect(await sourceFeatureCount(page, 'railway')).toBe(0);

  await showRailway(page);
  await expect(page.locator(`.layer-row[data-layer="${LAYER.stations}"]`)).toBeVisible();
  await expect(page.locator('#railway-summary')).toContainText('路線');
  await expect.poll(() => sourceFeatureCount(page, 'railway-stations')).toBeGreaterThan(0);

  // **路線と駅は別々に切れる。** 以前は1行で常に一緒に出ていた。
  await hideLayer(page, LAYER.stations);
  await expect.poll(() => sourceFeatureCount(page, 'railway-stations')).toBe(0);
  expect(await sourceFeatureCount(page, 'railway')).toBeGreaterThan(0);

  await hideLayer(page, LAYER.railway);
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
/**
 * **引いた表示でも鉄道が出る。** 「ズームしないとデータがあるか見えない」のを
 * やめた。全国を原寸で読むと4.5MBになるので、引いたときは粗い段 (`lod = 0`) を
 * 引く — 全国597本・329KBで足りる。
 */
test('引いた表示でも鉄道が出て、簡略表示だと断る', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await showRailway(page);

  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [138.0, 37.0], zoom: 6 });
  });

  // **出る。** ここが0に戻ったら、隠す実装に戻ってしまっている。
  await expect.poll(() => sourceFeatureCount(page, 'railway')).toBeGreaterThan(0);
  await expect(page.locator('#railway-summary')).not.toContainText('まで寄ると出ます');
  // 黙って簡略化したものを見せない。どこから原寸になるかも言う。
  await expect(page.locator('#railway-summary')).toContainText('簡略表示');
});

/**
 * 寄れば原寸に切り替わる。粗い段に留まると、細部が出ないまま気付けない。
 *
 * **件数では比べられない** (ズームを変えると表示範囲も変わる) ので、
 * 断り書きが消えることで見る。
 */
test('寄ると鉄道が原寸に切り替わる', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await showRailway(page);
  const summary = page.locator('#railway-summary');

  const goTo = async (zoom: number) => {
    await page.evaluate((z) => {
      const map = (window as unknown as TestWindow).__map!;
      map.jumpTo({ center: [139.7671, 35.6812], zoom: z });
    }, zoom);
    await expect.poll(() => sourceFeatureCount(page, 'railway')).toBeGreaterThan(0);
  };

  await goTo(8);
  await expect(summary).toContainText('簡略表示');

  await goTo(14);
  await expect(summary).not.toContainText('簡略表示');
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

/**
 * **粗い段を置いた効果を、転送量で確かめる。**
 *
 * ここが段の効果を測れる唯一の確かな場所。手元のファイルは page cache に
 * 乗るので、読み飛ばしを時間では測れない (実測で原寸と粗い段の差が出なかった)。
 *
 * 全国の鉄道を原寸で読むと4.5MB、道路 (高速) は9.4MB。粗い段はそれぞれ
 * 329KB / 483KB なので、**段が効いていれば1MBに収まる**。
 * 効かなくなると「引いた瞬間に数MB」に黙って落ちる。
 */
test('引いた表示の転送量は粗い段のぶんで収まる', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  const dataset = await datasetUrl(page, RAILWAY_DATASET);
  let fetchedBytes = 0;
  page.on('response', (response) => {
    if (response.url() !== dataset) return;
    if (response.request().method() === 'HEAD') return;
    fetchedBytes += Number(response.headers()['content-length'] ?? 0);
  });

  // 日本全体が入るズーム。原寸なら全国を読むことになる縮尺。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [138.0, 37.0], zoom: 5 });
  });
  // 測っているのは路線のファイルだけなので、路線の行だけ入れる。
  await showLayer(page, LAYER.railway);
  await expect.poll(() => sourceFeatureCount(page, 'railway')).toBeGreaterThan(0);

  console.log(`全国 (ズーム5) の鉄道の転送量: ${(fetchedBytes / 1024).toFixed(0)} KB`);
  expect(fetchedBytes, '転送量を計測できていない').toBeGreaterThan(0);
  expect(
    fetchedBytes,
    `引いた表示で読みすぎ: ${(fetchedBytes / 1024).toFixed(0)} KB。` +
      '粗い段 (329KB) を読めていない可能性がある',
  ).toBeLessThan(1024 * 1024);
});

// 出所を見ただけでは版が分からず、古いものを新しいと思って使う事故になる。
// 分かっているものには版を添える (分からないものには**書かない**)。
test('出典にいつ時点のデータかが出る', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await openInfoDialog(page, 'credits-dialog');
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
  // **ホバーの吹き出し** (判定の結果とは別物)。
  const popup = page.locator('.hover-popup .maplibregl-popup-content');
  await expect(popup).toBeVisible();
  // 項目名は値と分かれた列になっている (`setText` の改行は潰れるので要素で組んでいる)。
  await expect(popup).toContainText('事業者');
  await expect(popup.locator('.hover-info .label').first()).toBeVisible();
});

/**
 * **一覧はカタログの階層そのもの。** サブカタログ (PLATEAU / Overture Maps …) が
 * 見出しで、Collectionが行。以前は「建物」「道路」のように使う側のまとまりで
 * 組んでいて、画面からカタログが見えなかった。
 *
 * 見出しを**カタログから読んで**突き合わせる。一覧側の文言を書き写すと、
 * パイプラインで題名を変えたときに両方が揃って変わり、ずれを検出できない。
 */
test('カタログのダイアログはカタログの階層で並ぶ', async ({ page }) => {
  await expect(page.locator('#layer-list')).toBeVisible();

  // サブカタログの題名 (カタログの順)。まとめに入っている順はルートの child の順と同じ
  // (パイプラインの stac_i18n のテストが確かめている)。
  const groups = (await readBundle(page))['duck:catalogs'].map((c) => c.title);
  expect(groups.length, 'サブカタログが無い (平らなカタログのまま?)').toBeGreaterThan(0);

  // 見出しは**カタログの順に**、**カタログの題名で**並ぶ。行を持たない
  // サブカタログ (位置参照情報は検索の裏方だけ) は見出しを出さない。
  await page.locator('.layer-add-button[data-section="data"]').click();
  const dialog = page.locator('#layer-catalog-dialog');
  for (const section of ['data', 'tile', 'view']) {
    await dialog.locator(`.catalog-tab[data-section="${section}"]`).click();
    const headings = await dialog.locator('.catalog-group-title').allTextContents();
    expect(headings.length, `${section} に見出しが無い`).toBeGreaterThan(0);
    expect(groups).toEqual(expect.arrayContaining(headings));
    expect(headings).toEqual(groups.filter((title) => headings.includes(title!)));
  }
  await closeCatalog(page);

  // **行IDはCollection ID。** 行とCollectionを同じ名前で呼ぶ。
  await expect(page.locator(`[data-layer="${LAYER.plateauBuildings}"]`)).toBeVisible();
});

/**
 * ⚙ を開くと、**その行がカタログのどこから来ているか**が出る。
 *
 * 絞り込みだけだと、行の裏にあるのがどのCollectionで、何ファイルあって、
 * 元のJSONはどこかが画面から辿れない。
 */
test('ⓘ を開くとCollectionの中身とJSONへのリンクが出る', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  await openLayerDetails(page, LAYER.plateauBuildings);
  // どの行のことかは、ダイアログの見出しで分かる。
  await expect(page.locator('#layer-detail-title')).toContainText('PLATEAU');
  const card = page.locator(`.collection-card[data-collection="${LAYER.plateauBuildings}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(LAYER.plateauBuildings);

  // **ファイル数はItemCollectionを開いたときに読む。** 起動時には読まない約束。
  await expect(card.locator('.collection-item-count')).toHaveText(/^[\d,]+ 件$/);

  // **整備範囲は建物の行の中に出る** (`duck:covers` で結ばれている)。行にはしない。
  await expect(page.locator('.collection-card[data-collection="plateau-buildings-coverage"]')).toBeVisible();
  await expect(page.locator('[data-layer="plateau-buildings-coverage"]')).toHaveCount(0);
});

/**
 * **STACの文書はページの中で開き、リンクを辿って歩ける。**
 *
 * 以前は生のJSONを別タブで開いていた。地図から離れるうえ、そこから先
 * (親・子・Item) へは自分でURLを組み立てないと行けなかった。
 * 中身はカタログから読んで突き合わせる (画面の文言を書き写さない)。
 */
test('STACの文書はページの中で開いて、リンクを辿れる', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  const viewer = page.locator('#stac-viewer');
  const type = page.locator('#stac-type');
  const json = page.locator('#stac-json');
  /** 表示中の文書から `rel` のリンクを押す。 */
  const follow = (rel: string) =>
    page.locator('#stac-links dt', { hasText: new RegExp(`^${rel}$`) }).locator('+ dd button').first().click();

  await openLayerDetails(page, LAYER.plateauBuildings);
  await page
    .locator(`.collection-card[data-collection="${LAYER.plateauBuildings}"] .collection-head .json-link`)
    .click();

  // **別タブではなく、ページの中に出る。**
  await expect(viewer).toBeVisible();
  await expect(type).toHaveText('Collection');
  await expect(json).toContainText(`"id": "${LAYER.plateauBuildings}"`);

  // Item (ファイル) の一覧へ進む。stac-geoparquet (アセット) から、この Collection の行だけを読む。
  // 306件あるので、全部は整形して出さない。
  // **ファイルの形 (Parquet か JSON か) までは見ない** — 公開時は新しいアプリを先に出し、
  // 文書を後から上げ直すので、その間は古い ItemCollection (rel: items) を辿ることになる。
  await follow('items');
  await expect(type).toHaveText('FeatureCollection');
  await expect(page.locator('#stac-note')).toContainText('件のうち先頭');
  await expect(json).toContainText(`"collection": "${LAYER.plateauBuildings}"`);

  // 戻って、親 (サブカタログ) へ。**見出しと同じ題名**であること。
  await page.locator('#stac-back').click();
  await expect(type).toHaveText('Collection');
  await follow('parent');
  await expect(type).toHaveText('Catalog');
  await expect(page.locator('#stac-title')).toHaveText('PLATEAU');

  // 閉じれば地図に戻る。
  await page.locator('#stac-close').click();
  await expect(viewer).toBeHidden();
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

  await openLayerSettings(page, LAYER.plateauBuildings);
  const opened = (await panel.boundingBox())!.height;
  expect(opened, `設定がはみ出している: ${opened}px / 画面 ${viewport}px`).toBeLessThan(viewport);

  // 開いても**一覧はそのまま**触れる (他の行のチェックボックスが見える)。
  await expect(page.locator(`#layer-toggle-${LAYER.plateauBuildings}`)).toBeVisible();
  // もう一度 ⚙ で閉じる。
  await page.locator(`[data-layer="${LAYER.plateauBuildings}"] .layer-settings-button`).click();
  await expect(page.locator('.layer-settings-slot')).toHaveCount(0);
});

/**
 * 検索と逆ジオコーディングが使っているデータは**切れてはいけない**
 * (外すと検索が壊れる)。一覧には出すが、チェックボックスは付けない。
 */
/**
 * 収録範囲の外へ行くと「この範囲にはありません」へ移る。**隠さない** —
 * 「無い」と分かるのも情報なので、薄く出したままにする。
 */
test('収録範囲の外では「この範囲にはありません」に移る', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データが無い');

  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 14 }); // 港区
  });
  const row = page.locator(`#layer-rows [data-layer="${LAYER.plateauBuildings}"]`);
  await expect(row).not.toHaveClass(/absent/);

  // **収録範囲の外は日本の外まで出ないと無い。** PLATEAUを306都市に広げたので、
  // 札幌や大阪のような都市はもう収録されている。ここは三陸沖。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [150.0, 40.0], zoom: 14 });
  });
  // 一覧からは外さない (足したものは ✕ を押すまで残る)。薄くして「無い」と言う。
  await expect(row).toHaveClass(/absent/);
  await expect(row).toContainText('この範囲にはありません');
  // カタログのダイアログでも同じ。
  await openCatalogFor(page, LAYER.overtureBuildings);
  await expect(page.locator(`[data-catalog-layer="${LAYER.plateauBuildings}"]`)).toContainText('この範囲にはありません');
});

/**
 * **整備範囲を持つ出所は、メッシュで「この範囲にあるか」を決める。**
 *
 * Collectionの収録範囲 (bbox) だけで決めると、PLATEAUは306都市の和が日本を
 * ほぼ覆う箱になり、山の中でも「ある」と出る。上のテストが三陸沖まで
 * 出ないと「無い」を確かめられなかったのはそのため。
 *
 * ここは飛騨の山中 (白山の東)。**箱の内側だが、ズーム12の画面に整備範囲の
 * セルが1つも無い** (実測。北アルプスは山小屋や集落で460セルあって使えなかった)。
 */
test('整備範囲の外では、収録範囲の箱の内側でも「この範囲にはありません」に移る', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  const jump = (center: [number, number]) =>
    page.evaluate((c) => {
      (window as unknown as TestWindow).__map!.jumpTo({ center: c, zoom: 12 });
    }, center);

  const row = page.locator(`#layer-rows [data-layer="${LAYER.plateauBuildings}"]`);
  // 港区。整備範囲の内側。
  await jump([139.7454, 35.6586]);
  await expect(row).not.toHaveClass(/absent/);

  // 飛騨の山中。箱の内側なので、箱だけで決めると「ある」のまま。
  await jump([137.0, 36.0]);
  await expect(row).toHaveClass(/absent/);

  // 戻れば「ある」に戻る。**答えは表示範囲ごとに聞き直す。**
  await jump([139.7454, 35.6586]);
  await expect(row).not.toHaveClass(/absent/);
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

  // **状態は行ごと** (出所ごと)。建物はPLATEAUとOvertureで2行ある。
  const status = (layer: string) => page.locator(`[data-layer-status="${layer}"]`);

  // **PLATEAUは引いた表示でも整備範囲が出るので、寄れとは言わない。**
  await expect(status(LAYER.plateauBuildings)).not.toContainText('まで寄ると出ます');
  await expect(status(LAYER.plateauBuildings)).toContainText('整備範囲');

  // 整備範囲を持たない出所 (Overture) では今も出ない。**そのときは理由を言う。**
  await useOvertureBuildings(page);
  await expect(status(LAYER.overtureBuildings)).toContainText('ズーム');
  await expect(status(LAYER.overtureBuildings)).toContainText('まで寄ると出ます');
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

  await page.locator(`[data-layer="${LAYER.plateauBuildings}"] .layer-zoom-button`).click();

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

/**
 * 駅名は**人が実際に検索する語**。地名と行政区域だけでは、
 * 「東京駅」と打っても何も出ない状態だった。
 */
test('駅名で検索できる', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await page.locator('#search-input').fill('東京');
  const station = page.locator('#results li', { hasText: '駅' }).first();
  await expect(station).toBeVisible({ timeout: DATA_TIMEOUT });
  await expect(station).toContainText('東京駅');

  await station.click();
  // 駅は点ではなく線 (ホームの延長) なので、bboxの中心へ飛ぶ。
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__map!.getZoom()))
    .toBeGreaterThan(14);
});

/** 路線名でも引ける。「山手線」でその路線の駅が出る。 */
test('路線名でも駅が引ける', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await page.locator('#search-input').fill('山手線');
  const first = page.locator('#results li').first();
  await expect(first).toBeVisible({ timeout: DATA_TIMEOUT });
  await expect(first).toContainText('山手線');
});

/**
 * **一覧の行は2段まで。** 状態は2段目に1行で切るが、全文は吹き出し (`title`) で読める。
 * 出所と版は名前の吹き出しに出す。行ごとに2〜3行あると、足すたびに一覧が大きく伸びた。
 */
test('一覧の行は2段に収まり、切った状態は吹き出しで全文が読める', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');
  await page.evaluate(() => {
    (window as unknown as TestWindow).__map!.jumpTo({ center: [139.7454, 35.6586], zoom: 12 });
  });
  const status = page.locator(`[data-layer-status="${LAYER.plateauBuildings}"]`);
  await expect(status).toContainText('整備範囲');
  // 吹き出しは状態の全文。
  expect(await status.getAttribute('title')).toBe(await status.textContent());
  // 名前の吹き出しに出所と版。
  await expect(page.locator(`.layer-row[data-layer="${LAYER.plateauBuildings}"] .layer-name`)).toHaveAttribute(
    'title',
    /PLATEAU/,
  );
  // 状態は1行 (行の高さは1段目 + 状態1行)。
  const { height, fontSize } = await status.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    fontSize: parseFloat(getComputedStyle(el).fontSize),
  }));
  expect(height).toBeLessThan(fontSize * 2);
});

/**
 * **何で検索できるかが分かること。** 出典とは別の節にしてある
 * (出典は表示義務、こちらは「何を打てば当たるか」の案内)。
 *
 * 検索欄の下に置いていたが、候補が1件2段になって縦に伸び、
 * 左下のデータと重なるので右下へ移した。
 */
test('何で検索できるかが読める', async ({ page }) => {
  await openInfoDialog(page, 'search-dialog');
  const support = page.locator('#search-dialog');
  // **打つ言葉で書く。**「位置参照情報」では何を打てばいいか分からない。
  await expect(support).toContainText('市区町村');
  await expect(support).toContainText('鉄道の路線');
  // 何を打てばよいかの例を添える。
  await expect(support.locator('.search-item-example').first()).toContainText('例:');
  // 検索に使っていない街区は載せない。
  await expect(support).not.toContainText('街区');
  // **切り替えさせない。** 外すと検索が壊れるので、チェックボックスは出さない。
  expect(await support.locator('input[type="checkbox"]').count()).toBe(0);
});

/** 検索していないとき、左上のパネルが地図を覆わないこと。 */
test('検索していないときは左上が地図を塞がない', async ({ page }) => {
  const covered = await page.evaluate(() => {
    const el = document.elementFromPoint(200, 200);
    return el?.closest('#search-panel') !== null;
  });
  expect(covered, '検索欄が地図の (200,200) を覆っている').toBe(false);
});

/**
 * 背景地図と地形は**出所の見出しの下の行**。既定で出ているが、それを理由に見出しは開かない
 * (開くと国土地理院とMapterhornが常に開いて一覧が伸びる)。見出しの件数で出ていると分かる。
 */
test('地図タイルは足したものを重ね順に並べ、ドラッグで入れ替え、✕ で外せる', async ({ page }) => {
  // 既定では淡色地図だけ。ほかはカタログのダイアログの中。
  expect(await shownTiles(page)).toEqual([BASEMAP.pale]);
  await expect(page.locator('#terrain-toggle')).toBeChecked();
  await expect(page.locator(`[data-layer="${BASEMAP.pale}"] .layer-name`)).toHaveAttribute('title', /地図タイル/);

  // 足すと**いちばん上**に入り、一覧でも上に並ぶ (何が上かが一覧で見える)。
  await showLayer(page, BASEMAP.photo);
  expect(await shownTiles(page)).toEqual([BASEMAP.photo, BASEMAP.pale]);
  expect(await visibleBasemaps(page)).toEqual([BASEMAP.pale, BASEMAP.photo]);

  // 写真を淡色地図の下へドラッグ。地図の重ね順も入れ替わる。
  await dragRow(page, BASEMAP.photo, BASEMAP.pale, 'below');
  await expect.poll(() => shownTiles(page)).toEqual([BASEMAP.pale, BASEMAP.photo]);
  await expect.poll(() => visibleBasemaps(page)).toEqual([BASEMAP.photo, BASEMAP.pale]);
  // キーボードでも動かせる (⋮⋮ を選んで ↓)。動かしたあともフォーカスは同じ行に残る。
  const handle = page.locator(`.layer-row[data-layer="${BASEMAP.pale}"] .layer-drag-handle`);
  await handle.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => shownTiles(page)).toEqual([BASEMAP.photo, BASEMAP.pale]);
  await expect(handle).toBeFocused();
  await expect.poll(() => visibleBasemaps(page)).toEqual([BASEMAP.pale, BASEMAP.photo]);

  // 隠しても一覧に残る。✕ で外すと一覧から消え、地図からも消える。
  await hideLayer(page, BASEMAP.photo);
  expect(await shownTiles(page)).toEqual([BASEMAP.photo, BASEMAP.pale]);
  await showLayer(page, BASEMAP.photo);
  await page.locator(`[data-layer="${BASEMAP.photo}"] .layer-remove-button`).click();
  expect(await shownTiles(page)).toEqual([BASEMAP.pale]);
  expect(await visibleBasemaps(page)).toEqual([BASEMAP.pale]);
  // カタログでは、また足せる状態に戻る。
  await openCatalogFor(page, BASEMAP.photo);
  await expect(page.locator(`[data-catalog-layer="${BASEMAP.photo}"] .catalog-add`)).toBeEnabled();
  await closeCatalog(page);
});

/**
 * **データも上の行ほど上に重なる。** 足すと既定の重なりの位置に入り (人口メッシュは
 * 建物の下)、ドラッグで入れ替えると地図の層の順も入れ替わる。データは地図タイルより常に上。
 */
test('データの重ね順も一覧で入れ替えられる', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データが無い');
  const order = () =>
    page.evaluate(() => {
      const ids = (window as unknown as TestWindow).__map!.getStyle().layers.map((l) => l.id);
      return { mesh: ids.indexOf('population-mesh-fill'), buildings: ids.indexOf('buildings-3d'), tiles: ids.indexOf('anchor/tiles') };
    });
  await showLayer(page, LAYER.mesh);
  const rows = () =>
    page.locator('#layer-rows > [data-layer]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.layer!));
  // 人口メッシュは建物の下に入る。
  expect(await rows()).toEqual([LAYER.plateauBuildings, LAYER.mesh]);
  let o = await order();
  expect(o.mesh).toBeLessThan(o.buildings);
  expect(o.tiles).toBeLessThan(o.mesh);

  await dragRow(page, LAYER.mesh, LAYER.plateauBuildings, 'above');
  await expect.poll(rows).toEqual([LAYER.mesh, LAYER.plateauBuildings]);
  o = await order();
  expect(o.mesh).toBeGreaterThan(o.buildings);
  expect(o.tiles).toBeLessThan(o.buildings);
});

/**
 * **読み直せば既定に戻る** (端末には覚えない)。覚えておくと、前に何を足したかで
 * 起動時の見た目と読み込む量が変わる。
 */
test('足したものは読み直すと既定に戻る', async ({ page }) => {
  await showLayer(page, BASEMAP.photo);
  await hideLayer(page, BASEMAP.pale);
  await page.reload();
  await waitForReady(page);
  expect(await shownTiles(page)).toEqual([BASEMAP.pale]);
  expect(await visibleBasemaps(page)).toEqual([BASEMAP.pale]);
});

/**
 * **同名の駅を混ぜない。**
 *
 * 「本線」は複数の会社が使う一般名で、駅名と路線名だけで束ねると
 * 住吉駅 (兵庫と福岡) が同じ組になり、平均を取ると**600km離れた中間点**
 * (海の上) へ飛ぶ。運営会社まで入れて分けてある。
 */
test('同名の駅を束ねて海へ飛ばさない', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await page.locator('#search-input').fill('住吉');
  const hit = page.locator('#results li', { hasText: '住吉駅' }).first();
  await expect(hit).toBeVisible({ timeout: DATA_TIMEOUT });
  await hit.click();

  // flyTo は1.5秒かけて動くので、止まるまで待つ。すぐ読むと出発地点のまま。
  const near = (lng: number, lat: number, tLng: number, tLat: number) =>
    Math.abs(lng - tLng) < 0.5 && Math.abs(lat - tLat) < 0.5;
  await expect
    .poll(
      async () => {
        const c = await page.evaluate(() => {
          const v = (window as unknown as TestWindow).__map!.getCenter();
          return { lng: v.lng, lat: v.lat };
        });
        // 兵庫 (135.3, 34.7) か福岡 (130.4, 33.6) のどちらかであること。
        // 束ね方を誤ると、その中間 (約132.8, 34.2 = 瀬戸内海) へ飛ぶ。
        return near(c.lng, c.lat, 135.27, 34.72) || near(c.lng, c.lat, 130.42, 33.59);
      },
      { message: 'どちらの住吉駅でもない地点で止まっている' },
    )
    .toBe(true);
});

/**
 * **「品川駅」と打って0件だった。**
 *
 * 原典の `station_name` は「品川」で「駅」が付かないため、素直に連結すると
 * 「品川駅」がどこにも一致しない。人がふつうに打つ形で引けること。
 */
test('「〜駅」と打っても引ける', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await page.locator('#search-input').fill('品川駅');
  await expect(page.locator('#results li').first()).toContainText('品川駅', {
    timeout: DATA_TIMEOUT,
  });
});

/**
 * 路線名で引いたら**路線そのものが先頭**に出る。
 * 駅ばかり並ぶと、路線を見たい人の役に立たない。
 */
test('路線名で引くと路線が先頭に出て、全体へ寄る', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await page.locator('#search-input').fill('山手線');
  const first = page.locator('#results li').first();
  await expect(first).toContainText('路線', { timeout: DATA_TIMEOUT });
  await expect(first).toContainText('山手線');

  await first.click();
  // 路線は点ではなく範囲。端から端まで入る縮尺まで引く。
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__map!.getZoom()))
    .toBeLessThan(14);
});

/**
 * 路線を選んだら**線そのものをハイライトする。**
 *
 * 範囲へ動かすだけだと、鉄道レイヤーを出しているときに
 * 「どれが選んだ路線か」が分からない。原典に線のジオメトリはある
 * (実測で山手線は65区間・8KB) ので、選んだときだけ読む。
 */
test('路線を選ぶと線がハイライトされる', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  expect(await highlightFeatureCount(page)).toBe(0);

  await page.locator('#search-input').fill('山手線');
  const first = page.locator('#results li').first();
  await expect(first).toContainText('路線', { timeout: DATA_TIMEOUT });
  await first.click();

  await expect.poll(() => highlightFeatureCount(page), { timeout: DATA_TIMEOUT }).toBe(1);

  // 線であること (行政区域のポリゴンと同じソースを使い回している)。
  // ハイライトは1件を Feature として入れている (行政区域のポリゴンと同じ作り)。
  const type = await page.evaluate(async () => {
    const map = (window as unknown as TestWindow).__map!;
    const data = await (map.getSource('highlight') as GeoJSONSource).getData();
    if (data.type === 'Feature') return data.geometry.type;
    if (data.type === 'FeatureCollection') return data.features[0]?.geometry.type;
    return data.type;
  });
  expect(type).toBe('MultiLineString');
});

/** 駅の候補には**会社名と路線名**が付く。「品川駅 (本線)」では何線か分からない。 */
test('駅の候補に会社名と路線名が出る', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await page.locator('#search-input').fill('品川駅');
  const first = page.locator('#results li').first();
  await expect(first).toContainText('品川駅', { timeout: DATA_TIMEOUT });
  await expect(first.locator('.result-detail')).toBeVisible();
  // 会社名が入っていること (「本線」だけでは判別できない)。
  await expect(first.locator('.result-detail')).toContainText('鉄');
});

/**
 * **検索候補が他のパネルに隠れないこと。**
 *
 * 候補は1件2段 (駅なら「会社名 路線名」) あるので、10件並ぶと画面の下まで届く。
 * 左下のデータのパネルと同じ重なり順だと、後から置いた側に隠れて選べなくなる。
 */
test('検索候補は他のパネルより手前に出る', async ({ page }) => {
  await page.locator('#search-input').fill('東京');
  const results = page.locator('#results li');
  await expect(results.first()).toBeVisible({ timeout: DATA_TIMEOUT });

  // いちばん下の候補の中心が、実際にその候補で取れること
  // (データのパネルに覆われていれば、そちらが返る)。
  const covered = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#results li')];
    const last = items[items.length - 1];
    if (!last) return 'no-results';
    const box = last.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return at?.closest('#results') ? null : (at?.closest('[id]')?.id ?? 'unknown');
  });
  expect(covered, `候補が覆われている: ${covered}`).toBeNull();
});

/**
 * **線をハイライトしたときに、塗りが出ないこと。**
 *
 * ハイライトのソースは行政区域 (ポリゴン) と路線 (線) で使い回している。
 * MapLibre の fill レイヤーは**線のジオメトリも閉じた輪として塗ってしまう**ので、
 * 路線を選ぶと線の周りが橙色に塗り潰される。東海道線のように
 * 品川〜武蔵小杉〜鶴見と品川〜川崎〜鶴見が輪を作る路線では特に目立つ。
 */
test('路線のハイライトに塗りが出ない', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');

  await page.locator('#search-input').fill('東海道線');
  const first = page.locator('#results li').first();
  await expect(first).toContainText('路線', { timeout: DATA_TIMEOUT });
  await first.click();
  await expect.poll(() => highlightFeatureCount(page), { timeout: DATA_TIMEOUT }).toBe(1);

  // **描き終わってから数える。** flyTo の途中だと、まだ線が画面に入っておらず
  // 塗りが出ていても 0 になる (実際それで一度見逃した)。
  // 併せて線そのものは出ていることを確かめ、「何も描かれていないから 0」と
  // 取り違えないようにする。
  const drawn = await page.evaluate(async () => {
    const map = (window as unknown as TestWindow).__map!;
    if (!map.isMoving() && map.loaded()) await new Promise((r) => setTimeout(r, 500));
    else await new Promise<void>((r) => map.once('idle', () => r()));
    return {
      fill: map.queryRenderedFeatures(undefined, { layers: ['highlight-fill'] }).length,
      line: map.queryRenderedFeatures(undefined, { layers: ['highlight-outline'] }).length,
    };
  });
  expect(drawn.line).toBeGreaterThan(0);
  expect(drawn.fill).toBe(0);
});

const ROAD_DATASET = 'overture_roads_trunk';

async function hasRoads(page: Page): Promise<boolean> {
  return (await datasetUrl(page, ROAD_DATASET)) !== null;
}

/** 道路を表示し、描かれるまで待つ。 */
async function showRoads(page: Page, zoom = 13) {
  await page.evaluate((z) => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7671, 35.6812], zoom: z }); // 東京駅
  }, zoom);
  await showLayer(page, LAYER.road);
  await expect.poll(() => sourceFeatureCount(page, 'road'), { timeout: 60_000 }).toBeGreaterThan(0);
}

/**
 * **主役は「ここに何があるか」。** 道路は一覧に並び、切り替えで出せる。
 * 既定で出さないのは、幹線だけで65.6万区間あって他のデータを覆うため。
 */
test('道路は切り替えで出せる', async ({ page }) => {
  test.skip(!(await hasRoads(page)), '道路のデータが無い');

  // 一覧に足すまで読みにも行かない。
  // **足した後では確かめない** — カタログから足すとその場で表示がオンになるので、
  // 0件かどうかはデータが届く速さ次第になる (Item の読み込みが速くなって落ちた)。
  expect(await sourceFeatureCount(page, 'road')).toBe(0);
  await revealLayer(page, LAYER.road);

  await showRoads(page);
});

/** 件数は行に出る。「この範囲に何区間あるか」が読めること。 */
test('道路の件数が一覧に出る', async ({ page }) => {
  test.skip(!(await hasRoads(page)), '道路のデータが無い');

  await showRoads(page);
  await expect(page.locator(`[data-layer="${LAYER.road}"]`)).toContainText('区間', { timeout: DATA_TIMEOUT });
});

/**
 * **引いた表示でも道路が出る。** 「ズームしないとデータがあるか見えない」のを
 * やめた。原寸の幹線は65.6万区間・9.4MBあるので、引いたときは粗い段 (`lod = 0`) を
 * 引く — 全国の高速は1,360本・483KBで足りる。
 */
test('引いた表示でも道路が出て、簡略表示だと断る', async ({ page }) => {
  test.skip(!(await hasRoads(page)), '道路のデータが無い');

  // 日本全体が入るズーム。**原寸を読んだら転送量が跳ね上がる縮尺。**
  await showRoads(page, 6);

  // **出る。** ここが0に戻ったら、隠す実装に戻ってしまっている。
  expect(await sourceFeatureCount(page, 'road')).toBeGreaterThan(0);
  await expect(page.locator('#road-summary')).not.toContainText('まで寄ると出ます');
  // 黙って簡略化したものを見せない。どこから原寸になるかも言う。
  await expect(page.locator('#road-summary')).toContainText('簡略表示');
});

/**
 * **簡略化だけでは足りない。** 転送量は粗い段で収まるが、全国の都道府県道
 * 4,609本を一度に描くと画面が線で埋まって読めず、細い線が重なるので
 * ツールチップも拾うたびに移り変わる。**引いたら幹線だけにする。**
 */
test('引いた表示では高速道路だけにして、出していない等級を言う', async ({ page }) => {
  test.skip(!(await hasRoads(page)), '道路のデータが無い');

  await showRoads(page, 6);
  const summary = page.locator('#road-summary');

  // **出していない等級があることを言う。** 黙って外すと「チェックしたのに
  // 出ない」ように見える。
  await expect(summary).toContainText('種別はズーム');

  // 出ているのが高速だけであること。地物の種別を直接見る。
  const classes = await page.evaluate(async () => {
    const map = (window as unknown as TestWindow).__map!;
    const source = map.getSource('road') as GeoJSONSource;
    const data = await source.getData();
    if (data.type !== 'FeatureCollection') return [];
    return [...new Set(data.features.map((f) => f.properties?.roadClass as string))].sort();
  });
  // 地物が持つのは凡例と同じ呼び名 (`ROAD_STYLES` の label)。
  expect(classes).toEqual(['高速道路']);

  // 寄ると増え、断り書きが消える。
  await showRoads(page, 12);
  await expect(summary).not.toContainText('種別はズーム');
});

/**
 * **表示量は、同じ表示のまま出るものを変える。**
 *
 * 件数で比べると表示範囲に左右される (過去に何度も踏んだ) ので、
 * **ズームを動かさずに設定だけ変え**、閾値をまたいだことで確かめる。
 *
 * | ズーム9の道路 | 国道 | 都道府県道 |
 * | --- | --- | --- |
 * | 控えめ (-2) | 10から | 12から |
 * | 標準 | 8から | 10から |
 * | 多め (+2) | 6から | 8から |
 */
test('表示量を上げると、同じ表示のまま閾値の手前のものが出る', async ({ page }) => {
  test.skip(!(await hasRoads(page)), '道路のデータが無い');
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  const detail = page.locator('#detail-level');
  // 既定は標準。**標準は従来の値と一致させてある** ので、他のテストの基準は動かない。
  await expect(detail).toHaveValue('medium');

  await showRoads(page, 9);
  const summary = page.locator('#road-summary');
  await expect(summary).toContainText('1種別はズーム10から');

  await detail.selectOption('high');
  await expect(summary).not.toContainText('種別はズーム');

  await detail.selectOption('low');
  await expect(summary).toContainText('2種別はズーム10から');

  // 建物。標準だとズーム15から全部なので、14.5では**重要な段だけ** (間引き) が出る。
  await detail.selectOption('medium');
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7671, 35.6812], zoom: 14.5 });
  });
  const count = page.locator('#building-count');
  await expect(count).toContainText('のみ', { timeout: DATA_TIMEOUT });

  // 多めは14から全部。**同じ場所・同じズームのまま**間引きが外れる。
  await detail.selectOption('high');
  await expect(count).not.toContainText('のみ', { timeout: DATA_TIMEOUT });
  await expect(count).toContainText(/\d件/);

  // **覚えていること。** 端末で決まる設定なので、開くたびに選び直させない。
  await page.reload();
  await waitForReady(page);
  await expect(detail).toHaveValue('high');
});

/**
 * 寄れば原寸に切り替わる。粗い段に留まると、細部が出ないまま気付けない。
 *
 * **件数では比べられない。** ズームを変えると表示範囲も変わるので、
 * 引いた粗い段の方が多いことすらある (実測でズーム8が1,995本、ズーム14が860区間)。
 * どちらを読んでいるかは**数える単位**に出る — 粗い段は統合した「本」、
 * 原寸は断片の「区間」。
 */
test('寄ると道路が原寸に切り替わる', async ({ page }) => {
  test.skip(!(await hasRoads(page)), '道路のデータが無い');

  const summary = page.locator('#road-summary');

  await showRoads(page, 8);
  await expect(summary).toContainText('簡略表示');
  await expect(summary).toContainText('本');

  await showRoads(page, 14);
  await expect(summary).not.toContainText('簡略表示');
  await expect(summary).toContainText('区間');
});

/**
 * **等級で絞れる。** ファイルが class ごとに分かれているので、
 * 外した等級はそもそも読みに行かない。
 */
test('道路は種別で絞れる', async ({ page }) => {
  test.skip(!(await hasRoads(page)), '道路のデータが無い');

  await showRoads(page);
  const before = await sourceFeatureCount(page, 'road');

  await openLayerSettings(page, LAYER.road);
  await page.locator('#road-none').click();
  await expect.poll(() => sourceFeatureCount(page, 'road'), { timeout: DATA_TIMEOUT }).toBe(0);

  await page.locator('#road-all').click();
  await expect.poll(() => sourceFeatureCount(page, 'road'), { timeout: 60_000 }).toBe(before);
});

/**
 * **「国道13号」で引ける。** 国のデータ (N13・地理院の道路中心線) は
 * 路線名を持たないので、名前で引けるのはOvertureだけ
 * (docs/data-sources.md の「道路」を参照)。
 */
test('国道の名前で引くと路線全体へ寄る', async ({ page }) => {
  test.skip(!(await hasRoads(page)), '道路のデータが無い');

  await page.locator('#search-input').fill('国道13号');
  const first = page.locator('#results li').first();
  await expect(first).toContainText('国道13号', { timeout: 60_000 });
  // 何で引いたかが分かること。
  await expect(first.locator('.badge')).toHaveText('道路');

  await first.click();
  // 福島〜秋田にまたがるので、選ぶと大きく引く。
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__map!.getZoom()), {
      timeout: 60_000,
    })
    .toBeLessThan(10);
});

/** 選んだ道路は線としてハイライトされる。鉄道の路線と同じ見せ方。 */
test('道路を選ぶと線がハイライトされる', async ({ page }) => {
  test.skip(!(await hasRoads(page)), '道路のデータが無い');

  expect(await highlightFeatureCount(page)).toBe(0);

  await page.locator('#search-input').fill('国道13号');
  const first = page.locator('#results li').first();
  await expect(first).toContainText('国道13号', { timeout: 60_000 });
  await first.click();

  await expect.poll(() => highlightFeatureCount(page), { timeout: 60_000 }).toBe(1);

  const type = await page.evaluate(async () => {
    const map = (window as unknown as TestWindow).__map!;
    const data = await (map.getSource('highlight') as GeoJSONSource).getData();
    if (data.type === 'Feature') return data.geometry.type;
    if (data.type === 'FeatureCollection') return data.features[0]?.geometry.type;
    return data.type;
  });
  expect(type).toBe('MultiLineString');
});

/**
 * **道路が候補を埋めないこと。**
 *
 * 「東京」には109の路線が当たる。上限を掛けずに前へ出したときは
 * 候補10件をすべて道路が占め、東京駅も東京都も消えた。
 * 打った語そのものを指す道路 (「国道13号」) は先頭のままにしたいので、
 * 上限を掛けるのは**それ以外**。
 */
test('道路の候補が駅や地名を押し出さない', async ({ page }) => {
  test.skip(!(await hasRoads(page)), '道路のデータが無い');

  await page.locator('#search-input').fill('東京');
  await expect(page.locator('#results li').first()).toBeVisible({ timeout: 60_000 });

  const badges = await page.locator('#results li .badge').allTextContents();
  expect(badges.filter((b) => b === '道路').length).toBeLessThanOrEqual(3);
  // 駅と行政区域が残っていること。
  expect(badges).toContain('駅');
});

/**
 * **配信しているものと原典の差を示す。**
 *
 * PLATEAUの建物は `bldg:lod0RoofEdge` (屋根の外周線) だけを読み、高さの数値で
 * 押し出しているので、どの建物も箱になる。原典にはもっと入っていて
 * (港区はLOD3まである)、**見ている人はそれを知る手段が無かった。**
 */
test('建物の件数に原典のLODが添えられる', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  await showPlateauBuildings(page);
  const count = page.locator('#building-count');
  await expect(count).toContainText('表示はLOD0', { timeout: DATA_TIMEOUT });
  // 港区の原典はLOD3まである。**件数と一緒の行に出す** (行を増やさない)。
  await expect(count).toContainText('原典はLOD3まで');
  await expect(count).toContainText('件');
});

/** LODの概念が無い出所には出さない。Overtureの建物には原典のLODが無い。 */
test('OvertureにはLODを出さない', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  await showPlateauBuildings(page);
  await expect(page.locator('#building-count')).toContainText('LOD', { timeout: DATA_TIMEOUT });

  await useOvertureBuildings(page);
  // **件数が出るまで待ってから見る。** 空のうちは「LODを含まない」が即座に通ってしまう。
  await expect(page.locator('#building-count')).toContainText('件', { timeout: DATA_TIMEOUT });
  await expect(page.locator('#building-count')).not.toContainText('LOD');
});

/**
 * **建物は出所ごとに出せて、両方出すこともできる。**
 *
 * 以前は設定の中の選択欄で択一だった。一覧をカタログの階層にしたので、
 * PLATEAUとOvertureは別の行になり、それぞれにチェックがある。重なったところで
 * どちらの建物か見分けられるよう、地物に出所 (`origin`) と塗り分けの番号
 * (`palette`) を持たせている。
 */
test('建物は出所ごとに出せて、両方出すと塗り分けられる', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データ (Overture) が無い');
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');

  /** 出所ごとの件数と、それぞれに付いた塗り分けの番号。 */
  const byOrigin = () =>
    page.evaluate(async () => {
      const map = (window as unknown as TestWindow).__map!;
      const data = await (map.getSource('buildings') as GeoJSONSource).getData();
      const result: Record<string, { count: number; palettes: number[] }> = {};
      if (data.type !== 'FeatureCollection') return result;
      for (const feature of data.features) {
        const { origin, palette } = feature.properties as { origin: string; palette: number };
        const entry = (result[origin] ??= { count: 0, palettes: [] });
        entry.count += 1;
        if (!entry.palettes.includes(palette)) entry.palettes.push(palette);
      }
      return result;
    });

  // 港区。**両方の出所が収録している場所。**
  await showPlateauBuildings(page);
  await showLayer(page, LAYER.overtureBuildings);

  await expect
    .poll(async () => Object.keys(await byOrigin()).sort(), { timeout: DATA_TIMEOUT })
    .toEqual([LAYER.overtureBuildings, LAYER.plateauBuildings].sort());

  // **出所ごとに1つの番号で、互いに違う。** 同じだと重なったところで見分けられない。
  const both = await byOrigin();
  const plateauPalettes = both[LAYER.plateauBuildings].palettes;
  const overturePalettes = both[LAYER.overtureBuildings].palettes;
  expect(plateauPalettes).toHaveLength(1);
  expect(overturePalettes).toHaveLength(1);
  expect(plateauPalettes[0]).not.toBe(overturePalettes[0]);

  // **件数は行ごとに出る。** 1つの要約を両方の行に写すと同じ数が並んでしまう。
  await expect(page.locator(`[data-layer-status="${LAYER.plateauBuildings}"]`)).toContainText('件');
  await expect(page.locator(`[data-layer-status="${LAYER.overtureBuildings}"]`)).toContainText('件');

  // 片方を外せば、そちらだけ消える。
  await hideLayer(page, LAYER.plateauBuildings);
  await expect.poll(async () => Object.keys(await byOrigin())).toEqual([LAYER.overtureBuildings]);
  await expect(page.locator(`[data-layer-status="${LAYER.plateauBuildings}"]`)).toHaveText('');
});

/**
 * **送電線と川は、道路と同じく引いた表示でも出る** (粗い段)。寄れば原寸の区間になる。
 *
 * 出所は Overture (元は OpenStreetMap)。送電線は全国で8割が名前を持たないので、
 * 粗い段は名前・種別・タイルで束ねてある (名前だけで束ねると引いた表示から8割が消える)。
 * **件数ではなく数える単位で見分ける** — 粗い段は「本」、原寸は「区間」。
 */
for (const [layer, label] of [
  [LAYER.powerLines, '送電線'],
  [LAYER.waterways, '川'],
] as const) {
  test(`${label}は引いた表示で粗い段、寄ると原寸で出る`, async ({ page }) => {
    const exists = page.locator(`[data-layer="${layer}"]`);
    test.skip((await exists.count()) === 0, `${label}のデータが無い`);

    const status = page.locator(`[data-layer-status="${layer}"]`);
    const jump = (zoom: number) =>
      page.evaluate((z) => {
        (window as unknown as TestWindow).__map!.jumpTo({ center: [139.75, 35.65], zoom: z });
      }, zoom);

    await jump(7);
    await showLayer(page, layer);
    await expect(status).toContainText('本', { timeout: DATA_TIMEOUT });
    await expect(status).toContainText('簡略表示');

    await jump(14);
    await expect(status).toContainText('区間', { timeout: DATA_TIMEOUT });
    await expect(status).not.toContainText('簡略表示');

    // ホバーで名前と種別が出る。地図に描かれていることも兼ねて確かめる。
    const drawn = await page.evaluate(
      (id) =>
        (window as unknown as TestWindow).__map!.queryRenderedFeatures(undefined as never, {
          layers: [id],
        }).length,
      `line-${layer === LAYER.powerLines ? 'power_line' : 'waterway'}`,
    );
    expect(drawn).toBeGreaterThan(0);
  });
}

/**
 * **引いた表示では、重要な段の建物だけをタイル (PMTiles) で描く。** 1ズーム引くごとに1段減らす。
 *
 * GeoParquet を DuckDB で読むと、都市ごとのファイルを十数個開いて R2 で1分近くかかった
 * (東京駅 z13 で 39秒 → タイルで 10秒)。タイルは数えられないので、件数の代わりに段だけを言う。
 */
test('引いた表示では重要な段の建物だけをタイルで描く (間引き)', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');
  const collection = (await bundledCollection<{
    'duck:tiers': { lod_column?: string; tiers: { title: string }[] };
    assets?: { tiles?: { href: string } };
  }>(page, LAYER.plateauBuildings))!;
  test.skip(!collection.assets?.tiles, '建物のタイルがまだ無いカタログ');
  const titles = collection['duck:tiers'].tiers.map((t) => t.title);

  /** 開いた建物のファイル (タイルと GeoParquet)。 */
  const opened = new Set<string>();
  page.on('request', (request) => {
    const file = request.url().split('/').pop()!;
    if (file.startsWith('plateau_bldg_') && !file.includes('coverage')) opened.add(file);
  });

  const layer = `buildings-tiles/${LAYER.plateauBuildings}`;
  /** 描かれている建物の段の順位 (重複なし)。描き終わるまで待ってから数える。 */
  const ranks = async () => {
    await page.waitForFunction(
      (id) => {
        const map = (window as unknown as TestWindow).__map!;
        return map.areTilesLoaded() && map.queryRenderedFeatures({ layers: [id] }).length > 0;
      },
      layer,
      { timeout: DATA_TIMEOUT },
    );
    return page.evaluate((id) => {
      const map = (window as unknown as TestWindow).__map!;
      return [...new Set(map.queryRenderedFeatures({ layers: [id] }).map((f) => f.properties.lod as number))].sort();
    }, layer);
  };
  const jump = (zoom: number) =>
    page.evaluate((z) => {
      (window as unknown as TestWindow).__map!.jumpTo({ center: [139.7671, 35.6812], zoom: z });
    }, zoom);
  const count = page.locator(`[data-layer-status="${LAYER.plateauBuildings}"]`);

  // 13.x: 公共施設だけ。
  await jump(13.5);
  await expect(count).toContainText(`${titles[0]}のみ`, { timeout: DATA_TIMEOUT });
  // **件数は出さない** (タイルは数えられない)。
  await expect(count).not.toContainText('件');
  expect(await ranks()).toEqual([0]);
  // **都市ごとの GeoParquet は開かない。** 開いたら、タイルを使わずに問い合わせへ戻っている。
  console.log(`間引き (ズーム13.5) で開いた建物のファイル: ${[...opened].join(', ')}`);
  expect([...opened].some((file) => file.endsWith('.pmtiles'))).toBe(true);
  expect([...opened].filter((file) => file.endsWith('.parquet'))).toEqual([]);

  // 14.x: 公共施設と商業・業務。
  await jump(14.5);
  await expect(count).toContainText(`${titles[0]}・${titles[1]}のみ`, { timeout: DATA_TIMEOUT });
  expect((await ranks()).every((rank) => rank <= 1)).toBe(true);

  // それより引くと整備範囲。タイルの層は隠れる。
  await jump(12.5);
  await expect(count).toContainText('整備範囲', { timeout: DATA_TIMEOUT });
  expect(
    await page.evaluate((id) => (window as unknown as TestWindow).__map!.getLayoutProperty(id, 'visibility'), layer),
  ).toBe('none');
});

/** 周辺検索の待ち受けに入り、地図の点を押す。 */
async function nearbyAt(page: Page, point: { x: number; y: number }) {
  await page.locator('#nearby-button').click();
  await expect(page.locator('#nearby-panel')).toBeVisible();
  await expect(page.locator('#nearby-origin')).toContainText('クリック');
  await page.locator('#map canvas').click({ position: point });
}

/**
 * `from` の近くで、地物が何も描かれておらず、パネルにも覆われていない点。
 * 内側から外へ渦を巻くように探す。
 */
async function emptyPointNear(page: Page, from: { x: number; y: number }) {
  const point = await page.evaluate((from) => {
    const map = (window as unknown as TestWindow).__map!;
    const canvas = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    for (let radius = 0; radius <= 200; radius += 8) {
      for (let angle = 0; angle < 360; angle += radius === 0 ? 360 : 30) {
        const x = from.x + radius * Math.cos((angle * Math.PI) / 180);
        const y = from.y + radius * Math.sin((angle * Math.PI) / 180);
        const box: [[number, number], [number, number]] = [
          [x - 4, y - 4],
          [x + 4, y + 4],
        ];
        if (map.queryRenderedFeatures(box).length > 0) continue;
        if (document.elementFromPoint(rect.left + x, rect.top + y) !== canvas) continue;
        return { x: Math.round(x), y: Math.round(y) };
      }
    }
    return null;
  }, from);
  expect(point, '地物の無い点が近くに見つからない').not.toBeNull();
  return point!;
}

/** パネルの「建物」の行の合計 (「1,234 棟」)。無ければ0。 */
async function nearbyBuildingTotal(page: Page): Promise<number> {
  const text = (await page.locator('#nearby-results dd').first().textContent()) ?? '';
  const match = text.match(/([\d,]+) 棟/);
  return match ? Number(match[1].replace(/,/g, '')) : 0;
}

/**
 * **周辺検索 — 地図上の点から。** ○m以内の建物 (段ごと)・駅・人口が出て、
 * 範囲の輪郭と当たった建物が地図に重なる。**距離を広げると件数は減らない。**
 */
test('周辺検索: 地図上の点から、建物と駅が出て、距離を広げても減らない', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');
  await page.evaluate(() => {
    (window as unknown as TestWindow).__map!.jumpTo({ center: [139.7671, 35.6812], zoom: 16 });
  });
  await expect
    .poll(() => sourceFeatureCount(page, 'buildings'), { timeout: DATA_TIMEOUT })
    .toBeGreaterThan(0);
  // **描き終わるまで待つ。** 途中で「空いている点」を探すと、あとから描かれた建物の上を押す
  // ことになる (建物のファイルを並べ直して、届く順が変わったときに落ちた)。
  await expect(page.locator('#building-count')).toContainText('件', { timeout: DATA_TIMEOUT });
  await expect(page.locator('#busy')).toBeHidden({ timeout: DATA_TIMEOUT });

  // 東京駅の近くで、地物が描かれていない (= 点が起点になる) ところを押す。
  // 中心は駅舎の建物の上なので、押すと建物が起点になる。
  await nearbyAt(page, await emptyPointNear(page, { x: 640, y: 360 }));
  const results = page.locator('#nearby-results');
  await expect(page.locator('#nearby-origin')).toContainText('地図上の点', { timeout: DATA_TIMEOUT });
  await expect(results).toContainText('棟', { timeout: DATA_TIMEOUT });
  await expect(results.locator('dt', { hasText: '駅' })).toBeVisible();
  await expect(results).toContainText('東京駅');
  expect(await sourceFeatureCount(page, 'nearby-zone')).toBe(1);
  expect(await sourceFeatureCount(page, 'nearby-hits')).toBeGreaterThan(0);
  // **押したもの (起点) を強調する。** 地図上の点なら点が1つ。
  expect(await sourceFeatureCount(page, 'nearby-origin')).toBe(1);
  // 当たった線 (駅・鉄道) も描く。**範囲で切り取る** (範囲の外まで伸ばさない)。
  expect(await sourceFeatureCount(page, 'nearby-hit-lines')).toBeGreaterThan(0);
  const outside = await page.evaluate(async () => {
    const map = (window as unknown as TestWindow).__map!;
    const zone = (await (map.getSource('nearby-zone') as GeoJSONSource).getData()) as GeoJSON.Feature;
    const ring = (zone.geometry as GeoJSON.Polygon).coordinates[0];
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const lines = (await (map.getSource('nearby-hit-lines') as GeoJSONSource).getData()) as GeoJSON.FeatureCollection;
    const points = lines.features.flatMap((f) => {
      const g = f.geometry;
      if (g.type === 'LineString') return g.coordinates;
      if (g.type === 'MultiLineString') return g.coordinates.flat();
      return [];
    });
    // 範囲の外接矩形から少しでも外れた点の数 (切り取っていれば0)。
    const eps = 1e-6;
    return points.filter(
      ([x, y]) =>
        x < Math.min(...xs) - eps || x > Math.max(...xs) + eps || y < Math.min(...ys) - eps || y > Math.max(...ys) + eps,
    ).length;
  });
  expect(outside).toBe(0);
  // **結果だけを目立たせる** (既定で入っている)。元の建物の立体は隠し (当たった建物を
  // 同じ場所に立体で描くので、残すと壁が重なってちらつく)、ほかのデータは薄くする。
  const buildingsShown = () =>
    page.evaluate(
      () => (window as unknown as TestWindow).__map!.getLayoutProperty('buildings-3d', 'visibility') !== 'none',
    );
  await expect(page.locator('#nearby-focus')).toBeChecked();
  expect(await buildingsShown()).toBe(false);
  // 外せば元に戻る。
  await page.locator('#nearby-focus').uncheck();
  expect(await buildingsShown()).toBe(true);
  await page.locator('#nearby-focus').check();
  // **種類ごとに地図への表示を切り替えられる。** 駅を外すと、当たった線から駅が消える。
  const kindsDrawn = () =>
    page.evaluate(() => {
      const map = (window as unknown as TestWindow).__map!;
      return [
        ...new Set(map.queryRenderedFeatures({ layers: ['nearby-hit-lines'] }).map((f) => f.properties.kind)),
      ];
    });
  await expect.poll(kindsDrawn).toContain('駅');
  await page.locator('#nearby-results input[data-nearby-kind="駅"]').uncheck();
  await expect.poll(kindsDrawn).not.toContain('駅');
  await page.locator('#nearby-results input[data-nearby-kind="駅"]').check();

  const near = await nearbyBuildingTotal(page);
  expect(near).toBeGreaterThan(0);
  await page.locator('#nearby-distance').selectOption('300');
  await expect(page.locator('#nearby-origin')).toContainText('300 m', { timeout: DATA_TIMEOUT });
  await expect.poll(() => nearbyBuildingTotal(page), { timeout: DATA_TIMEOUT }).toBeGreaterThanOrEqual(near);

  // **名前の札を押すと、それだけを残して寄る。** もう一度押すと戻る。
  await expect(page.locator('#busy')).toBeHidden({ timeout: DATA_TIMEOUT });
  // 駅の札は「東京駅 (総武線)」の形 (建物の「東京駅丸の内駅舎」と取り違えない)。
  const station = page.locator('#nearby-results .nearby-chip', { hasText: /^東京駅 \(/ }).first();
  const before = await page.evaluate(() => (window as unknown as TestWindow).__map!.getCenter().toArray());
  await station.click();
  await expect(station).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(kindsDrawn).toEqual(['駅']);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__map!.getCenter().toArray()))
    .not.toEqual(before);
  await station.click();
  await expect(station).toHaveAttribute('aria-pressed', 'false');

  // 閉じれば地図から消え、隠した建物も戻る。**Esc でも閉じる** (× を探させない)。
  await page.keyboard.press('Escape');
  await expect(page.locator('#nearby-panel')).toBeHidden();
  await expect.poll(() => sourceFeatureCount(page, 'nearby-zone')).toBe(0);
  expect(await sourceFeatureCount(page, 'nearby-origin')).toBe(0);
  expect(await buildingsShown()).toBe(true);
});

/**
 * 周辺検索の結果の上で、`layer` (と `kind`) がいちばん上に描かれている点。
 * パネルに覆われていないところを、画面を粗く走査して探す。
 */
async function pointOnNearbyHit(page: Page, layer: string, kind?: string) {
  const point = await page.evaluate(
    ({ layer, kind }) => {
      const map = (window as unknown as TestWindow).__map!;
      const canvas = map.getCanvas();
      const rect = canvas.getBoundingClientRect();
      for (let y = 20; y < rect.height - 20; y += 6) {
        for (let x = 20; x < rect.width - 20; x += 6) {
          const top = map.queryRenderedFeatures([x, y], { layers: ['nearby-hits', 'nearby-hit-lines'] })[0];
          if (!top || top.layer.id !== layer) continue;
          if (kind && top.properties.kind !== kind) continue;
          if (document.elementFromPoint(rect.left + x, rect.top + y) !== canvas) continue;
          // ページの座標で返す (page.mouse に渡す)。
          return { x: rect.left + x, y: rect.top + y };
        }
      }
      return null;
    },
    { layer, kind },
  );
  expect(point, `${layer} ${kind ?? ''} の描かれた点が見つからない`).not.toBeNull();
  return point!;
}

/**
 * **当たったものにも吹き出しが出る。** 結果は元の層の上に別の層で描き、当たった建物の
 * 下では元の建物を隠すので、層ごとのホバーだと吹き出しが消えていた。鉄道や駅は地図に
 * 出していなくても当たるので、押しても何も出なかった。**押しても出る** (スマホ)。
 */
test('周辺検索: 当たった建物と駅にも、ホバーと押したときに吹き出しが出る', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');
  await page.evaluate(() => {
    (window as unknown as TestWindow).__map!.jumpTo({ center: [139.7671, 35.6812], zoom: 16 });
  });
  await expect
    .poll(() => sourceFeatureCount(page, 'buildings'), { timeout: DATA_TIMEOUT })
    .toBeGreaterThan(0);
  await nearbyAt(page, await emptyPointNear(page, { x: 640, y: 360 }));
  await expect(page.locator('#nearby-results')).toContainText('東京駅', { timeout: DATA_TIMEOUT });
  await expect(page.locator('#busy')).toBeHidden({ timeout: DATA_TIMEOUT });
  const popup = page.locator('.hover-popup');

  const building = await pointOnNearbyHit(page, 'nearby-hits');
  await page.mouse.move(building.x, building.y);
  await expect(popup).toContainText('周辺検索');
  await expect(popup).toContainText('出所');

  // 鉄道は地図に出していない (一覧に無い) が、駅は当たっている。押すと吹き出しが出る。
  await expect(page.locator(`.layer-row[data-layer="${LAYER.stations}"]`)).toHaveCount(0);
  const station = await pointOnNearbyHit(page, 'nearby-hit-lines', '駅');
  await page.mouse.click(station.x, station.y);
  await expect(popup).toContainText('駅');
  await expect(popup).toContainText('周辺検索');
});

/** **建物を起点にできる。** 建物の上をクリックすると、その建物が起点になる。 */
test('周辺検索: 建物を起点にできる', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');
  await showPlateauBuildings(page);
  // 描かれている建物の上で、パネルに覆われていない点を探す。
  // **見つかるまで探し直す。** ソースにデータが入っても、描かれるのは次の描画から
  // (並列で負荷が高いと間に合わず、1回だけ探すと落ちた)。
  const findPoint = () =>
    page.evaluate(() => {
      const map = (window as unknown as TestWindow).__map!;
      const canvas = map.getCanvas();
      const rect = canvas.getBoundingClientRect();
      for (let y = 200; y < canvas.clientHeight - 100; y += 20) {
        for (let x = 400; x < canvas.clientWidth - 450; x += 20) {
          if (document.elementFromPoint(rect.left + x, rect.top + y) !== canvas) continue;
          const hit = map.queryRenderedFeatures([x, y] as never, { layers: ['buildings-3d'] });
          if (hit.length > 0) return { x, y };
        }
      }
      return null;
    });
  await expect.poll(findPoint, { message: '建物の上の点が見つからない' }).not.toBeNull();
  const point = await findPoint();
  await nearbyAt(page, point!);
  await expect(page.locator('#nearby-origin')).toContainText('起点: 建物', { timeout: DATA_TIMEOUT });
  await expect(page.locator('#nearby-results')).toContainText('棟', { timeout: DATA_TIMEOUT });
});

/**
 * **鉄道を起点にすると、押した地点の前後 (1.5km) の線で調べる。** 路線全体 (東西線の沿線を
 * 丸ごと) は重く (R2 で1分半)、知りたいのはふつう駅や駅と駅の間くらい。
 * 区間は細かく切れているので、同じ名前の区間を集めてから切り取る (1区間だけだと駅に届かない)。
 */
test('周辺検索: 鉄道を起点にすると、押した地点の前後の線で調べる', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');
  // 結果を待つのが長い (下) ので、テスト全体の上限も広げる。
  test.setTimeout(DATA_TIMEOUT * 3);
  await showRailway(page, 14);
  // 絞り込みを開いていると一覧が伸びて地図を覆うので、閉じておく。
  await page.locator(`[data-layer="${LAYER.railway}"] .layer-settings-button[aria-expanded="true"]`).click();
  const point = await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    const canvas = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    for (let y = 150; y < canvas.clientHeight - 100; y += 6) {
      for (let x = 400; x < canvas.clientWidth - 450; x += 6) {
        if (document.elementFromPoint(rect.left + x, rect.top + y) !== canvas) continue;
        const hit = map.queryRenderedFeatures([x, y] as never, { layers: ['railway-line'] });
        // 駅の上だと駅が起点になるので、路線だけのところを選ぶ。
        const station = map.queryRenderedFeatures([x, y] as never, { layers: ['railway-station'] });
        if (hit.length > 0 && station.length === 0 && hit[0].properties?.lineName) return { x, y };
      }
    }
    return null;
  });
  expect(point, '路線の上の点が見つからない').not.toBeNull();
  // **線の起点は読む量が増えやすい** (路線全体だと 180回・48MB だった)。読み込みの回数と量を残す。
  let requests = 0;
  let bytes = 0;
  /** ファイルの種類 (名前から数字を除いたもの) → [回数, 量]。 */
  const byKind = new Map<string, [number, number]>();
  page.on('response', (response) => {
    if (!response.url().endsWith('.parquet')) return;
    const size = response.request().method() === 'HEAD' ? 0 : Number(response.headers()['content-length'] ?? 0);
    requests++;
    bytes += size;
    const kind = response.url().split('/').pop()!.replace(/_?[0-9]+\.parquet$/, '').replace(/\.parquet$/, '');
    const [n, b] = byKind.get(kind) ?? [0, 0];
    byKind.set(kind, [n + 1, b + size]);
  });
  const started = Date.now();
  await nearbyAt(page, point!);
  await expect(page.locator('#nearby-origin')).toContainText('起点: 鉄道', { timeout: DATA_TIMEOUT });
  await expect(page.locator('#nearby-origin')).toContainText('押した地点の前後');
  // 前後1.5kmの線の近くには駅がある (都心の駅の間隔は1km前後)。
  // **重い問いなので長めに待つ。** 8種類ほどのデータを調べ、R2 相当の回線で約80秒かかる
  // (速さはここで縛らず、下のログの回数と量で見る)。
  await expect(page.locator('#nearby-results dt', { hasText: '駅' })).toBeVisible({
    timeout: DATA_TIMEOUT * 1.5,
  });
  console.log(
    `周辺検索 (鉄道) の読み込み: ${requests}回・${(bytes / 1e6).toFixed(1)} MB・${((Date.now() - started) / 1000).toFixed(0)}秒 (` +
      [...byKind]
        .sort((a, b) => b[1][1] - a[1][1])
        .map(([kind, [n, b]]) => `${kind} ${n}回・${(b / 1e6).toFixed(1)}MB`)
        .join(', ') +
      ')',
  );
  await expect(
    page.locator('#nearby-results dt', { hasText: '駅' }).locator('+ dd'),
  ).not.toHaveText('なし');
});

/** **検索で選んだものを起点にできる。** ◎を押すとパネルに出てくる。 */
test('周辺検索: 検索で選んだものを起点にできる', async ({ page }) => {
  test.skip(!(await hasRailway(page)), '鉄道のデータが無い');
  const input = page.locator('#search-input');
  await input.fill('東京駅');
  const candidate = page.locator('#results li', { hasText: '東京' }).first();
  await expect(candidate).toBeVisible({ timeout: DATA_TIMEOUT });
  await candidate.click();
  await expect.poll(() => sourceFeatureCount(page, 'selected-point')).toBe(1);

  await page.locator('#nearby-button').click();
  const fromSearch = page.locator('#nearby-from-search');
  await expect(fromSearch).toBeVisible();
  await fromSearch.click();
  await expect(page.locator('#nearby-origin')).toContainText('東京', { timeout: DATA_TIMEOUT });
  await expect(page.locator('#nearby-results dt', { hasText: '駅' })).toBeVisible({ timeout: DATA_TIMEOUT });
});

/** ⓘ を開き、Collection カードの「この範囲を取得」を開く。 */
async function openDownloads(page: Page, layer: string, collectionId: string) {
  await openLayerDetails(page, layer);
  const section = page.locator(`.collection-card[data-collection="${collectionId}"] .download-section`);
  await section.locator('summary').click();
  await expect(section).toContainText('ファイルごと', { timeout: DATA_TIMEOUT });
  return section;
}

/**
 * **この範囲を GeoParquet で保存できる。** ブラウザの中で切り出して書き、
 * 出典と規約をファイルのメタデータに入れる (切り出したものにも条件が付いて回る)。
 */
test('この範囲を GeoParquet で保存でき、出典と規約がファイルに入る', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');
  await page.evaluate(() => {
    (window as unknown as TestWindow).__map!.jumpTo({ center: [139.7454, 35.6586], zoom: 17 });
  });
  const section = await openDownloads(page, LAYER.plateauBuildings, LAYER.plateauBuildings);

  const download = page.waitForEvent('download', { timeout: 60_000 });
  await section.locator('.download-clip').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^plateau-buildings_\d{4}-\d{2}-\d{2}\.parquet$/);
  const path = await file.path();
  const bytes = (await import('node:fs')).readFileSync(path!);
  // Parquet は先頭と末尾が "PAR1"。
  expect(bytes.subarray(0, 4).toString()).toBe('PAR1');
  expect(bytes.subarray(-4).toString()).toBe('PAR1');
  // フッターに GeoParquet の geo と、出典・規約が入っている。
  const footer = bytes.subarray(Math.max(0, bytes.length - 64 * 1024)).toString('latin1');
  expect(footer).toContain('geo');
  expect(footer).toContain('duck:attribution');
  expect(footer).toContain('duck:terms');
  await expect(section.locator('.download-status')).toContainText('保存しました');

  // ファイルごとのリンク (配信しているもの) と配布元。
  await expect(section.locator('.download-files li').first()).toBeVisible();
  await expect(section.locator('.download-files a', { hasText: '配布元' }).first()).toBeVisible();
});

/**
 * **CityGML はメッシュ単位で直接リンクし、ZIPにもまとめられる** (PLATEAU配信サービス)。
 * 配信サービスに負荷をかけないよう、**応答はテストの中で差し替える。**
 * 確かめるのは、表示範囲のメッシュで問い合わせ、packの流れ (依頼→状態→ZIP) を辿ること。
 */
test('CityGML をメッシュ単位で探し、ZIPにまとめられる (配信サービスは差し替え)', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');
  const asked: string[] = [];
  await page.route('https://api.plateauview.mlit.go.jp/**', async (route) => {
    const url = route.request().url();
    asked.push(`${route.request().method()} ${url}`);
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
      });
    if (url.includes('/datacatalog/citygml/m:')) {
      const code = decodeURIComponent(url.split('/m:')[1]).split(',')[0];
      return json({
        cities: [
          {
            files: {
              bldg: [
                {
                  code,
                  maxLod: 2,
                  url: `https://assets.example.invalid/${code}_bldg_6697_op.gml`,
                  fileSize: 1234567,
                  features: 321,
                },
              ],
              tran: [{ code, maxLod: 1, url: `https://assets.example.invalid/${code}_tran_6697_op.gml` }],
            },
          },
        ],
      });
    }
    if (url.endsWith('/citygml/pack')) return json({ id: 'abc' });
    if (url.endsWith('/citygml/pack/abc/status')) return json({ status: 'succeeded', progress: 1 });
    return route.fulfill({ status: 404 });
  });

  await page.evaluate(() => {
    (window as unknown as TestWindow).__map!.jumpTo({ center: [139.7454, 35.6586], zoom: 16 });
  });
  const section = await openDownloads(page, LAYER.plateauBuildings, LAYER.plateauBuildings);
  // **押すまで配信サービスを呼ばない。**
  expect(asked).toEqual([]);
  await section.locator('.citygml-find').click();
  await expect(section.locator('.citygml-files li').first()).toBeVisible({ timeout: DATA_TIMEOUT });
  // 表示範囲 (港区) のメッシュで問い合わせている。港区は 5339 の1次メッシュ。
  expect(asked.some((a) => a.includes('/datacatalog/citygml/m:5339'))).toBe(true);
  // 種類を選べて、建物が先頭。
  await expect(section.locator('.citygml-type option').first()).toContainText('建物');
  await expect(section.locator('.citygml-files li').first()).toContainText('LOD2');

  await section.locator('.citygml-pack').click();
  await expect(section.locator('.download-status a', { hasText: 'ZIP' })).toHaveAttribute(
    'href',
    'https://api.plateauview.mlit.go.jp/citygml/pack/abc.zip',
    { timeout: DATA_TIMEOUT },
  );
  expect(asked.some((a) => a.startsWith('POST') && a.endsWith('/citygml/pack'))).toBe(true);
});

// ---- 外部のベクトルタイル (地理院) ------------------------------------------

const GSI_VECTOR = 'gsi-optimal-bvmap';
/** テーマの行ID。 */
const gsiRow = (theme: string) => `${GSI_VECTOR}--${theme}`;

/** カタログに地理院のベクトルタイルが載っているか。 */
async function hasGsiVector(page: Page): Promise<boolean> {
  return (await bundledCollection(page, GSI_VECTOR)) !== undefined;
}

/** 地理院の描画の層のうち、タイルの層 `sourceLayer` を描くものの visibility (重複なし)。 */
function gsiVisibility(page: Page, sourceLayer: string): Promise<string[]> {
  return page.evaluate(
    ({ prefix, sourceLayer }) => {
      const map = (window as unknown as TestWindow).__map!;
      const values = map
        .getStyle()
        .layers.filter(
          (layer) =>
            layer.id.startsWith(prefix) && 'source-layer' in layer && layer['source-layer'] === sourceLayer,
        )
        .map((layer) => (layer.layout as { visibility?: string } | undefined)?.visibility ?? 'visible');
      return [...new Set(values)];
    },
    { prefix: `${GSI_VECTOR}/`, sourceLayer },
  );
}

/**
 * **地理院のベクトルタイルは、テーマごとの行で出る。** カタログの「国土地理院」の下に
 * 9行 (注記・道路…)。入れるまでは**何も読まない**。入れると配布元のPMTiles (データ) だけを
 * 直接読み、カタログの形の種類から自前で描いて、うちのデータの下に敷く。
 */
test('地理院のベクトルタイルをテーマごとに重ねられる', async ({ page }) => {
  test.skip(!(await hasGsiVector(page)), '地理院のベクトルタイルがカタログに無い');
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('optimal_bvmap')) asked.push(request.url());
  });

  // テーマはカタログのダイアログの地図タイルに、出所 (国土地理院) の見出しの下で並ぶ。
  await page.locator('.layer-add-button[data-section="tile"]').click();
  await expect(page.locator('#layer-catalog-dialog .catalog-group[data-group="duck-geocoder-gsi"]')).toBeVisible();
  await expect(page.locator(`[data-catalog-layer^="${GSI_VECTOR}--"]`)).toHaveCount(9);
  await closeCatalog(page);
  // 入れるまでは読まない。
  expect(asked).toEqual([]);

  await page.evaluate(() => {
    (window as unknown as TestWindow).__map!.jumpTo({ center: [139.7671, 35.6812], zoom: 15.5 });
  });
  await showLayer(page, gsiRow('building'));
  await expect.poll(() => gsiVisibility(page, 'BldA'), { timeout: DATA_TIMEOUT }).toEqual(['visible']);
  // ほかのテーマは出していない。
  expect(await gsiVisibility(page, 'RdCL')).toEqual(['none']);
  // 配布元の PMTiles から、建物のタイルが実際に読めて描かれる。
  await expect
    .poll(
      () =>
        page.evaluate(
          (source) =>
            (window as unknown as TestWindow).__map!.querySourceFeatures(source, { sourceLayer: 'BldA' })
              .length,
          GSI_VECTOR,
        ),
      { timeout: DATA_TIMEOUT },
    )
    .toBeGreaterThan(0);
  expect(asked.some((url) => url.includes('optimal_bvmap-v1.pmtiles'))).toBe(true);
  // **配布元の描き方 (スタイル・フォント・記号) は読まない。** データだけで描く。
  expect(asked.filter((url) => url.includes('gsi-cyberjapan.github.io'))).toEqual([]);

  // うちのデータより下に描く (いちばん下の人口メッシュより前に並ぶ)。
  const order = await page.evaluate((prefix) => {
    const ids = (window as unknown as TestWindow).__map!.getStyle().layers.map((l) => l.id);
    return {
      lastGsi: ids.findLastIndex((id) => id.startsWith(prefix)),
      mesh: ids.indexOf('population-mesh-fill'),
    };
  }, `${GSI_VECTOR}/`);
  expect(order.lastGsi).toBeGreaterThanOrEqual(0);
  expect(order.lastGsi).toBeLessThan(order.mesh);
});

/**
 * **ズームを変えても、入り切りは戻らない。** 地理院地図Vectorはズームで出る層が
 * 変わると絞り込みが戻ってしまい、使いにくかった。いまのズームで描かれない層も
 * 行は残し、「ズーム16から」と添える。
 */
test('地理院のベクトルタイルは、ズームを変えても層ごとの入り切りが戻らない', async ({ page }) => {
  test.skip(!(await hasGsiVector(page)), '地理院のベクトルタイルがカタログに無い');
  const jump = (zoom: number) =>
    page.evaluate((z) => {
      (window as unknown as TestWindow).__map!.jumpTo({ center: [139.7671, 35.6812], zoom: z });
    }, zoom);
  await jump(12);

  // 道路を入れ、開いて道路縁だけ外す。
  const road = page.locator(`[data-layer="${gsiRow('road')}"]`);
  await showLayer(page, gsiRow('road'));
  await road.locator('.layer-expander').click();
  const edge = road.locator('[data-part="RdEdg"]');
  await expect(edge).toContainText('ズーム16から');
  await edge.locator('input').uncheck();
  await expect(page.locator(`#layer-toggle-${gsiRow('road')}`)).toHaveJSProperty('indeterminate', true);

  // 建物はズーム14からなので、出しても今は描かれないと行が言う。
  await showLayer(page, gsiRow('building'));
  await expect(page.locator(`[data-layer-status="${gsiRow('building')}"]`)).toContainText(
    'ズーム14から',
  );

  for (const zoom of [17, 9, 15]) {
    await jump(zoom);
    await expect.poll(() => gsiVisibility(page, 'RdCL')).toEqual(['visible']);
    expect(await gsiVisibility(page, 'RdEdg')).toEqual(['none']);
    expect(await gsiVisibility(page, 'BldA')).toEqual(['visible']);
    // 一覧も同じ。開いたまま、道路縁は外れたまま。
    await expect(road.locator('[data-part="RdEdg"] input')).not.toBeChecked();
    await expect(road.locator('[data-part="RdCL"] input')).toBeChecked();
  }
  // ズーム15では建物も道路縁以外も描かれるので、「ズーム…から」は出ない。
  await expect(page.locator(`[data-layer-status="${gsiRow('building')}"]`)).not.toContainText('ズーム');
  await expect(road.locator('[data-part="RdEdg"]')).toContainText('ズーム16から');
});

/**
 * **カタログが長くなっても探せる。** 足せないもの (3D Tiles・配っていない元データ) は
 * 「見るだけ・元データ」のタブに分け、足せるものの間に混ぜない。出所が複数あれば目次から飛べる。
 */
test('足せないものは別のタブに分け、目次から出所へ飛べる', async ({ page }) => {
  await page.locator('.layer-add-button[data-section="tile"]').click();
  const dialog = page.locator('#layer-catalog-dialog');
  const tab = (section: string) => dialog.locator(`.catalog-tab[data-section="${section}"]`);
  const adds = dialog.locator('[data-catalog-layer] .catalog-add');

  // 足せるタブには「描けません」が無い。
  for (const section of ['data', 'tile']) {
    await tab(section).click();
    await expect(adds.filter({ hasText: '描けません' })).toHaveCount(0);
  }

  // 見るだけのタブは、どれも足せない (3D Tiles も元データもここ)。
  await tab('view').click();
  for (const id of ['reearth-buildings', 'jaxa-aw3d30', 'gsi-dem-source']) {
    await expect(dialog.locator(`[data-catalog-layer="${id}"] .catalog-add`)).toBeDisabled();
  }
  expect(await adds.count()).toBe(await adds.filter({ hasText: '描けません' }).count());

  // 目次は出所の見出しと同じ数だけあり、押すとその見出しへ飛ぶ。
  const groups = dialog.locator('.catalog-group');
  const chips = dialog.locator('#catalog-index .catalog-index-chip:not(.sub)');
  await expect(chips).toHaveCount(await groups.count());
  await chips.last().click();
  await expect(groups.last()).toBeInViewport();
});

/**
 * **カタログを語で絞り込める。** 出所の並びは崩さず、同じ種類のものを横断して探す。
 * 中の層にだけ当たったときは、当たった層を言い、**足すとその層だけを出す**。
 */
test('カタログを語で絞り込める (出所をまたいで、中の層にも当たる)', async ({ page }) => {
  await page.locator('.layer-add-button[data-section="tile"]').click();
  const dialog = page.locator('#layer-catalog-dialog');
  const filter = page.locator('#layer-filter');
  const tab = (section: string) => dialog.locator(`.catalog-tab[data-section="${section}"]`);
  const rows = dialog.locator('[data-catalog-layer]');
  const ids = () => rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.catalogLayer));
  const all = await rows.count();

  await filter.fill('送電');
  // 区分のタブに、当たった件数が出る。データの送電線と、地理院の送電線。
  await expect(tab('data')).toContainText('(1)');
  if (await hasGsiVector(page)) {
    expect(await ids()).toEqual([gsiRow('power')]);
    expect(await rows.count()).toBeLessThan(all);
  }
  await tab('data').click();
  expect(await ids()).toEqual([LAYER.powerLines]);
  // 見出しは当たった行の出所だけ。
  await expect(dialog.locator('[data-group="duck-geocoder-plateau"]')).toHaveCount(0);

  if (await hasGsiVector(page)) {
    // 「等高」は地形の中の「等高線」にだけ当たる。足すと等高線だけが出る。
    await tab('tile').click();
    await filter.fill('等高');
    await expect(rows).toHaveCount(1);
    const terrain = dialog.locator(`[data-catalog-layer="${gsiRow('terrain')}"]`);
    await expect(terrain).toContainText('当たった層: 等高線');
    await terrain.locator('.catalog-add').click();
    await expect(terrain.locator('.catalog-add')).toHaveText('追加済み');
  }

  await filter.fill('当てはまらない語');
  await expect(rows).toHaveCount(0);
  await expect(page.locator('#layer-filter-empty')).toBeVisible();

  // Esc は、まず語を消す (ダイアログは閉じない)。
  await filter.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#layer-filter-empty')).toBeHidden();
  await closeCatalog(page);

  if (await hasGsiVector(page)) {
    const row = page.locator(`.layer-row[data-layer="${gsiRow('terrain')}"]`);
    await expect(page.locator(`#layer-toggle-${gsiRow('terrain')}`)).toHaveJSProperty('indeterminate', true);
    await row.locator('.layer-expander').click();
    await expect(row.locator('[data-part="Cntr"] input')).toBeChecked();
    await expect(row.locator('[data-part]:not([data-part="Cntr"]) input:checked')).toHaveCount(0);
  }
});

/**
 * **読み込み中に外したら、遅れて届いた結果を描かない。** 全部外したときの早期 return が
 * 世代を進めておらず、前の要求が「まだ最新」のまま終わって、外したあとに建物が
 * 描かれていた (起動直後に外すと再現した)。読み込みを止めておいて外し、放してから見る。
 */
test('読み込み中に建物を外しても、遅れて届いた結果は描かない', async ({ page }) => {
  test.skip(!(await hasPlateau(page)), 'PLATEAUの建物データが無い');
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = 0;
  await page.route(/\/plateau_bldg_[^/]*\.parquet/, async (route) => {
    waiting += 1;
    await held;
    await route.continue();
  });

  await page.evaluate(() => {
    (window as unknown as TestWindow).__map!.jumpTo({ center: [139.7671, 35.6812], zoom: 15.5 });
  });
  // 建物の読み込みが始まった (止めてある) ところで外す。
  await expect.poll(() => waiting).toBeGreaterThan(0);
  await hideLayer(page, LAYER.plateauBuildings);
  release();

  // 止めていた読み込みが終わるのを待ってから見る。
  await expect(page.locator('#busy')).toBeHidden({ timeout: DATA_TIMEOUT });
  await page.waitForTimeout(500);
  expect(await sourceFeatureCount(page, 'buildings')).toBe(0);
});
