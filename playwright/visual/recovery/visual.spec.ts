import { expect, test } from '@playwright/test';

test('recovery landing and import/export forms', async ({ page }, info) => {
  await page.goto(info.project.name.endsWith('dark') ? '/?dark' : '/');
  await expect(page.getByTestId('storage-recovery-page')).toBeVisible();
  await page.screenshot({ path: info.outputPath('landing.png') });
  await page.getByRole('button', { name: 'Export recovery data' }).click();
  await expect(page.locator('input[type=password]').first()).toBeVisible();
  await expect(page.getByText('Enter a password to encrypt your recovery data file.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('export.png') });
  await page.goto(info.project.name.endsWith('dark') ? '/?dark' : '/');
  await page.getByRole('button', { name: 'Import recovery data' }).click();
  await expect(page.locator('input[type=file]')).toBeAttached();
  await expect(page.getByText('Choose a previously exported recovery data file.', { exact: false })).toBeVisible();
  await page.screenshot({ path: info.outputPath('import.png') });
});
