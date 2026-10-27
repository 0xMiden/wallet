import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { expect, test } from '../fixtures/extension';

test('mainnet code uses ordinary extension paste without clipboard-read permission', async ({
  extensionContext,
  extensionId
}, info) => {
  const page = await extensionContext.newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  try {
    await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('onboarding-welcome')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('onboarding-config-loading')).toHaveCount(0);
    if ((await page.getByTestId('onboarding-have-code').count()) === 0) {
      await page.getByTestId('onboarding-bread-logo').click({ clickCount: 7, delay: 50 });
    }
    await page.getByTestId('onboarding-have-code').click();
    const code = page.getByTestId('onboarding-mainnet-access-code');
    await expect(code).toBeVisible();
    const permissions = await page.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(permissions).not.toContain('clipboardRead');

    await page.bringToFront();
    await page.evaluate(() => navigator.clipboard.writeText('ABCDEF-123456'));
    const nativePaste = page.getByTestId('onboarding-mainnet-access-paste');
    if (await nativePaste.isVisible()) {
      await nativePaste.click();
    } else {
      await code.focus();
      await code.press('ControlOrMeta+V');
    }
    await expect(code).toHaveValue('ABCDEF123456');
    await expect(nativePaste).toHaveCount(0);
    await expect(page.getByTestId('onboarding-mainnet-access-submit')).toBeEnabled();
    await expect(page.getByTestId('onboarding-mainnet-access-error')).toHaveCount(0);
  } finally {
    const screenshot = info.outputPath('wallet-access-mainnet-paste.png');
    await page.screenshot({ path: screenshot });
    await writeFile(
      screenshot,
      await sharp(screenshot).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).toBuffer()
    );
    await info.attach('mainnet-paste', { path: screenshot, contentType: 'image/png' });
    await page.close();
  }
});
