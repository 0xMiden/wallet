import { expect, test, type Page, type TestInfo } from '@playwright/test';

const capture = process.env.TOKEN_DETAIL_CAPTURE === 'before' ? 'before' : 'after';
const pageErrors = new WeakMap<Page, Error[]>();

function contextFrom(testInfo: TestInfo) {
  const project = testInfo.project.name;
  const dark = project.endsWith('dark');
  const viewportKind = project.startsWith('mobile') ? 'mobile' : 'extension';
  const query = [dark && 'dark', viewportKind === 'mobile' && 'mobile', viewportKind === 'extension' && 'sidePanel']
    .filter(Boolean)
    .join('&');
  return { dark, viewportKind, query };
}

function screenshotPath(testInfo: TestInfo, suffix: string) {
  const { dark, viewportKind } = contextFrom(testInfo);
  return testInfo.outputPath(`token-detail-${viewportKind}-${dark ? 'dark' : 'light'}-${capture}-${suffix}.png`);
}

async function captureViewport(page: Page, path: string) {
  await page.screenshot({ path, animations: 'disabled', caret: 'hide', scale: 'css' });
}

test.beforeEach(({ page }, testInfo) => {
  pageErrors.set(page, []);
  page.on('pageerror', error => {
    pageErrors.get(page)?.push(error);
    console.error(`[TokenDetail ${testInfo.project.name}] ${error.name}: ${error.message}`);
  });
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)?.map(error => error.message) ?? []).toEqual([]);
});

if (capture === 'before') {
  test('captures the current-main TokenDetail baseline', async ({ page }, testInfo) => {
    const { query } = contextFrom(testInfo);
    await page.goto(`/?state=fresh&${query}`);
    await expect(page.getByTestId('token-detail-hero')).toBeVisible();
    await expect(page.getByTestId('token-detail-send')).toBeVisible();
    await expect(page.getByTestId('token-detail-receive')).toBeVisible();
    expect(page.viewportSize()?.height).toBeLessThanOrEqual(1800);
    await captureViewport(page, screenshotPath(testInfo, 'hero'));

    const activity = page.getByTestId('token-detail-activity');
    await activity.scrollIntoViewIfNeeded();
    await expect(activity.getByRole('heading', { level: 2 })).toBeVisible();
    await captureViewport(page, screenshotPath(testInfo, 'history'));
  });
} else {
  test('shows Available separately from matching pending activity and identifies a fresh quote', async ({
    page
  }, testInfo) => {
    const { query } = contextFrom(testInfo);
    await page.goto(`/?state=fresh&${query}`);

    const hero = page.getByTestId('token-detail-hero');
    await expect(hero.getByText('Available', { exact: true })).toBeVisible();
    await expect(hero.getByText('2.50', { exact: true })).toBeVisible();
    await expect(hero.getByText('$10.00', { exact: true })).toBeVisible();
    await expect(page.getByTestId('token-detail-quote-context')).toContainText('ETH');
    await expect(page.getByTestId('token-detail-quote-context')).toContainText('Binance');
    await expect(page.getByTestId('token-detail-quote-context')).toContainText('retrieved');
    await expect(page.getByTestId('token-detail-price')).toBeVisible();
    await expect(page.getByTestId('token-detail-send')).toBeVisible();
    await expect(page.getByTestId('token-detail-receive')).toBeVisible();
    await expect(page.getByTestId('token-history-fixture')).toHaveAttribute('data-pending-count', '1');
    await expect(page.getByTestId('pending-activity-row')).toContainText('+0.25');
    expect(page.viewportSize()?.width).toBe(testInfo.project.use.viewport?.width);
    expect(page.viewportSize()?.height).toBeLessThanOrEqual(1800);
    await captureViewport(page, screenshotPath(testInfo, 'hero'));

    const activity = page.getByTestId('token-detail-activity');
    await activity.scrollIntoViewIfNeeded();
    await expect(activity.getByRole('heading', { level: 2 })).toBeVisible();
    await expect(page.getByTestId('pending-activity-row')).toBeVisible();
    await captureViewport(page, screenshotPath(testInfo, 'history'));
    const pendingCard = page.locator('[data-pending-status="pending"]');
    await pendingCard.getByRole('button').click();
    await expect(pendingCard.getByTestId('pending-activity-hint')).toContainText('Not yet accepted');
    await captureViewport(page, screenshotPath(testInfo, 'pending'));
  });

  test('shows placeholders while balance, price and History are loading', async ({ page }, testInfo) => {
    const { query } = contextFrom(testInfo);
    await page.goto(`/?state=loading&${query}`);

    const hero = page.getByTestId('token-detail-hero');
    await expect(hero.getByText('Available', { exact: true })).toBeVisible();
    await expect(hero.getByText('\u2014', { exact: true })).toHaveCount(2);
    await expect(hero.getByText('$10.00', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('token-detail-quote-context')).toHaveCount(0);
    await expect(page.getByTestId('token-history-loading')).toBeVisible();
  });

  test('keeps the available balance while its market quote is loading', async ({ page }, testInfo) => {
    const { query } = contextFrom(testInfo);
    await page.goto(`/?state=loading-quote&${query}`);

    const hero = page.getByTestId('token-detail-hero');
    await expect(hero.getByText('2.50', { exact: true })).toBeVisible();
    await expect(hero.getByText('\u2014', { exact: true })).toBeVisible();
    await expect(hero.getByText('$10.00', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('token-detail-quote-context')).toHaveCount(0);
    await expect(page.getByTestId('token-detail-price')).toHaveCount(0);
  });

  test('keeps stale market quotes out of the Available USD value and chart', async ({ page }, testInfo) => {
    const { query } = contextFrom(testInfo);
    await page.goto(`/?state=stale&${query}`);

    const hero = page.getByTestId('token-detail-hero');
    await expect(hero.getByText('2.50', { exact: true })).toBeVisible();
    await expect(hero.getByText('$10.00', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('token-detail-quote-context')).toContainText('Price is stale');
    await expect(page.getByTestId('token-detail-quote-context')).toContainText('Binance');
    await expect(page.getByTestId('token-detail-price')).toHaveCount(0);
  });

  test('reports an unavailable quote without inventing a fiat value', async ({ page }, testInfo) => {
    const { query } = contextFrom(testInfo);
    await page.goto(`/?state=unavailable&${query}`);

    const hero = page.getByTestId('token-detail-hero');
    await expect(hero.getByText('Available', { exact: true })).toBeVisible();
    await expect(hero.getByText('2.50', { exact: true })).toBeVisible();
    await expect(hero.getByText('$10.00', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('token-detail-quote-context')).toContainText('Price unavailable');
    await expect(page.getByTestId('token-detail-quote-context')).toContainText('verified source');
    await expect(page.getByTestId('token-detail-price')).toHaveCount(0);
  });

  test('rejects a quote with no market-provider provenance', async ({ page }, testInfo) => {
    const { query } = contextFrom(testInfo);
    await page.goto(`/?state=unavailable-source&${query}`);

    const hero = page.getByTestId('token-detail-hero');
    await expect(hero.getByText('2.50', { exact: true })).toBeVisible();
    await expect(hero.getByText('$10.00', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('token-detail-quote-context')).toContainText('Price unavailable');
    await expect(page.getByTestId('token-detail-price')).toHaveCount(0);
  });
}
