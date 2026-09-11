import { test, expect, type Page } from '@playwright/test';
import type { MapLibreMap, GeoJSONSource } from 'maplibre-gl';

/** main.ts がテスト用に公開しているもの。 */
type TestWindow = { __map?: MapLibreMap; __dataUrl?: (file: string) => string };

/** 行政区域データセット。逆ジオコーディングと転送量の計測がこれを見る。 */
const ADMIN_DATASET = 'overture_admin_jp.parquet';
/** 建物データセット。無くても他の機能は動くので、無ければスキップする。 */
const BUILDINGS_DATASET = 'overture_buildings_minato.parquet';
/** PLATEAUの建物。高さ・用途を持つので、絞り込みはこちらでしか出ない。 */
const PLATEAU_DATASET = 'plateau_bldg_minato.parquet';

/** 建物データが配信されているか。 */
async function hasBuildings(page: Page): Promise<boolean> {
  const url = await datasetUrl(page, BUILDINGS_DATASET);
  return page.request.head(url).then((response) => response.ok());
}

async function hasPlateau(page: Page): Promise<boolean> {
  const url = await datasetUrl(page, PLATEAU_DATASET);
  return page.request.head(url).then((response) => response.ok());
}

/** PLATEAUの建物が見える状態にする。PLATEAUは既定の出所なので選び直さない。 */
async function showPlateauBuildings(page: Page) {
  await page.evaluate(() => {
    const map = (window as unknown as TestWindow).__map!;
    map.jumpTo({ center: [139.7454, 35.6586], zoom: 16 });
  });
  await expect.poll(() => sourceFeatureCount(page, 'buildings')).toBeGreaterThan(0);
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

// 建物は一部の範囲しか収録しておらず、しかも寄らないと出てこない。
// 偶然そこへ行かないと機能に気づけないので、移動する手段を用意してある。
// 移動先はカタログの収録範囲から決まるため、データを差し替えても追随する。
test('ボタンを押すと建物のある範囲へ移動する', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データ (Overture) が無い');

  expect(await sourceFeatureCount(page, 'buildings')).toBe(0);

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
test('建物を読み込んでいる間は「拡大すると建物が出ます」と言わない', async ({ page }) => {
  test.skip(!(await hasBuildings(page)), '建物データ (Overture) が無い');

  const zoomedOutMessage = '拡大すると建物が出ます';
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

  await expect(page.locator('#buildings-panel')).toBeVisible();
  // 属性の揃っているPLATEAUが既定。
  await expect(page.locator('#building-source')).toHaveValue(/plateau/);
  await expect(page.locator('#building-filters')).toBeVisible();
  await expect(page.locator('#height-field')).toBeVisible();

  // 用途の選択肢はコードに書かず、配信しているデータから引いている。
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

test('クリアするとハイライトが消える', async ({ page }) => {
  await page.locator('#search-input').fill('港区');
  await page.locator('#results li', { hasText: '行政区域' }).first().click();
  await expect.poll(() => highlightFeatureCount(page)).toBe(1);

  await page.locator('#clear-button').click();

  await expect.poll(() => highlightFeatureCount(page)).toBe(0);
  await expect(page.locator('#search-input')).toHaveValue('');
});
