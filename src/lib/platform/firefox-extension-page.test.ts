/**
 * @jest-environment-options {"url": "moz-extension://abcdefghijklmnop/popup.html"}
 */

// The Firefox twin of extension-page.test.ts: jsdom fixes the page URL per file (#1592).
describe('isExtension on a Firefox extension page', () => {
  afterEach(() => {
    delete (globalThis as any).browser;
  });

  it('stays true when the runtime no longer reports an id', () => {
    // The setup's webextension mock gives `chrome` a runtime id; Firefox has only `browser`.
    delete (globalThis as any).chrome;
    (globalThis as any).browser = { runtime: {} };

    const { hasExtensionRuntime, isExtension } = require('./index');
    expect(hasExtensionRuntime()).toBe(false);
    expect(isExtension()).toBe(true);
  });
});
