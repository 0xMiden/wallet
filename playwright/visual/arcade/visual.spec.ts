import { expect, test } from '@playwright/test';

for (const width of [320, 360, 402, 440, 768]) {
  for (const dark of [false, true]) {
    for (const long of [false, true]) {
      test(`centers capped CTA at ${width}px, ${dark ? 'dark' : 'light'}, ${long ? 'long' : 'short'} content`, async ({
        page
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/?${dark ? 'dark&' : ''}${long ? 'long' : ''}`);
        await page.getByRole('button', { name: 'Details', exact: true }).click();
        const sheet = page.getByRole('dialog');
        const button = sheet.getByRole('button', { name: 'Open game', exact: true });
        await expect(button).toBeVisible();
        await expect
          .poll(async () => {
            const [s, b] = await Promise.all([sheet.boundingBox(), button.boundingBox()]);
            return s && b ? Math.abs(b.x - s.x - (s.x + s.width - b.x - b.width)) : Infinity;
          })
          .toBeLessThan(1);
        const [s, b] = await Promise.all([sheet.boundingBox(), button.boundingBox()]);
        expect(s).not.toBeNull();
        expect(b).not.toBeNull();
        expect(b!.width).toBeCloseTo(Math.min(370, s!.width - 32), 0);
        expect(b!.height).toBeCloseTo(48, 3);
        expect(b!.y).toBeGreaterThan(s!.y);
        expect(b!.y + b!.height).toBeLessThanOrEqual(s!.y + s!.height - 16);
        await page.screenshot({ path: test.info().outputPath('arcade-sheet.png') });
      });
    }
  }
}
