import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { completeSeedImportOnboarding } from '../e2e/helpers/dapp-confirm';
import { expect, test } from '../fixtures/extension';

// Only terminal navigation screenshots are retained; backup material and credentials stay private.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test.describe('encrypted file export navigation', () => {
  async function fillPrivateInput(field: Locator, value: string): Promise<void> {
    try {
      await field.fill(value);
    } catch {
      throw new Error('Could not fill a private acceptance input');
    }
  }

  async function exportFile(page: Page): Promise<void> {
    await page.getByTestId('Settings/EncryptedWalletFile').click();
    await fillPrivateInput(page.getByTestId('encrypted-file-wallet-password-input'), 'Password123!');
    await page.getByTestId('encrypted-file-wallet-password-consent').click();
    await page.getByTestId('encrypted-file-wallet-password-submit').click();
    const password = `Aa1!${randomUUID()}`;
    await page.getByTestId('export-file-name-input').fill('navigation-acceptance');
    await fillPrivateInput(page.getByTestId('export-file-password-input'), password);
    await fillPrivateInput(page.getByTestId('export-file-password-verify-input'), password);
    const downloading = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('export-file-submit').click();
    const download = await downloading;
    try {
      expect(await download.failure()).toBeNull();
      await expect(page.getByTestId('export-file-complete')).toContainText('Exported!');
    } finally {
      await download.delete();
    }
  }

  test('Done and Back leave an actual successful export in both themes and extension layouts', async ({
    extensionContext,
    extensionId
  }, testInfo) => {
    test.setTimeout(810_000);
    const onboardingPage = await extensionContext.newPage();
    const origin = `chrome-extension://${extensionId}`;
    try {
      await completeSeedImportOnboarding(onboardingPage, `${origin}/fullpage.html`);
    } catch {
      throw new Error('Disposable acceptance wallet setup did not finish');
    }

    const surfaces = [
      { name: 'fullpage', shell: 'fullpage.html', width: 600, height: 800 },
      { name: 'popup', shell: 'popup.html', width: 360, height: 640 },
      { name: 'sidebar', shell: 'sidepanel.html', width: 360, height: 800 }
    ];
    for (const surface of surfaces) {
      for (const theme of ['light', 'dark'] as const) {
        const page = await extensionContext.newPage();
        await page.setViewportSize({ width: surface.width, height: surface.height });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(`${origin}/${surface.shell}#/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const profileTab = page.getByRole('button', { name: 'Profile', exact: true });
        await profileTab.waitFor({ state: 'visible', timeout: 20_000 });
        await profileTab.click({ timeout: 10_000 });
        await expect.poll(() => new URL(page.url()).hash).toBe('#/me');
        await expect(page.getByTestId('profile-settings-menu')).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
          .toBe(theme === 'dark');

        await exportFile(page);
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        await expect.poll(() => new URL(page.url()).hash).toBe('#/me');
        await expect(page.getByTestId('profile-settings-menu')).toBeVisible();
        await expect(page.getByTestId('export-file-complete')).toBeHidden();
        await page.screenshot({
          scale: 'css',
          path: testInfo.outputPath(`profile-settings-export-${surface.name}-${theme}-done.png`)
        });
        await page.goBack();
        await expect(page).not.toHaveURL(/#\/settings\/encrypted-wallet-file/);
        await expect(page.getByTestId('export-file-complete')).toBeHidden();
        await page.goto(`${origin}/${surface.shell}#/me`);
        await expect(page.getByTestId('profile-settings-menu')).toBeVisible();

        await exportFile(page);
        await page.getByRole('button', { name: 'Back', exact: true }).click();
        await expect.poll(() => new URL(page.url()).hash).toBe('#/me');
        await expect(page.getByTestId('profile-settings-menu')).toBeVisible();
        await expect(page.getByTestId('export-file-complete')).toBeHidden();
        await page.screenshot({
          scale: 'css',
          path: testInfo.outputPath(`profile-settings-export-${surface.name}-${theme}-back.png`)
        });
        await page.goBack();
        await expect(page).not.toHaveURL(/#\/settings\/encrypted-wallet-file/);
        await expect(page.getByTestId('export-file-complete')).toBeHidden();

        await page.close();
      }
    }
  });
});
