import { expect, test, type Page } from '@playwright/test';

const browserErrorsByPage = new WeakMap<Page, string[]>();

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
