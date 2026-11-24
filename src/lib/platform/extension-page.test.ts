/**
 * @jest-environment-options {"url": "chrome-extension://abcdefghijklmnop/popup.html"}
 */

// An extension reload or update orphans an open extension page: its runtime.id reads undefined from then on, while
// the page keeps its extension URL (#1592).
describe('isExtension on an extension page', () => {
  afterEach(() => {
    delete (globalThis as any).browser;
    delete (globalThis as any).chrome;
  });

  it('stays true when the runtime no longer reports an id', () => {
    (globalThis as any).chrome = { runtime: {} };

    const { isExtension } = require('./index');
    expect(isExtension()).toBe(true);
  });

  it('stays true with no extension namespace at all', () => {
    const { isExtension } = require('./index');
    expect(isExtension()).toBe(true);
  });
});
