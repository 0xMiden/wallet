/* eslint-disable */

// Register listeners synchronously; their storage work waits for reset readiness.
self.__midenPlatformStartupReady = self.__midenPlatformStartupReady || new Promise(function (resolve, reject) {
  self.__midenPlatformStartupResolve = resolve;
  self.__midenPlatformStartupReject = reject;
});
self.__midenPlatformStartupReady.catch(function () {});

function afterPlatformStartup(callback) {
  return self.__midenPlatformStartupReady.then(function () {
    if (typeof self.__midenEnsurePlatformStartup !== 'function') throw new Error('Startup is unavailable');
    return self.__midenEnsurePlatformStartup();
  }).then(callback);
}

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    afterPlatformStartup(function () {
      return chrome.storage.local.set({ fresh_install: true }).then(function () {
        return chrome.tabs.create({ url: chrome.runtime.getURL('fullpage.html') });
      });
    }).catch(function (error) { console.warn('Install remains blocked by startup', error); });
  }
});

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === 'Popup Connection') {
    port.onDisconnect.addListener(function () {
      afterPlatformStartup(function () {
        return chrome.storage.local.set({ 'last-page-closure-timestamp': Date.now().toString() });
      }).catch(function (error) { console.warn('Closure persistence remains blocked by startup', error); });
    });
  }
});

chrome.runtime.onMessage.addListener(function () { console.debug('Ping worker'); });
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(afterPlatformStartup(function () {
    return self.clients.openWindow(chrome.runtime.getURL('fullpage.html#/receive'));
  }));
});

// Load the Vite-built background bundle as an ESM module.
import('./background.js').catch(function (error) {
  if (typeof self.__midenPlatformStartupReject === 'function') self.__midenPlatformStartupReject(error);
  console.error('Background initialization failed', error);
});
