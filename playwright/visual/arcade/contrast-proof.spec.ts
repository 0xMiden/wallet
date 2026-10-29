import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

test('capture real featured card text geometry on a valid mid-light brand color', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 400 });
  await page.goto('/');
  const art = page.locator('[data-slot="featured-art"]');
  const name = art.getByText('Faucet', { exact: true });
  const headline = art.getByText('A synthetic two-line headline for a featured application');
  await expect(name).toHaveText('Faucet');
  await expect(headline).toBeVisible();
  expect((await headline.boundingBox())?.height).toBeGreaterThan(26);
  const nameBox = await name.boundingBox();
  if (!nameBox) throw new Error('Featured name geometry unavailable');
  const foreground = await name.evaluate(element => {
    const style = getComputedStyle(element);
    return { color: style.color, opacity: Number(style.opacity) };
  });
  const image = PNG.sync.read(await page.screenshot({ path: testInfo.outputPath('featured-contrast.png') }));
  const x = Math.floor(nameBox.x - 2);
  const y = Math.floor(nameBox.y + nameBox.height / 2);
  const offset = (y * image.width + x) * 4;
  const background = Array.from(image.data.slice(offset, offset + 3));
  const components = foreground.color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
  if (!components || components.length !== 3) throw new Error('Text color unavailable');
  const blend = components.map((c, i) => c * foreground.opacity + background[i]! * (1 - foreground.opacity));
  const luminance = (rgb: number[]) => rgb.reduce((sum, channel, i) => {
    const c = channel / 255;
    return sum + [0.2126, 0.7152, 0.0722][i]! * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  }, 0);
  const [bright, dark] = [luminance(blend), luminance(background)].sort((a, b) => b - a);
  const contrast = (bright! + 0.05) / (dark! + 0.05);
  console.log('FEATURED_NAME_CONTRAST', contrast);
  expect(contrast).toBeGreaterThanOrEqual(4.5);
});
