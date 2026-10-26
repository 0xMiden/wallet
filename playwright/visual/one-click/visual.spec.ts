import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

const browserErrorsByPage = new WeakMap<Page, string[]>();

function relativeLuminance(color: string): number {
  const channels = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!channels) throw new Error(`Unexpected computed color: ${color}`);
  const [red, green, blue] = channels.slice(1);
  if (red === undefined || green === undefined || blue === undefined) {
    throw new Error(`Unexpected computed color channels: ${color}`);
  }
  const linear = [red, green, blue].map(channel => {
    const value = Number(channel) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [linearRed, linearGreen, linearBlue] = linear;
  if (linearRed === undefined || linearGreen === undefined || linearBlue === undefined) {
    throw new Error(`Unexpected computed color channels: ${color}`);
  }
  return 0.2126 * linearRed + 0.7152 * linearGreen + 0.0722 * linearBlue;
}

function contrastRatio(foreground: string, background: string): number {
  const luminances = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  const lighter = luminances[0];
  const darker = luminances[1];
  if (lighter === undefined || darker === undefined) throw new Error('Expected two computed colors');
  return (lighter + 0.05) / (darker + 0.05);
}

test.beforeEach(({ page }) => {
  const browserErrors: string[] = [];
  browserErrorsByPage.set(page, browserErrors);
  page.on('pageerror', error => browserErrors.push(error.stack ?? error.message));
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

test('captures the production one-click amount step', async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith('dark') ? '?dark' : '';
  await page.goto(`/${theme}`);
  await expect(page.getByTestId('one-click-pay-amount')).toBeVisible();
  await expect(page.getByTestId('one-click-contact-Savings')).toBeVisible();
  await expect(page.getByTestId('one-click-contact-Other chain')).toHaveCount(0);
  const available = page.getByText('Available: 25 USDCX', { exact: true });
  const colors = await available.evaluate(element => ({
    foreground: getComputedStyle(element).color,
    background: getComputedStyle(document.body).backgroundColor
  }));
  expect(contrastRatio(colors.foreground, colors.background), 'Available balance text contrast').toBeGreaterThanOrEqual(
    4.5
  );
  await page.screenshot({ path: testInfo.outputPath('one-click-amounts.png') });
});

test('captures the exact outbound review before confirmation', async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith('dark') ? '&dark' : '';
  await page.goto(`/?review${theme}`);
  await expect(page.getByTestId('one-click-review-hero')).toBeVisible();
  await expect(page.getByTestId('one-click-minimum-row')).toContainText('12.3');
  await expect(page.getByTestId('one-click-confirm')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('one-click-review.png') });
});

test('captures inbound amounts before connecting an external pay wallet', async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith('dark') ? '&dark' : '';
  await page.goto(`/?inbound${theme}`);
  await expect(page.getByTestId('one-click-pay-amount')).toBeVisible();
  await expect(page.getByTestId('one-click-connect-origin-wallet')).toBeVisible();
  await expect(page.getByTestId('one-click-refund-address')).toHaveCount(0);
  await expect(page.getByTestId('one-click-recipient-address')).toHaveCount(0);
  await expect(page.getByText('Available: 25 USDC', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('one-click-review-submit')).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('one-click-inbound-disconnected.png') });
});

test('captures inbound amounts after the external pay wallet connects', async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith('dark') ? '&dark' : '';
  await page.goto(`/?inbound&connected${theme}`);
  await expect(page.getByTestId('one-click-connected-refund')).toContainText(
    '0x3333333333333333333333333333333333333333'
  );
  await expect(page.getByTestId('one-click-connect-origin-wallet')).toHaveCount(0);
  await expect(page.getByTestId('one-click-refund-address')).toHaveCount(0);
  await expect(page.getByText('Available: 25 USDC', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('one-click-evm-balance')).toContainText('25 USDC');
  await expect(page.getByTestId('one-click-review-submit')).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('one-click-inbound-connected.png') });
});

test('captures exact inbound review to the connected Miden account', async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith('dark') ? '&dark' : '';
  await page.goto(`/?review&inbound${theme}`);
  await expect(page.getByTestId('one-click-review-hero')).toContainText('Ethereum');
  await expect(page.getByTestId('one-click-review-hero')).toContainText('Miden');
  await expect(page.getByTestId('one-click-minimum-row')).toContainText('12.3 USDCX');
  await expect(page.getByTestId('one-click-confirm')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('one-click-inbound-review.png') });
});

for (const surface of ['modal', 'asset'] as const) {
  for (const variant of ['main', 'partial'] as const) {
    test(`captures production transaction ${surface} with ${variant} note details`, async ({ page }, testInfo) => {
      const query = new URLSearchParams({ tx: surface });
      if (variant === 'partial') query.set('partial', '');
      if (testInfo.project.name.endsWith('dark')) query.set('dark', '');
      await page.goto(`/?${query}`);
      const flow = page.getByTestId('tx-note-flow');
      await expect(flow).toBeVisible();
      await expect(page.getByTestId('tx-note-account')).toBeVisible();
      await expect(page.getByTestId('tx-note-inputs')).toBeVisible();
      await expect(page.getByTestId('tx-note-outputs')).toBeVisible();
      if (variant === 'main') {
        await expect(page.getByText('No input notes')).toBeVisible();
        await expect(page.getByTestId('tx-note-outputs').getByTestId('tx-note-item')).toHaveCount(3);
        await expect(page.getByTestId('tx-note-outputs')).toContainText('P2ID');
        await expect(page.getByTestId('tx-note-outputs')).toContainText('PSWAP');
      } else {
        await expect(page.getByTestId('tx-note-inputs').getByTestId('tx-note-item')).toHaveCount(1);
        await expect(flow).toContainText('account-state');
        await expect(flow).toContainText('orders');
      }
      if (surface === 'modal') await expect(page.getByTestId('dapp-confirmation-approve')).toBeVisible();
      else await expect(page.getByTestId('tx-asset-view')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

      const scroller = surface === 'modal' ? page.locator('[role="dialog"] .overflow-y-auto') : page.getByTestId('tx-asset-scroll');
      const capture = async (position: string) => {
        const path = testInfo.outputPath(`transaction-${surface}-${variant}-${position}.png`);
        await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
        const resized = await sharp(path).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).toBuffer();
        await sharp(resized).toFile(path);
        await testInfo.attach(`transaction-${surface}-${variant}-${position}`, { path, contentType: 'image/png' });
      };
      await capture('top');
      await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await capture('bottom');
    });
  }
}
