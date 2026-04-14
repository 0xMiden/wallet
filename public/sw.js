/* eslint-disable */

// IMPORTANT: Register synchronous listeners BEFORE any async work.
// Chrome MV3 requires listeners to be registered in the first turn of
// the event loop or they may be missed when the SW wakes from idle.

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    chrome.storage.local.set({ 'fresh_install': true });
    chrome.tabs.create({ url: chrome.runtime.getURL('fullpage.html') });
  }
});

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name == 'Popup Connection') {
    port.onDisconnect.addListener(async function () {
      await chrome.storage.local.set({ 'last-page-closure-timestamp': Date.now().toString() });
    });
  }
});

// wake up signal
chrome.runtime.onMessage.addListener(() => {
  console.debug('Ping worker');
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.openWindow(chrome.runtime.getURL('fullpage.html#/receive')));
});

// Load the Vite-built background bundle as an ESM module.
// With "type": "module" in the manifest, import() is available.
import('./background.js');
