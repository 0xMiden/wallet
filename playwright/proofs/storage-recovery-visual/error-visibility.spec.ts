import { test, expect } from '@playwright/test';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

for (const theme of ['light', 'dark']) {
  test(`recovery error is visible without scrolling in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(`/?${theme}&result=error`);
    await page.getByRole('button', { name: 'Check storage' }).click();
    const error = page.getByText('The check could not finish. Wallet actions remain paused.');
    await expect(error).toBeVisible();
    const output = process.env.RECOVERY_VISUAL_SCREENSHOTS ?? 'recovery-visual-screenshots';
    await mkdir(output, { recursive: true });
    const path = join(output, `extension-${theme}-unscrolled-error.png`);
    await page.screenshot({ path, fullPage: false, animations: 'disabled' });
    await sharp(path).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).png().toFile(path + '.tmp.png');
    await rename(path + '.tmp.png', path);
    await expect(error).toBeInViewport({ ratio: 1 });
  });
}
