import type { BrowserContext, Page } from '@playwright/test';

import { expect, test } from '../fixtures/extension';

/**
 * The wallet names its test network in a small strip at the bottom nav's right corner (it used to
 * be a banner above every page). The strip must sit inside the 360x600 extension popup without
 * overlapping any tab, and its explanation sheet (#875) must fit the popup: DrawerContent caps at
 * 80vh, so the notice rows scroll and the CTA stays pinned inside the viewport.
 *
 * The strip lives in the tab bar, so this needs a wallet: import one through fullpage onboarding,
 * then open popup.html in a tab at the popup's size, where the app lays out as the popup.
 */

const PASSWORD = 'Password123!';
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ');

async function importWallet(extensionContext: BrowserContext, extensionId: string): Promise<void> {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('onboarding-welcome').waitFor({ timeout: 30_000 });
  await page.locator('#import-link').click();
  await page.getByTestId('onboarding-network-notice-acknowledge').click({ timeout: 15_000 });
  await page.getByTestId('import-select-type').waitFor({ timeout: 15_000 });
  await page.getByTestId('import-type-seed-phrase').click();
  await page.getByTestId('import-seed-phrase').waitFor({ timeout: 15_000 });
  for (let i = 0; i < SEED.length; i++) {
    await page.locator(`#seed-phrase-input-${i}`).fill(SEED[i]!);
  }
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page).toHaveURL(/create-password/);
  await page.locator('input[placeholder="Enter password"]').first().fill(PASSWORD);
  await page.locator('input[placeholder="Enter password again"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: /continue/i }).click();
  await page.getByTestId('import-recovery-method').waitFor({ timeout: 15_000 });
  await page.getByText(/import public account/i).click();
  await page.getByRole('button', { name: /continue/i }).click();
  await page.getByTestId('onboarding-confirmation-submit').click({ timeout: 30_000 });
  // The wallet is Ready once the side-panel handoff offers to open it; this test drives the popup
  // instead, so it stops here.
  await expect(page.getByRole('button', { name: /open wallet/i })).toBeVisible({ timeout: 30_000 });
  await page.close();
}

async function openPopup(extensionContext: BrowserContext, extensionId: string, locale: string): Promise<Page> {
  const page = await extensionContext.newPage();
  // The extension fixture launches with no viewport (Playwright's 1280x720), and test.use({ viewport })
  // does not reach it.
  await page.setViewportSize({ width: 360, height: 600 });
  if (locale !== 'en') {
    // src/i18n.ts reads the saved 'locale' before the language detector.
    await page.addInitScript(value => localStorage.setItem('locale', value), locale);
  }
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  const strip = page.getByTestId('network-mode-strip');
  const unlock = page.getByTestId('unlock-password');
  await strip.or(unlock).first().waitFor({ timeout: 30_000 });
  if (await unlock.isVisible().catch(() => false)) {
    await page.locator('#unlock-password').fill(PASSWORD);
    await page.locator('#unlock-password').press('Enter');
  }
  await strip.waitFor({ timeout: 30_000 });
  return page;
}

test.describe('Network strip', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension UI only runs in Chromium');

  for (const [locale, ctaText] of [
    ['en', 'I understand'],
    ['de', 'Ich habe verstanden']
  ] as const) {
    test(`sits in the tab bar's corner and opens a sheet that fits a 360x600 popup (${locale})`, async ({
      extensionContext,
      extensionId
    }) => {
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

      // No banner tops the wallet any more.
      await expect(page.getByTestId('network-mode-banner')).toHaveCount(0);

      // The strip is inside the bottom nav, right of every tab, and inside the popup.
      const strip = page.getByTestId('network-mode-strip');
      const nav = page.locator('[data-tabbar-footer] nav');
      const stripBox = (await strip.boundingBox())!;
      const navBox = (await nav.boundingBox())!;
      expect(stripBox.x).toBeGreaterThanOrEqual(navBox.x);
      expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(navBox.x + navBox.width + 0.5);
      expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(360);
      for (const tab of await nav.getByRole('button').all()) {
        if ((await tab.getAttribute('data-testid')) === 'network-mode-strip') continue;
        const tabBox = (await tab.boundingBox())!;
        expect(tabBox.x + tabBox.width).toBeLessThanOrEqual(stripBox.x + 0.5);
      }

      await strip.click();
      // A test id, not a role: DrawerHeader carries its own close button.
      const cta = page.getByTestId('network-mode-sheet-cta');
      await cta.waitFor({ state: 'visible', timeout: 15_000 });
      // A locale switch that silently fails would run the long-locale case in English.
      await expect(cta).toHaveText(ctaText);
      await expect(strip).toHaveAttribute('aria-expanded', 'true');
      // vaul slides the sheet in over 0.5 s; take the baseline only once it rests.
      await page.getByTestId('network-mode-sheet').evaluate(el => {
        const drawer = el.closest('[data-slot="drawer-content"]');
        if (!drawer) throw new Error('network-mode-sheet is not inside the drawer content');
        return Promise.all(drawer.getAnimations({ subtree: true }).map(a => a.finished)).then(() => undefined);
      });
      const innerHeight = await page.evaluate(() => window.innerHeight);
      const ctaBottom = async () => {
        const box = await cta.boundingBox();
        return box ? box.y + box.height : Number.POSITIVE_INFINITY;
      };

      await expect.poll(ctaBottom, { timeout: 5_000 }).toBeLessThanOrEqual(innerHeight);
      const ctaBefore = await cta.boundingBox();

      await page.getByTestId('network-mode-sheet-body').evaluate(body => body.scrollTo(0, body.scrollHeight));
      const lastRow = page.getByTestId('network-mode-sheet').getByRole('listitem').nth(2);
      await expect
        .poll(async () => {
          const box = await lastRow.boundingBox();
          return box ? box.y + box.height : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(ctaBefore!.y);

      const ctaAfter = await cta.boundingBox();
      expect(ctaAfter!.y).toBeCloseTo(ctaBefore!.y, 0);

      await cta.click();
      await expect(page.getByTestId('network-mode-sheet')).toHaveCount(0);
      await expect(strip).toHaveAttribute('aria-expanded', 'false');
    });
  }
});
