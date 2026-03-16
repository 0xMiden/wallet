import './xhr-shim';
import 'mv3-hot-reload/background';

import browser, { tabs, runtime } from 'webextension-polyfill';

import { start } from 'lib/miden/back/main';
import { setupSyncManager } from 'lib/miden/back/sync-manager';

runtime.onInstalled.addListener(({ reason }) => (reason === 'install' ? openFullPage() : null));

runtime.onUpdateAvailable.addListener(details => {
  // Swaps in the new version immediately
  runtime.reload();
});

// Chain sync manager setup after start() to ensure Actions.init() completes first
start().then(() => setupSyncManager());

if (process.env.TARGET_BROWSER === 'safari') {
  browser.browserAction.onClicked.addListener(() => {
    openFullPage();
  });
}

browser.notifications.onClicked.addListener(notificationId => {
  browser.notifications.clear(notificationId);
  tabs.create({ url: runtime.getURL('fullpage.html#/receive') });
});

function openFullPage() {
  tabs.create({
    url: runtime.getURL('fullpage.html')
  });
}
