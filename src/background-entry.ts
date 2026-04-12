/**
 * ESM service worker entry point.
 *
 * MV3 requires event listeners to be registered synchronously at the top level.
 * ESM `import` statements are hoisted and evaluated before any other code, so
 * if we put listeners in the same file as WASM-loading imports, the listener
 * registration would be delayed until WASM finishes compiling.
 *
 * Solution: this file registers all synchronous listeners FIRST, then
 * dynamically imports the main background module (which loads WASM).
 */

// ── Synchronous MV3 listeners (registered before any WASM loading) ──────────

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({ fresh_install: true });
    chrome.tabs.create({ url: chrome.runtime.getURL('fullpage.html') });
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'Popup Connection') {
    port.onDisconnect.addListener(async () => {
      await chrome.storage.local.set({
        'last-page-closure-timestamp': Date.now().toString(),
      });
    });
  }
});

// Wake-up signal keepalive
chrome.runtime.onMessage.addListener(() => {
  console.debug('Ping worker');
});

// Handle notification clicks (fallback notification path)
self.addEventListener('notificationclick', (event: any) => {
  event.notification.close();
  event.waitUntil(
    (self as any).clients.openWindow(chrome.runtime.getURL('fullpage.html#/receive'))
  );
});

// ── Now load the main background module ──
// Static import: ESM evaluates imports before the module body, but with
// inlineDynamicImports the entire dependency tree is in one file, so the
// listener registrations above already ran before this import triggers.
import './background';
