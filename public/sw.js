/* eslint-disable */

// IMPORTANT: Register onInstalled BEFORE importScripts so it fires synchronously.
// Webpack's async module loading in background.js can delay listener registration,
// causing Chrome MV3 to miss the install event.
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    chrome.storage.local.set({ 'fresh_install': true });
    chrome.tabs.create({ url: chrome.runtime.getURL('fullpage.html') });
  }
});

try {
  const window = globalThis;
  // This is the file produced by webpack
  importScripts('background.js');

  window.chrome.runtime.onConnect.addListener(function (port) {
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

  // Handle clicks on self.registration.showNotification() (fallback notification path)
  self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(clients.openWindow(chrome.runtime.getURL('fullpage.html#/receive')));
  });
} catch (e) {
  // This will allow you to see error logs during registration/execution
  console.error(e);
}
