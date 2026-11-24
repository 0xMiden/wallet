import { expect, test, type Page, type TestInfo } from '@playwright/test';
import sharp from 'sharp';

const browserErrorsByPage = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const browserErrors: string[] = [];
  browserErrorsByPage.set(page, browserErrors);
  page.on('pageerror', error => browserErrors.push(error.stack || error.message || String(error)));
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() >= 400 && url.origin === 'http://127.0.0.1:5190') {
      browserErrors.push(`Fixture HTTP ${response.status()}: ${url.pathname}`);
    }
  });
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const browserErrors = browserErrorsByPage.get(page) ?? [];
  if (browserErrors.length > 0) {
    await testInfo.attach('browser-errors', {
      body: browserErrors.join('\n\n'),
      contentType: 'text/plain'
    });
  }
  expect(browserErrors, 'Browser errors while rendering the production fixture').toEqual([]);
});

type TransactionSurface = 'modal' | 'asset';
type TransactionVariant = 'main' | 'partial';

async function openTransaction(page: Page, testInfo: TestInfo, surface: TransactionSurface, variant: TransactionVariant) {
  const query = new URLSearchParams({ tx: surface });
  if (variant === 'partial') query.set('partial', '');
  if (testInfo.project.name.endsWith('dark')) query.set('dark', '');
  await page.goto(`/?${query}`);
  const flow = page.getByTestId('tx-note-flow');
  await expect(flow).toBeVisible();
  await expect(flow).toContainText('USDCX');
  await expect(page.getByTestId('tx-note-account')).toBeVisible();
  await expect(page.getByTestId('tx-note-inputs')).toBeVisible();
  await expect(page.getByTestId('tx-note-outputs')).toBeVisible();
  await expect(page.getByTestId(surface === 'modal' ? 'dapp-confirmation-approve' : 'tx-asset-view')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function captureTransaction(page: Page, testInfo: TestInfo, surface: TransactionSurface, variant: TransactionVariant, position: string) {
  const path = testInfo.outputPath(`transaction-${surface}-${variant}-${position}.png`);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  const resized = await sharp(path)
    .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .toBuffer();
  await sharp(resized).toFile(path);
  await testInfo.attach(`transaction-${surface}-${variant}-${position}`, { path, contentType: 'image/png' });
}

async function captureTopAndBottom(page: Page, testInfo: TestInfo, surface: TransactionSurface, variant: TransactionVariant) {
  const scroller =
    surface === 'modal' ? page.locator('[role="dialog"] .overflow-y-auto') : page.getByTestId('tx-asset-scroll');
  await captureTransaction(page, testInfo, surface, variant, 'top');
  await scroller.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await captureTransaction(page, testInfo, surface, variant, 'bottom');
}

for (const surface of ['modal', 'asset'] as const) {
  test(`captures production transaction ${surface} with zero inputs and three outputs`, async ({ page }, testInfo) => {
    await openTransaction(page, testInfo, surface, 'main');
    await expect(page.getByText('No input notes')).toBeVisible();
    await expect(page.getByTestId('tx-note-outputs').getByTestId('tx-note-item')).toHaveCount(3);
    await expect(page.getByTestId('tx-note-outputs')).toContainText('Transaction fee note');
    await expect(page.getByTestId('tx-note-outputs')).toContainText('P2ID');
    await expect(page.getByTestId('tx-note-outputs')).toContainText('PSWAP');
    await captureTopAndBottom(page, testInfo, surface, 'main');
  });

  test(`captures production transaction ${surface} with partial note details`, async ({ page }, testInfo) => {
    await openTransaction(page, testInfo, surface, 'partial');
    await expect(page.getByTestId('tx-note-inputs').getByTestId('tx-note-item')).toHaveCount(1);
    await expect(page.getByTestId('tx-note-flow')).toContainText('Other note script');
    await expect(page.getByTestId('tx-note-flow')).toContainText('account-state');
    await expect(page.getByTestId('tx-note-flow')).toContainText('orders');
    await captureTopAndBottom(page, testInfo, surface, 'partial');
  });
}

test('keeps raw request bytes behind the production disclosure', async ({ page }, testInfo) => {
  await openTransaction(page, testInfo, 'asset', 'main');
  const raw = page.getByTestId('advanced-details-toggle');
  await expect(raw).toHaveAttribute('aria-expanded', 'false');
  await raw.click();
  await expect(page.getByTestId('advanced-details-content')).toContainText('requestBytes');
  const scroller = page.getByTestId('tx-asset-scroll');
  await scroller.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await captureTransaction(page, testInfo, 'asset', 'main', 'raw');
});

for (const [kind, actionKey] of [
  ['epoch', 'depositERC20AndRegister'],
  ['existing', 'collateral already in The Compact'],
  ['slow', 'bridgeAsset'],
  ['executor', 'depositForBurnWithHookAndFees']
] as const) {
  test(`captures the Bread bridge review for ${kind}`, async ({ page }, testInfo) => {
    const theme = testInfo.project.name.endsWith('dark') ? '&dark' : '';
    await page.goto(`/?bridge=${kind}${theme}`);
    const guide = page.getByTestId('bridge-wallet-prompt-guide');
    await expect(guide).toBeVisible();
    await expect(guide).toContainText('abcdefghijklmnopabcdefghijklmnop');
    await expect(guide).toContainText(actionKey);
    await guide.scrollIntoViewIfNeeded();
    await guide.screenshot({ path: testInfo.outputPath(`bridge-in-${kind}-guide.png`) });
    await page.screenshot({ path: testInfo.outputPath(`bridge-in-${kind}-review.png`) });
  });
}
