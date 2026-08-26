import { test, expect, type Page } from '@playwright/test';
import type { MapLibreMap, GeoJSONSource } from 'maplibre-gl';

/** main.ts がテスト用に公開しているもの。 */
type TestWindow = { __map?: MapLibreMap; __dataUrl?: (file: string) => string };

/** 行政区域データセット。逆ジオコーディングと転送量の計測がこれを見る。 */
const ADMIN_DATASET = 'overture_admin_jp.parquet';
/** 建物データセット。無くても他の機能は動くので、無ければスキップする。 */
const BUILDINGS_DATASET = 'overture_buildings_minato.parquet';

/** 建物データが配信されているか。 */
async function hasBuildings(page: Page): Promise<boolean> {
  const url = await datasetUrl(page, BUILDINGS_DATASET);
  return page.request.head(url).then((response) => response.ok());
}

/**
 * データセットの実際のURLをアプリに解決させる。
 *
 * データは開発時と公開時で置き場所が変わる (同一オリジンの /data/ か、
 * オブジェクトストレージか)。テストにURLを書くと公開URLに対して流せなくなるので、
 * アプリが使っているのと同じ組み立てを借りる。
 */
function datasetUrl(page: Page, file: string): Promise<string> {
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
  const response = await page.request.head(url);
  test.skip(!response.ok(), `${url} が読めない (READMEの手順で用意してください)`);
}

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
test('使い方に3種類の操作が書かれている', async ({ page }) => {
  const help = page.locator('#help');
  await expect(help).toBeVisible();
  await expect(help).toContainText('検索');
  await expect(help).toContainText('クリック');
  await expect(help).toContainText('カーソルを合わせる');
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

test('地図をクリックすると逆ジオコーディングされる', async ({ page }) => {
  // 東京駅付近へ移動してから中央をクリックする。
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7671, 35.6812], zoom: 13 });
  });

  const canvas = page.locator('#map canvas');
  await canvas.click({ position: { x: 400, y: 300 } });

  const popup = page.locator('.maplibregl-popup-content');
  await expect(popup).toBeVisible();
  // 「判定中…」から確定した地名に変わることを確認する。
  await expect(popup).toContainText('東京都', { timeout: 30_000 });

  // 逆ジオコーディングの結果は検索欄にも反映される。
  await expect(page.locator('#search-input')).toHaveValue(/東京都/);
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
  const dataset = await datasetUrl(page, ADMIN_DATASET);
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
  await page.locator('#map canvas').click({ position: { x: 400, y: 300 } });
  await expect(page.locator('.maplibregl-popup-content')).toContainText('東京都', {
    timeout: 30_000,
  });

  const measured = `${(fetchedBytes / 1024 / 1024).toFixed(1)} MB / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`;
  console.log(`逆ジオコーディングの転送量: ${measured}`);

  // 0バイトなら「絞り込めている」のではなく「計測できていない」ので、そちらも弾く。
  expect(fetchedBytes, `転送量を計測できていない: ${measured}`).toBeGreaterThan(0);
  expect(fetchedBytes, `読みすぎ: ${measured}`).toBeLessThan(totalBytes * 0.1);
});

// 建物は一部の範囲しか収録しておらず、しかも寄らないと出てこない。
// 偶然そこへ行かないと機能に気づけないので、移動する手段を用意してある。
// 移動先はカタログの収録範囲から決まるため、データを差し替えても追随する。
test('ボタンを押すと建物のある範囲へ移動する', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データ (Overture) が無い');

  expect(await sourceFeatureCount(page, 'buildings')).toBe(0);

  await page.locator('#goto-buildings').click();

  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);
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
        return map.queryRenderedFeatures(center, { layers: ['buildings-fill'] }).length;
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

test('クリアするとハイライトが消える', async ({ page }) => {
  await page.locator('#search-input').fill('港区');
  await page.locator('#results li', { hasText: '行政区域' }).first().click();
  await expect.poll(() => highlightFeatureCount(page)).toBe(1);

  await page.locator('#clear-button').click();

  await expect.poll(() => highlightFeatureCount(page)).toBe(0);
  await expect(page.locator('#search-input')).toHaveValue('');
});
