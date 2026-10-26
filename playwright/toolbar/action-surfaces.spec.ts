import { chromium, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { acknowledgeNetworkNotice } from '../e2e/helpers/network-notice';
import { passImportConfirmation } from '../e2e/helpers/onboarding-confirmation';
import { dismissTelemetryConsent } from '../e2e/helpers/telemetry-consent';

for (const theme of ['light', 'dark'] as const) {
  test(`native action shortcut toggles sidebar after full-page onboarding (${theme})`, async ({}, testInfo) => {
    const root = mkdtempSync(join(tmpdir(), 'bread-toolbar-'));
    const extension = join(root, 'extension');
    cpSync(resolve('dist/chrome_unpacked'), extension, { recursive: true });
    const manifestPath = join(extension, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.action.default_popup).toBeUndefined();
    // Only the activation chord is a fixture; Chrome dispatches the real action.
    manifest.commands = {
      ...manifest.commands,
      _execute_action: { suggested_key: { default: 'Ctrl+Shift+Y' } }
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const profile = join(root, 'profile');
    const launch = () => chromium.launchPersistentContext(profile, {
      headless: false,
      colorScheme: theme,
      viewport: null,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1400,1000'],
      ignoreDefaultArgs: ['--disable-extensions']
    });
    let context = await launch();
    const capture = async (name: string) => {
      const path = testInfo.outputPath(`${theme}-${name}.png`);
      execFileSync('import', ['-window', 'root', path]);
      execFileSync('convert', [path, '-resize', '1800x1800>', path]);
      await testInfo.attach(name, { path, contentType: 'image/png' });
    };
    const activate = () => execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+shift+y']);
    try {
      let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const panelCount = () => worker.evaluate(async () => {
        const contexts = await chrome.runtime.getContexts({});
        return contexts.filter(item => item.contextType === 'SIDE_PANEL').length;
      });
      await expect.poll(() => context.pages().some(p => p.url().includes('/fullpage.html'))).toBe(true);
      const page = context.pages().find(p => p.url().includes('/fullpage.html'))!;
      await page.waitForSelector('[data-testid="onboarding-welcome"]', { timeout: 45000 });
      await page.evaluate(value => localStorage.setItem('theme_setting', value), theme);
      await page.reload();
      await page.waitForSelector('[data-testid="onboarding-welcome"]');
      await page.bringToFront();
      await capture('fullpage-onboarding');
      activate();
      await expect.poll(panelCount).toBe(0);
      await expect(page.getByTestId('onboarding-welcome')).toBeVisible();
      await page.locator('#import-link').click();
      await acknowledgeNetworkNotice(page, 15000);
      await page.getByTestId('import-type-seed-phrase').click();
      const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ');
      for (const [index, word] of words.entries()) await page.locator(`#seed-phrase-input-${index}`).fill(word);
      await page.getByRole('button', { name: /continue/i }).click();
      await page.locator('input[placeholder="Enter password"]').fill('FixturePassword123!');
      await page.locator('input[placeholder="Enter password again"]').fill('FixturePassword123!');
      await page.getByRole('button', { name: /continue/i }).click();
      await page.getByText(/import public account/i).click();
      await page.getByTestId('reused-phrase-acknowledge').click();
      await page.getByRole('button', { name: /continue/i }).click();
      await passImportConfirmation(page, 45000);
      await dismissTelemetryConsent(page, { nextSurface: '[data-testid="finish-side-panel"]', timeoutMs: 45000 });
      await page.getByTestId('finish-side-panel').getByRole('button', { name: /open wallet/i }).click();
      await expect.poll(panelCount).toBe(1);
      await capture('ready-sidebar');
      activate();
      await expect.poll(panelCount).toBe(0);
      await capture('native-action-closed');
      activate();
      await expect.poll(panelCount).toBe(1);
      await capture('native-action-reopened');
      await worker.evaluate(async () => {
        await chrome.storage.local.set({ sidepanel_mode: false });
        await chrome.action.setPopup({ popup: 'popup.html' });
      });
      await context.close();
      context = await launch();
      worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      await expect.poll(() => worker.evaluate(() => chrome.action.getPopup({}))).toBe('');
      await expect.poll(() => worker.evaluate(() => chrome.sidePanel.getPanelBehavior())).toEqual({ openPanelOnActionClick: true });
      const ordinary = context.pages()[0] ?? await context.newPage();
      await ordinary.goto('about:blank');
      await ordinary.bringToFront();
      activate();
      await expect.poll(panelCount).toBe(1);
      await capture('old-popup-preference-recovered-after-restart');
      expect(context.pages().some(p => p.url().includes('/popup.html'))).toBe(false);
    } finally {
      await context.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
