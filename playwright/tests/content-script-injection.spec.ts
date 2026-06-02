import { expect, test } from '../fixtures/extension';

/**
 * Regression guard: MV3 content_scripts run as classic scripts, so if
 * contentScript.js is ever re-emitted as an ES module with `import`
 * statements, it fails to parse silently and `window.midenWallet` is
 * never injected — dApps then see `WalletNotReadyError` on connect.
 *
 * This spec opens a fake https:// page in the extension's browser
 * context, letting the manifest's `https://*\/*` matcher fire.
 * contentScript.js should inject <script src="addToWindow.js">, which
 * sets window.midenWallet.
 */
test.describe('Content script injection', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'MV3 extension only runs in Chromium');

  test('window.midenWallet is defined on dApp pages', async ({ extensionContext, extensionId }) => {
    // Make sure the SW is up before opening the dApp page (the fixture
    // already resolved extensionId from the SW, but we also want
    // addToWindow.js to be servable via browser.runtime.getURL).
    expect(extensionId).toBeTruthy();

    // Mock a minimal HTML response at a reserved-invalid URL so we
    // don't depend on the network. The content_scripts matcher is
    // URL-based; as long as the navigation commits to https://*, the
    // extension injects contentScript.js.
    await extensionContext.route('https://miden-dapp-probe.invalid/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><html><head><title>dApp Probe</title></head><body></body></html>'
      });
    });

    const dappPage = await extensionContext.newPage();
    await dappPage.goto('https://miden-dapp-probe.invalid/', { waitUntil: 'domcontentloaded' });

    // contentScript.js runs at document_start and appends
    // <script src="addToWindow.js">, which asynchronously sets
    // window.midenWallet. Poll until it appears.
    await expect
      .poll(() => dappPage.evaluate(() => typeof (window as unknown as { midenWallet?: unknown }).midenWallet), {
        timeout: 15_000,
        intervals: [100, 250, 500]
      })
      .toBe('object');

    await dappPage.close();
  });
});
