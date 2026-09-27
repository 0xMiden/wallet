import type { BrowserContext, Page } from '@playwright/test';

import { acknowledgeNetworkNotice } from '../e2e/helpers/network-notice';
import { dismissTelemetryConsent } from '../e2e/helpers/telemetry-consent';
import { expect, test } from '../fixtures/extension';

/**
 * The wallet names its test network on a ribbon across the bottom nav's lower-right corner (it used
 * to be a banner above every page). The ribbon is drawn over the bar: the tabs keep their layout and
 * the Settings tab stays tappable under it. Its explanation sheet (#875) must fit the 360x600 popup:
 * DrawerContent caps at 80vh, so the notice rows scroll and the CTA stays pinned inside the viewport.
 *
 * The ribbon lives in the tab bar, so this needs a wallet: import one through fullpage onboarding,
 * then open popup.html in a tab at the popup's size, reporting the tab as the popup view so the
 * app keeps it and lays out as the popup.
 */

const PASSWORD = 'Password123!';
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ');

async function importWallet(extensionContext: BrowserContext, extensionId: string): Promise<void> {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('onboarding-welcome').waitFor({ timeout: 30_000 });
  await page.locator('#import-link').click();
  await acknowledgeNetworkNotice(page, 15_000);
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
  // Onboarding gained a consent screen between the confirmation and the handoff, so this
  // driver has to clear it before waiting for a post-onboarding surface.
  await dismissTelemetryConsent(page, { timeoutMs: 30_000 });
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
  const ribbon = page.getByTestId('network-mode-ribbon');
  const unlock = page.getByTestId('unlock-password');
  await ribbon.or(unlock).first().waitFor({ timeout: 30_000 });
  if (await unlock.isVisible().catch(() => false)) {
    await page.locator('#unlock-password').fill(PASSWORD);
    await page.locator('#unlock-password').press('Enter');
  }
  await ribbon.waitFor({ timeout: 30_000 });
  return page;
}

test.describe('Network corner ribbon', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension UI only runs in Chromium');

  for (const [locale, ctaText] of [
    ['en', 'I understand'],
    ['de', 'Ich habe verstanden']
  ] as const) {
    test(`sits in the tab bar's corner and opens a sheet that fits a 360x600 popup (${locale})`, async ({
      extensionContext,
      extensionId
    }) => {
      // Itemised so a stuck step reports its own diagnostic instead of a bare "Test timeout"
      // (reveal-seed-phrase.spec.ts does the same): fresh_install loop 5s; importWallet's welcome
      // 30s + notice 30s (wait, then click) + select-type 15s + seed-phrase 15s + create-password
      // 10s + recovery-method 15s + confirmation-submit 30s + telemetry-consent 40s (wait, decline,
      // detach) + open-wallet 30s = 215s; openPopup's two 30s waits = 60s; banner 10s +
      // ribbon-in-corner 10s + sheet CTA 15s + CTA text 10s + aria-expanded-true 10s + poll
      // ctaBottom 5s + poll lastRow 10s + sheet-closed 10s + aria-expanded-false 10s = 90s;
      // total 370s.
      test.setTimeout(390_000);

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

      // The ribbon is drawn inside the bar's corner, over the tabs, and inside the popup. The word is
      // a button on a band rotated -45deg, so its axis-aligned box overhangs the corner by design and
      // the corner box clips it: check that the word's centre sits in the corner's 44px square (the
      // floating bar's c = 44 in NetworkModeRibbon), that the ribbon is inside the clip, and that the
      // clip covers the whole bar and matches its rounding.
      const ribbon = page.getByTestId('network-mode-ribbon');
      const nav = page.locator('[data-tabbar-footer] nav');
      const ribbonBox = (await ribbon.boundingBox())!;
      const navBox = (await nav.boundingBox())!;
      const navRight = navBox.x + navBox.width;
      const navBottom = navBox.y + navBox.height;
      expect(navRight).toBeLessThanOrEqual(360.5);
      const wordCentre = { x: ribbonBox.x + ribbonBox.width / 2, y: ribbonBox.y + ribbonBox.height / 2 };
      expect(wordCentre.x).toBeGreaterThan(navRight - 44);
      expect(wordCentre.x).toBeLessThan(navRight);
      expect(wordCentre.y).toBeGreaterThan(navBottom - 44);
      expect(wordCentre.y).toBeLessThan(navBottom);
      const corner = nav.locator('[data-slot="bottom-nav-corner"]');
      await expect(corner.getByTestId('network-mode-ribbon')).toHaveCount(1);
      expect(await corner.evaluate(el => getComputedStyle(el).overflow)).toMatch(/^(hidden|clip)$/);
      const navRadius = await nav.evaluate(el => getComputedStyle(el).borderRadius);
      expect(navRadius).not.toBe('0px');
      expect(await corner.evaluate(el => getComputedStyle(el).borderRadius)).toBe(navRadius);
      expect(await corner.boundingBox()).toEqual(navBox);

      // It takes no layout space: every tab is the same width, as without it. Settings is the last.
      const tabs = await nav.locator('button:not([data-testid="network-mode-ribbon"])').all();
      const widths = await Promise.all(tabs.map(async tab => Math.round((await tab.boundingBox())!.width)));
      expect(new Set(widths).size).toBe(1);
      const settings = tabs[tabs.length - 1]!;

      // Taps land where they look like they land: the word opens the sheet, the Settings tab's
      // centre still hits the Settings tab.
      const settingsBox = (await settings.boundingBox())!;
      const hitsSettings = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null,
        { x: settingsBox.x + settingsBox.width / 2, y: settingsBox.y + settingsBox.height / 2 }
      );
      expect(hitsSettings).toBe(await settings.getAttribute('aria-label'));
      const hitsRibbon = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('data-testid') ?? null,
        { x: ribbonBox.x + ribbonBox.width / 2, y: ribbonBox.y + ribbonBox.height / 2 }
      );
      expect(hitsRibbon).toBe('network-mode-ribbon');

      await ribbon.click();
      // A test id, not a role: DrawerHeader carries its own close button.
      const cta = page.getByTestId('network-mode-sheet-cta');
      await cta.waitFor({ state: 'visible', timeout: 15_000 });
      // A locale switch that silently fails would run the long-locale case in English.
      await expect(cta).toHaveText(ctaText);
      await expect(ribbon).toHaveAttribute('aria-expanded', 'true');
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
      await expect(ribbon).toHaveAttribute('aria-expanded', 'false');
    });
  }
});
