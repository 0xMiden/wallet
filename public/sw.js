/* eslint-disable */

// IMPORTANT: Register onInstalled BEFORE importScripts so it fires synchronously.
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    chrome.storage.local.set({ 'fresh_install': true });
    chrome.tabs.create({ url: chrome.runtime.getURL('fullpage.html') });
  }
});

try {
  // Load the Vite-built background bundle. With inlineDynamicImports,
  // everything is in a single file with no import/export statements,
  // so importScripts() works fine.
  importScripts('background.js');

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
} catch (e) {
  console.error('[sw.js] Error loading background.js:', e);
}
