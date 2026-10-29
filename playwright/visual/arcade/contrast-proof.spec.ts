import { expect, test } from '@playwright/test';

test('capture real featured card text geometry on a valid mid-light brand color', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 400 });
  await page.goto('/');
  const art = page.locator('[data-slot="featured-art"]');
  const name = art.locator('> span').nth(1);
  const headline = art.locator('> span').nth(2);
  await expect(name).toHaveText('Faucet');
  await expect(headline).toBeVisible();
  const geometry = await art.evaluate(element => {
    const artBox = element.getBoundingClientRect();
    const [scrim, name, headline] = Array.from(element.children) as HTMLElement[];
    const box = name.getBoundingClientRect();
    const text = getComputedStyle(name);
    return { artHeight: artBox.height, nameTop: box.top - artBox.top, nameHeight: box.height,
      headlineHeight: headline.getBoundingClientRect().height, fontSize: text.fontSize, opacity: text.opacity,
      backgroundColor: getComputedStyle(element).backgroundColor, gradient: getComputedStyle(scrim).backgroundImage };
  });
  console.log('FEATURED_CONTRAST_GEOMETRY', JSON.stringify(geometry));
  expect(geometry.headlineHeight).toBeGreaterThan(26);
  await page.screenshot({ path: testInfo.outputPath('featured-contrast.png') });
});
