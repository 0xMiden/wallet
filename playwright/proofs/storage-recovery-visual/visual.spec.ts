import { test, expect, type Page } from '@playwright/test';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const surfaces = [
  { name: 'extension', width: 360, height: 640 },
  { name: 'mobile', width: 393, height: 852 },
  { name: 'desktop', width: 1280, height: 900 }
];
const output = process.env.RECOVERY_VISUAL_SCREENSHOTS ?? 'recovery-visual-screenshots';

async function capture(page: Page, name: string) {
  await mkdir(output, { recursive: true });
  const path = join(output, name + '.png');
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  const resized = path + '.resized.png';
  await sharp(path).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).png().toFile(resized);
  await rename(resized, path);
  const metadata = await sharp(path).metadata();
  expect(metadata.width).toBeLessThanOrEqual(1800);
  expect(metadata.height).toBeLessThanOrEqual(1800);
}

for (const surface of surfaces) for (const theme of ['light', 'dark']) {
  test(`${surface.name} ${theme} recovery and file flows`, async ({ page }) => {
    await page.setViewportSize({ width: surface.width, height: surface.height });
    const query = theme === 'dark' ? '?dark' : '?light';
    const prefix = `${surface.name}-${theme}`;
    await page.goto('/' + query);
    await expect(page.getByTestId('storage-recovery-page')).toBeVisible();
    await expect(page.getByText('A submitted transaction may still complete.', { exact: false })).toBeVisible();
    await capture(page, `${prefix}-recovery`);

    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
    await capture(page, `${prefix}-keyboard-focus`);

    await page.getByRole('button', { name: 'Export recovery data' }).click();
    await expect(page.getByTestId('export-file-password')).toBeVisible();
    await capture(page, `${prefix}-export`);
    await page.mouse.move(surface.width / 2, surface.height / 2);
    await page.mouse.wheel(0, 600);
    await expect(page.getByTestId('export-file-password-verify-input')).toBeInViewport();
    expect(await page.getByTestId('export-file-password-verify-input').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element;
    })).toBe(true);
    await capture(page, `${prefix}-export-scrolled`);
    await page.getByTestId('export-file-password-input').fill('VisualFixture1!');
    await page.getByTestId('export-file-password-verify-input').fill('VisualFixture1!');
    await page.getByTestId('export-file-submit').click();
    await page.getByRole('button', { name: 'Fixture authentication' }).click();
    await expect(page.getByText('This file does not contain your signing keys or recovery phrase.')).toBeVisible();
    await capture(page, `${prefix}-export-delivery`);

    await page.goto('/' + query);
    await page.getByRole('button', { name: 'Import recovery data' }).click();
    await expect(page.getByLabel('Choose recovery data file')).toBeVisible();
    await capture(page, `${prefix}-import`);
    await page.getByLabel('Choose recovery data file').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
    await page.getByLabel('Recovery file password').fill('VisualFixture1!');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Fixture authentication' }).click();
    await expect(page.getByText('This is not a valid recovery data file.')).toBeVisible();
    await capture(page, `${prefix}-import-error`);

    await page.goto('/' + query + '&result=loading');
    await page.getByRole('button', { name: 'Check storage' }).click();
    await expect(page.getByText('Checking retained wallet data...')).toBeVisible();
    await capture(page, `${prefix}-loading`);
    await page.goto('/' + query + '&result=error');
    await page.getByRole('button', { name: 'Check storage' }).click();
    await expect(page.getByText('The check could not finish. Wallet actions remain paused.')).toBeVisible();
    await capture(page, `${prefix}-recovery-error`);
    await page.mouse.move(surface.width / 2, surface.height / 2);
    await page.mouse.wheel(0, 600);
    await expect(page.getByText('The check could not finish. Wallet actions remain paused.')).toBeInViewport();
    await capture(page, `${prefix}-recovery-error-scrolled`);
  });
}
