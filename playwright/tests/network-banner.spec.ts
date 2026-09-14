import { expect, test } from '../fixtures/extension';

/**
 * The network banner's explanation sheet (#875) must fit the 360x600 extension
 * popup: DrawerContent caps at 80vh, so the notice rows scroll and the CTA
 * stays pinned inside the viewport. The sheet is fixed to the viewport, so the
 * fullpage at popup size exercises the same layout, and Welcome shows the
 * banner without needing a wallet.
 */
test.describe('Network banner sheet', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension UI only runs in Chromium');

  for (const [locale, ctaText] of [
    ['en', 'I understand'],
    ['de', 'Ich habe verstanden']
  ] as const) {
    test(`pins its CTA inside a 360x600 popup and scrolls the rows (${locale})`, async ({
      extensionContext,
      extensionId
    }) => {
      // Start as a returning user: the one-time "Pin Bread" tooltip (fixed,
      // z-9999, top-right) covers the banner at this width. The product marks it
      // seen by removing `fresh_install`; wait for the service worker to write
      // the flag on install, then remove it, so neither ordering can race.
      const [worker] = extensionContext.serviceWorkers();
      await (worker ?? (await extensionContext.waitForEvent('serviceworker'))).evaluate(async () => {
        for (let i = 0; i < 50; i += 1) {
          if ((await chrome.storage.local.get('fresh_install')).fresh_install) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        await chrome.storage.local.remove('fresh_install');
      });

      const page = await extensionContext.newPage();
      // The extension fixture launches with no viewport (Playwright's 1280x720),
      // and test.use({ viewport }) does not reach it.
      await page.setViewportSize({ width: 360, height: 600 });
      if (locale !== 'en') {
        // src/i18n.ts reads the saved 'locale' before the language detector.
        await page.addInitScript(value => localStorage.setItem('locale', value), locale);
      }
      await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });

      await page.getByTestId('network-mode-banner').click({ timeout: 30_000 });
      // A test id, not a role: DrawerHeader carries its own close button.
      const cta = page.getByTestId('network-mode-sheet-cta');
      await cta.waitFor({ state: 'visible', timeout: 15_000 });
      // A locale switch that silently fails would run the long-locale case in English.
      await expect(cta).toHaveText(ctaText);
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
    });
  }
});
