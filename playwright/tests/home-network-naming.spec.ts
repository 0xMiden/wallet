import type { BrowserContext, Page } from '@playwright/test';

import { IMPORTED_WALLET_PASSWORD, importWallet } from '../e2e/helpers/import-wallet';
import { expect, test } from '../fixtures/extension';

/**
 * Home names no network any more: the pill above its balance card (which used to be a ribbon across
 * the tab bar's corner, and before that a banner above every page) gave way to the mainnet countdown
 * banner, which the remote config switches on. The network pill and its explanation sheet (#875)
 * now draw only on the screens that commit value (`NetworkModeBanner`); their unit suites cover the
 * sheet. This checks the popup's Home at 360x600: the balance card is the first thing, with no pill
 * or network banner above it.
 *
 * Home needs a wallet: import one through fullpage onboarding, then open popup.html in a tab at the
 * popup's size, reporting the tab as the popup view so the app keeps it and lays out as the popup.
 */

async function openPopup(extensionContext: BrowserContext, extensionId: string, locale: string): Promise<Page> {
  const page = await extensionContext.newPage();
  // The extension fixture launches with no viewport (Playwright's 1280x720), and test.use({ viewport })
  // does not reach it.
  await page.setViewportSize({ width: 360, height: 600 });
  // src/popup.tsx closes any popup.html that is not an action-popup view (and opens the full page
  // instead), and a tab never is one. Report this tab as the popup so the popup's own entry renders.
  await page.addInitScript(() => {
    const getViews = chrome.extension.getViews.bind(chrome.extension);
    chrome.extension.getViews = (properties?: chrome.extension.FetchProperties) =>
      properties?.type === 'popup' ? [window] : getViews(properties);
  });
  if (locale !== 'en') {
    // src/i18n.ts reads the saved 'locale' before the language detector.
    await page.addInitScript(value => localStorage.setItem('locale', value), locale);
  }
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('balance-card-label');
  const unlock = page.getByTestId('unlock-password');
  await card.or(unlock).first().waitFor({ timeout: 30_000 });
  if (await unlock.isVisible().catch(() => false)) {
    await page.locator('#unlock-password').fill(IMPORTED_WALLET_PASSWORD);
    await page.locator('#unlock-password').press('Enter');
  }
  await card.waitFor({ timeout: 30_000 });
  return page;
}

test.describe('Home network naming', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension UI only runs in Chromium');

  for (const locale of ['en', 'de'] as const) {
    test(`shows no network pill or banner above the balance card in a 360x600 popup (${locale})`, async ({
      extensionContext,
      extensionId
    }) => {
      // Itemised so a stuck step reports its own diagnostic instead of a bare "Test timeout"
      // (reveal-seed-phrase.spec.ts does the same): fresh_install loop 5s; importWallet's welcome
      // 30s + notice 30s (wait, then click) + select-type 15s + seed-phrase 15s + create-password
      // 10s + recovery-method 15s + confirmation 30s + telemetry-consent 40s (wait, decline,
      // detach) + open-wallet 30s = 215s; openPopup's two 30s waits = 60s; no-banner 10s +
      // no-pill 10s + card-on-screen 10s = 30s; total 310s.
      test.setTimeout(330_000);

      // Start as a returning user: the one-time "Pin Bread" tooltip (fixed, z-9999, top-right) can
      // cover the popup at this width. The product marks it seen by removing `fresh_install`; wait
      // for the service worker to write the flag on install, then remove it, so neither ordering can
      // race.
      const [worker] = extensionContext.serviceWorkers();
      await (worker ?? (await extensionContext.waitForEvent('serviceworker'))).evaluate(async () => {
        for (let i = 0; i < 50; i += 1) {
          if ((await chrome.storage.local.get('fresh_install')).fresh_install) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        await chrome.storage.local.remove('fresh_install');
      });

      await importWallet(extensionContext, extensionId);
      const page = await openPopup(extensionContext, extensionId, locale);

      // Neither the retired full-width banner nor the pill tops Home.
      await expect(page.getByTestId('network-mode-banner')).toHaveCount(0);
      await expect(page.getByTestId('network-mode-pill')).toHaveCount(0);

      // The balance card is on screen at the popup's size, in the viewport.
      const cardLabelBox = (await page.getByTestId('balance-card-label').boundingBox())!;
      const innerHeight = await page.evaluate(() => window.innerHeight);
      expect(cardLabelBox.y).toBeGreaterThanOrEqual(0);
      expect(cardLabelBox.y + cardLabelBox.height).toBeLessThanOrEqual(innerHeight);
    });
  }
});
