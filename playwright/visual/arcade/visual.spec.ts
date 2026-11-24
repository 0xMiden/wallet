import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark']) {
  test(`reviews one fixed GC package in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.route(/^https?:/, route => {
      const host = new URL(route.request().url()).hostname;
      return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
    });
    await page.goto(theme === 'dark' ? '/?dark' : '/');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await expect(dialog.getByTestId('arcade-gc-purchase-confirm')).toBeEnabled();
    await expect(dialog).toContainText(/1(?:\.[0-9]+)?\s*USDCx/i);
    await expect(dialog).toContainText(/1[,.\u00a0]?000(?:\.[0-9]+)?\s*GC/i);
    await expect(dialog).toContainText(/network fee/i);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: info.outputPath(`gc-package-${theme}.png`), animations: 'disabled' });
  });
}
