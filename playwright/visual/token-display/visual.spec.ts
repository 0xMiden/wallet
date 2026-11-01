import sharp from 'sharp';

import { expect, test } from '@playwright/test';

for (const width of [320, 360, 402]) {
  for (const dark of [false, true]) {
    test(`keeps token values and normalized USD amount legible at ${width}px, ${dark ? 'dark' : 'light'}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${dark ? '?dark' : ''}`);

      const row = page.getByTestId('token-value-row');
      const price = row.locator('[data-slot="price"]');
      const check = row.locator('[data-slot="trailing"] > *').nth(1);
      await expect(row).toBeVisible();
      await expect(price).toHaveText('Price unavailable');

      const [rowBounds, priceBounds, checkBounds] = await Promise.all([
        row.boundingBox(),
        price.boundingBox(),
        check.boundingBox()
      ]);
      expect(rowBounds).not.toBeNull();
      expect(priceBounds).not.toBeNull();
      expect(checkBounds).not.toBeNull();
      expect(priceBounds!.x + priceBounds!.width).toBeLessThan(checkBounds!.x);
      expect(checkBounds!.x + checkBounds!.width).toBeLessThanOrEqual(rowBounds!.x + rowBounds!.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

      const amount = page.getByTestId('swap-amount-input');
      await amount.fill('00.15');
      await expect(amount).toHaveValue('0.15');
      await expect(page.getByRole('button', { name: 'USD', exact: true })).toBeVisible();

      const screenshotPath = test.info().outputPath(`token-display-${width}-${dark ? 'dark' : 'light'}.png`);
      const screenshot = await page.screenshot({ path: screenshotPath, animations: 'disabled', caret: 'hide' });
      await sharp(screenshot).resize(1800, 1800, { fit: 'inside', withoutEnlargement: true }).toFile(screenshotPath);
      await test.info().attach(`token-display-${width}-${dark ? 'dark' : 'light'}`, {
        path: screenshotPath,
        contentType: 'image/png'
      });
    });
  }
}
