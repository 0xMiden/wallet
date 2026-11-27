import { expect, test, type Page } from '@playwright/test';

// The area draws itself from JavaScript, which `animations: 'disabled'` does not stop: a capture
// taken at once shows an empty chart.
const chartDrawn = async (page: Page) => {
  await expect(page.locator('.recharts-area-area')).toBeVisible();
  await page.waitForTimeout(2000);
};

test.beforeEach(({ page }, testInfo) => {
  page.on('pageerror', error => {
    console.error(`[TokenDetail ${testInfo.project.name}] ${error.name}: ${error.message}`);
  });
});

test('captures the real token detail page in compact light and dark layouts', async ({ page, context }, testInfo) => {
  const project = testInfo.project.name;
  const dark = project.endsWith('dark');
  const viewportKind = project.startsWith('mobile') ? 'mobile' : 'extension';
  const capture = process.env.TOKEN_DETAIL_CAPTURE === 'before' ? 'before' : 'after';
  const query = [
    'long',
    dark && 'dark',
    viewportKind === 'mobile' && 'mobile',
    viewportKind === 'extension' && 'sidePanel'
  ]
    .filter(Boolean)
    .join('&');
  await page.goto(`/?${query}`);

  await expect(page.getByText('IETH', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('token-detail-name')).toHaveCount(capture === 'before' ? 0 : 1);
  if (capture === 'before') {
    await page.screenshot({
      path: testInfo.outputPath(`token-detail-${viewportKind}-${dark ? 'dark' : 'light'}-before-top.png`),
      animations: 'disabled',
      caret: 'hide'
    });
    const info = page.getByTestId('token-detail-info');
    await info.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`token-detail-${viewportKind}-${dark ? 'dark' : 'light'}-before-details.png`),
      animations: 'disabled',
      caret: 'hide'
    });
    return;
  }

  const viewportHeight = page.viewportSize()?.height ?? 0;
  expect(viewportHeight).toBe(testInfo.project.use.viewport?.height);
  await expect(page.getByTestId('token-detail-hero')).toBeVisible();
  await expect(page.getByTestId('token-detail-price')).toBeVisible();
  await expect(page.getByTestId('token-detail-send')).toBeVisible();
  await expect(page.getByTestId('token-detail-receive')).toBeVisible();
  await expect(page.getByTestId('token-detail-name')).toContainText('Synthetic Testnet Asset with a Long Display Name');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const frame = page.locator('#root > div');
  expect(await frame.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(viewportHeight);
  const scrollport = page.locator('#root > div > div.overflow-y-auto');
  await expect(scrollport).toBeVisible();
  const scrollSize = await scrollport.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(scrollSize.scrollHeight).toBeGreaterThan(scrollSize.clientHeight);

  const send = page.getByTestId('token-detail-send');
  const sendBox = await send.boundingBox();
  expect(sendBox?.height).toBeGreaterThanOrEqual(44);
  await chartDrawn(page);
  await page.screenshot({
    path: testInfo.outputPath(`token-detail-${viewportKind}-${dark ? 'dark' : 'light'}-after-top.png`),
    animations: 'disabled',
    caret: 'hide'
  });

  const info = page.getByTestId('token-detail-info');
  await info.scrollIntoViewIfNeeded();
  const inspect = page.getByTestId('token-detail-contract-toggle');
  await inspect.focus();
  await page.keyboard.press('Enter');
  await expect(inspect).toHaveAttribute('aria-expanded', 'true');
  const fullId = page.getByTestId('token-detail-full-faucet-id');
  await expect(fullId).toBeVisible();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('token-detail-copy-contract').click();
  await expect(page.getByTestId('token-detail-copy-contract')).toHaveAttribute('data-copied', 'true');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await fullId.textContent());
  await expect(page.getByTestId('token-detail-copy-contract')).toBeVisible();
  await expect(page.getByTestId('token-detail-explorer')).toBeVisible();
  await expect(page.getByTestId('token-detail-edit')).toBeVisible();
  await expect(page.getByTestId('token-detail-hide-toggle')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`token-detail-${viewportKind}-${dark ? 'dark' : 'light'}-after-details.png`),
    animations: 'disabled',
    caret: 'hide'
  });

  await send.click();
  await expect(page).toHaveURL(/#\/send\?tokenId=/);
  await page.evaluate(() => {
    window.location.hash = '';
  });
  await page.getByTestId('token-detail-receive').click();
  await expect(page).toHaveURL(/#\/receive$/);
  await page.evaluate(() => {
    window.location.hash = '';
  });

  const timeframe = page.getByTestId('token-detail-timeframe-1D');
  await timeframe.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('token-detail-timeframe-1W')).toHaveAttribute('aria-checked', 'true');

  await info.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('token-detail-copy-contract')).toBeVisible();
  await expect(page.getByTestId('token-detail-explorer')).toBeVisible();
  await expect(page.getByTestId('token-detail-edit')).toBeVisible();
  await expect(page.getByTestId('token-detail-hide-toggle')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const activity = page.getByTestId('token-detail-activity');
  await activity.scrollIntoViewIfNeeded();
  await expect(activity).toBeVisible();
  await expect(activity.getByRole('heading', { level: 2 })).toBeVisible();
  await expect(activity.getByTestId('activity-row')).toHaveCount(5);
  await expect(activity).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath(`token-detail-${viewportKind}-${dark ? 'dark' : 'light'}-after-history.png`),
    animations: 'disabled',
    caret: 'hide'
  });
  await info.scrollIntoViewIfNeeded();

  await page.getByTestId('token-detail-hide-toggle').click();
  await expect(page.getByTestId('token-detail-hidden-notice')).toBeVisible();
  await page.getByTestId('token-detail-edit').click();
  await expect(page.getByRole('dialog', { name: 'Token details' })).toBeVisible();
});

