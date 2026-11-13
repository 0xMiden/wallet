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

      // Text ranges expose the glyphs hidden by ellipsis that DOM visibility alone misses.
      const quantityGeometry = await row.getByText('123456.123456 WTEST', { exact: true }).evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let unitNode: Node | null = null;
        let unitOffset = -1;
        while ((unitNode = walker.nextNode())) {
          unitOffset = unitNode.textContent?.indexOf('WTEST') ?? -1;
          if (unitOffset >= 0) break;
        }
        if (!unitNode || unitOffset < 0) throw new Error('Missing fixture token unit');

        const range = document.createRange();
        range.setStart(unitNode, unitOffset);
        range.setEnd(unitNode, unitOffset + 'WTEST'.length);
        const unit = range.getBoundingClientRect();
        const amountBox = element.getBoundingClientRect();
        const rowElement = element.closest('[data-testid="token-value-row"]')!;
        const rowBox = rowElement.getBoundingClientRect();
        const trailing = rowElement.querySelector('[data-slot="trailing"]')!.getBoundingClientRect();
        const inside = (inner: DOMRect, outer: DOMRect) =>
          inner.left >= outer.left - 1 &&
          inner.right <= outer.right + 1 &&
          inner.top >= outer.top - 1 &&
          inner.bottom <= outer.bottom + 1;

        range.selectNodeContents(element);
        const quantityRects = Array.from(range.getClientRects());
        return {
          unitInsideAmount: unit.width > 0 && unit.height > 0 && inside(unit, amountBox),
          quantityInsideRow: quantityRects.length > 0 && quantityRects.every(rect => inside(rect, rowBox)),
          separateFromPrice: quantityRects.every(
            rect =>
              rect.right <= trailing.left ||
              rect.left >= trailing.right ||
              rect.bottom <= trailing.top ||
              rect.top >= trailing.bottom
          ),
          noHorizontalClipping: element.scrollWidth <= element.clientWidth + 1
        };
      });
      expect(quantityGeometry.unitInsideAmount, 'WTEST is fully inside the amount box').toBe(true);
      expect(quantityGeometry.quantityInsideRow, 'Full token quantity is inside the row').toBe(true);
      expect(quantityGeometry.separateFromPrice, 'Token quantity does not overlap the price or check').toBe(true);
      expect(quantityGeometry.noHorizontalClipping, 'Full token quantity has no horizontal clipping').toBe(true);
    });
  }
}
