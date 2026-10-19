import { chromium } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

import { browserLaunchOptions } from '../e2e/fixtures/browser-launch-options';
import { expect, test as base } from '../fixtures/extension';

const test = base.extend({
  extensionContext: async ({ extensionPath }, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-picker-pw-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...browserLaunchOptions(extensionPath, { ...process.env, E2E_HEADLESS: '1' }),
      viewport: { width: 960, height: 900 }
    });
    try {
      await use(context);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }
});

test.describe('AppKit external-wallet picker', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension UI only runs in Chromium');

  for (const theme of ['light', 'dark']) {
    test(`offers external wallets without embedded authentication in ${theme} theme`, async ({
      extensionContext,
      extensionId
    }, testInfo) => {
      const dashboardConfig = {
        features: [{ id: 'social_login', isEnabled: true, config: ['email', 'google', 'github'] }]
      };
      await extensionContext.route(url => url.pathname === '/appkit/v1/config', async route => {
        await route.fulfill({ json: dashboardConfig });
      });
      const page = await extensionContext.newPage();
      await page.addInitScript(value => localStorage.setItem('theme_setting', value), theme);
      const configResponsePromise = page.waitForResponse(
        response => new URL(response.url()).pathname === '/appkit/v1/config'
      );
      await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });
      const configResponse = await configResponsePromise;
      expect(await configResponse.json()).toEqual(dashboardConfig);
      await expect(page.getByTestId('onboarding-welcome')).toBeVisible({ timeout: 30_000 });
      await page.evaluate(async () => {
        await customElements.whenDefined('appkit-connect-button');
        const button = document.createElement('appkit-connect-button');
        button.setAttribute('namespace', 'eip155');
        document.body.append(button);
      });
      await page.locator('appkit-connect-button').getByRole('button').click();
      const modal = page.locator('w3m-modal');
      await expect(modal.locator('w3m-connect-view')).toBeVisible();
      const walletConnect = modal.getByTestId('wallet-selector-walletconnect');
      await expect(walletConnect).toBeVisible();
      await expect(walletConnect.getByRole('button')).toBeEnabled();
      await expect(modal.getByTestId('all-wallets')).toBeVisible();
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*\bdark\b)/);

      const screenshotPath = testInfo.outputPath(`appkit-picker-${theme}.png`);
      await modal.screenshot({ path: screenshotPath, scale: 'css' });
      const resized = await sharp(screenshotPath)
        .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
        .toBuffer();
      fs.writeFileSync(screenshotPath, resized);
      await testInfo.attach(`appkit-picker-${theme}`, { path: screenshotPath, contentType: 'image/png' });

      await expect(modal.locator('w3m-email-login-widget')).toHaveCount(0);
      await expect(modal.locator('w3m-social-login-widget')).toHaveCount(0);
      await page.close();
    });
  }
});
