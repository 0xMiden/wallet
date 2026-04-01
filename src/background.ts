import './xhr-shim';
import 'mv3-hot-reload/background';

import browser, { tabs, runtime } from 'webextension-polyfill';

import { start } from 'lib/miden/back/main';
import { doSync, setupSyncManager } from 'lib/miden/back/sync-manager';
import { setupTransactionProcessor } from 'lib/miden/back/transaction-processor';

// NOTE: onInstalled is handled in sw.js (must be synchronous for MV3)

// Chrome: restore side panel preference on startup
if (process.env.TARGET_BROWSER === 'chrome') {
  const chrome = (globalThis as any).chrome;
  chrome.storage.local.get('sidepanel_mode', (result: { sidepanel_mode?: boolean }) => {
    if (result.sidepanel_mode) {
      chrome.action.setPopup({ popup: '' });
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }
  });
}

runtime.onUpdateAvailable.addListener(details => {
  // Swaps in the new version immediately
  runtime.reload();
});

// IMPORTANT: Chrome MV3 requires event listeners to be registered synchronously
// at the top level. Listeners inside async .then() callbacks miss events that
// woke the SW. doSync() independently checks vault state, so it's safe to call
// before start() completes.
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'miden-sync') {
    doSync().catch(err => console.warn('[SyncManager] Alarm sync error:', err));
  }
  // 'miden-tx-processor' alarm is just a keepalive — no action needed
});

// Chain sync manager + transaction processor setup after start() to ensure Actions.init() completes first
start().then(() => {
  setupSyncManager();
  setupTransactionProcessor();
});

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
