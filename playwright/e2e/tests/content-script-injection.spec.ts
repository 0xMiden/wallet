import { expect, test } from '../fixtures/two-wallets';

/**
 * Regression guard for PR #197 / issue where content scripts were emitted as
 * ES modules with `import` statements — MV3 content scripts run as classic
 * scripts, so `import` fails to parse silently and `window.midenWallet` is
 * never injected. Any dApp then sees `WalletNotReadyError` on connect.
 *
 * This spec opens a fake https:// page in the wallet's browser context,
 * letting the extension's `content_scripts` matcher (`https://*\/*`) fire.
 * contentScript.js is expected to append <script src="addToWindow.js"> to
 * the page, which in turn sets `window.midenWallet`.
 */
test.describe('Content script injection', () => {
  test('window.midenWallet is defined on dApp pages', async ({ walletA, steps }) => {
    const context = walletA.page.context();

    // Mock a minimal HTML response at a reserved-invalid URL so we don't
    // depend on the network. The content_scripts matcher is URL-based; as
    // long as the navigation commits to an https:// page, injection fires.
    await context.route('https://miden-dapp-probe.invalid/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><html><head><title>dApp Probe</title></head><body></body></html>'
      });
    });

    const dappPage = await context.newPage();

    await steps.step('open_dapp_page', async () => {
      await dappPage.goto('https://miden-dapp-probe.invalid/', {
        waitUntil: 'domcontentloaded'
      });
    });

    await steps.step('verify_midenwallet_injected', async () => {
      // contentScript.js runs at document_start and appends
      // <script src="addToWindow.js">, which asynchronously sets
      // window.midenWallet. Poll until it appears.
      await expect
        .poll(() => dappPage.evaluate(() => typeof (window as unknown as { midenWallet?: unknown }).midenWallet), {
          timeout: 15_000,
          intervals: [100, 250, 500]
        })
        .toBe('object');
    });

    await dappPage.close();
  });
});