test('retains honest identity when metadata and native-faucet discovery are unavailable', async ({
  page
}, testInfo) => {
  const query = ['missing', 'unverified', 'nativeUnknown', 'sidePanel'];
  if (testInfo.project.name.endsWith('dark')) query.push('dark');
  if (testInfo.project.name.startsWith('mobile')) query.push('mobile');
  await page.goto(`/?${query.join('&')}`);

  await expect(page.getByText('Unknown', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('token-detail-unverified-pill')).toBeVisible();
  await expect(page.getByTestId('token-detail-name')).toHaveCount(0);
  await expect(page.getByTestId('token-detail-edit')).toHaveCount(0);
  await expect(page.getByTestId('token-detail-send')).toBeVisible();
  await expect(page.getByTestId('token-detail-receive')).toBeVisible();
});

test('shows pending claim lines beside the available balance and the reconciling states', async ({
  page
}, testInfo) => {
  test.skip(process.env.TOKEN_DETAIL_CAPTURE === 'before', 'the baseline has no pending lines');
  const project = testInfo.project.name;
  const mode = project.endsWith('dark') ? 'dark' : 'light';
  const stateCopy = { updating: 'Updating balance', unavailable: 'Could not load balance.' };
  for (const state of ['updating', 'unavailable'] as const) {
    const query = ['pending', state, 'sidePanel'];
    if (mode === 'dark') query.push('dark');
    if (project.startsWith('mobile')) query.push('mobile');
    await page.goto(`/?${query.join('&')}`);

    const hero = page.getByTestId('token-detail-hero');
    await expect(hero).toContainText('Available');
    await expect(page.getByTestId('token-detail-pending-claim')).toContainText('2.00 IETH to claim');
    await expect(page.getByTestId('token-detail-pending-claiming')).toContainText('0.25 IETH claiming');
    await expect(page.getByTestId('token-detail-balance-state')).toHaveText(stateCopy[state]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await chartDrawn(page);
    await page.screenshot({
      path: testInfo.outputPath(`token-detail-${project}-${state}-pending.png`),
      animations: 'disabled',
      caret: 'hide'
    });
  }
});

test('lists five rows with this token claim cards only, and links to all activity', async ({ page }, testInfo) => {
  test.skip(process.env.TOKEN_DETAIL_CAPTURE === 'before', 'the baseline lists the whole history');
  const project = testInfo.project.name;
  const query = ['pending', 'sidePanel'];
  if (project.endsWith('dark')) query.push('dark');
  if (project.startsWith('mobile')) query.push('mobile');
  await page.goto(`/?${query.join('&')}`);

  const activity = page.getByTestId('token-detail-activity');
  const cards = activity.locator('[data-pending-note-id]');
  await expect(cards).toHaveCount(3);
  expect(await cards.evaluateAll(els => els.map(el => el.getAttribute('data-pending-note-id')))).toEqual([
    'n1',
    'n2',
    'n3'
  ]);
  // Seven settled rows and three cards of this token: five are listed.
  await expect(activity.getByTestId('activity-row')).toHaveCount(2);
  await expect(activity).not.toContainText('OTHER');
  const seeAll = page.getByTestId('token-detail-see-all');
  await expect(seeAll).toHaveText('See all');
  expect((await seeAll.boundingBox())?.height).toBeGreaterThanOrEqual(44);

  // Tall enough that the whole section is on screen at once.
  const width = page.viewportSize()!.width;
  await page.setViewportSize({ width, height: 1800 });
  await activity.screenshot({
    path: testInfo.outputPath(`token-detail-${project}-activity.png`),
    animations: 'disabled',
    caret: 'hide'
  });
  await seeAll.click();
  await expect(page).toHaveURL(/#\/history$/);
});

test('shows stale price and failed-refresh warnings cleanly in compact viewports', async ({ page }, testInfo) => {
  test.skip(process.env.TOKEN_DETAIL_CAPTURE === 'before', 'slice 2 adds stale quote and refresh warnings');
  const project = testInfo.project.name;
  const query = ['stalePrice', 'refreshFailed', 'sidePanel'];
  if (project.endsWith('dark')) query.push('dark');
  if (project.startsWith('mobile')) query.push('mobile');
  await page.goto(`/?${query.join('&')}`);

  await expect(page.getByTestId('token-detail-hero')).toContainText('987654321.12');
  await expect(page.getByTestId('token-detail-balance-state')).toHaveText(
    'Could not refresh balance. Showing last confirmed balance.'
  );
  await expect(page.getByTestId('token-detail-quote-context')).toContainText('USD price is out of date');
  await expect(page.getByTestId('token-detail-price')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('shows mainnet profit and loss as a gain, a loss and an honest unknown', async ({ page }, testInfo) => {
  test.skip(process.env.TOKEN_DETAIL_CAPTURE === 'before', 'the baseline has no profit and loss');
  const project = testInfo.project.name;
  const expected = { gain: '+$586.42 (+23.45%)', loss: '-$513.58 (-14.26%)', incomplete: 'Not known' };
  for (const state of ['gain', 'loss', 'incomplete'] as const) {
    const query = [`pnl=${state}`, 'sidePanel'];
    if (project.endsWith('dark')) query.push('dark');
    if (project.startsWith('mobile')) query.push('mobile');
    await page.goto(`/?${query.join('&')}`);

    const section = page.getByTestId('token-detail-position');
    await section.scrollIntoViewIfNeeded();
    await expect(section).toContainText('Profit and loss');
    await expect(section).toContainText(expected[state]);
    if (state === 'incomplete')
      await expect(section).toContainText('Profit and loss shows once that part has been spent.');
    await expect(page.getByTestId('token-detail-pnl-since')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`token-detail-${project}-pnl-${state}.png`),
      animations: 'disabled',
      caret: 'hide'
    });
  }
});
