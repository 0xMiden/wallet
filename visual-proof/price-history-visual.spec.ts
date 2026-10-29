import { expect, test } from '../fixtures/extension';
import { completeSeedImportOnboarding } from '../e2e/helpers/dapp-confirm';

const faucet = 'mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec_qr7qqq9wr6w';

test('capture unavailable price history', async ({ extensionContext, extensionId }, info) => {
  test.setTimeout(300_000);
  const page = await extensionContext.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const url = `chrome-extension://${extensionId}/fullpage.html`;
  await completeSeedImportOnboarding(page, url);
  const sidebarUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  await page.goto(`${sidebarUrl}#/token-detail/${faucet}`, { waitUntil: 'domcontentloaded' });
  const section = page.getByTestId('token-detail-price');
  await expect(section).toBeVisible({ timeout: 30_000 });
  if (process.env.PRICE_VISUAL_REVISION === 'after') {
    await expect(page.getByTestId('token-detail-chart-unavailable')).toBeVisible();
    await expect(section.locator('.recharts-wrapper')).toHaveCount(0);
  } else {
    await expect(section.locator('.recharts-wrapper')).toBeVisible();
    await expect(page.getByTestId('token-detail-chart-unavailable')).toHaveCount(0);
  }
  if (process.env.PRICE_VISUAL_REVISION === 'before') await page.waitForTimeout(1500);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    await section.scrollIntoViewIfNeeded();
    await page.evaluate(async () => { await document.fonts.ready; });
    const path = info.outputPath(`${process.env.PRICE_VISUAL_REVISION}-${theme}.png`);
    await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
    await info.attach(`${process.env.PRICE_VISUAL_REVISION}-${theme}`, { path, contentType: 'image/png' });
  }
});
