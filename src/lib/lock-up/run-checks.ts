import browser from 'webextension-polyfill';

import { CHECK_PAGES_EXIST, WALLET_AUTOLOCK_TIME } from 'lib/fixed-times';
import { assertResponse, request } from 'lib/miden/front';
import { WalletMessageType } from 'lib/shared/types';

import { getIsLockUpEnabled } from './index';

if (window.location.href.includes('extension://') === false)
  throw new Error('Lock-up checks are meant for extension pages only.');

const CLOSURE_STORAGE_KEY = 'last-page-closure-timestamp';

const isSinglePageOpened = () => getOpenedMidenPagesN() === 1;

export const needsLocking = async () => {
  return (
    getIsLockUpEnabled() &&
    isSinglePageOpened() &&
    Date.now() - (await getLastClosedTimeOrNow()) >= WALLET_AUTOLOCK_TIME
  );
};

// Locking if this page was first to open & lock time passed
if (await needsLocking()) {
  lock();
}

// Establish background connection. sw.js will update timestamp on close
const popupPort = (window as any).chrome.runtime.connect({
  name: 'Popup Connection'
});
// Read the error on disconnect. Without a listener that touches it, a connect
// that finds no receiving end (service worker still starting, or the context
// orphaned by an extension reload) leaves `runtime.lastError` unread, and
// Chrome logs "Unchecked runtime.lastError: Could not establish connection".
// This port is fire-and-forget by design — the service worker only uses its
// disconnect to timestamp closure — so there is nothing to retry here.
popupPort.onDisconnect.addListener(() => {
  void (window as any).chrome.runtime.lastError;
});

// Set immediately, and then every x seconds
if (getOpenedMidenPagesN() > 0) {
  await updateClosureTimestamp();
}
setInterval(async () => {
  if (getOpenedMidenPagesN() > 0) {
    try {
      // Waking the service worker is best-effort. Unguarded, a reject here
      // (worker still starting, or context orphaned by a reload) became an
      // uncaught rejection every 10s for the life of the page — and skipped
      // the timestamp update below, which is the part that actually matters.
      await browser.runtime.sendMessage('wakeup');
    } catch {
      // fall through to the timestamp update
    }
    await updateClosureTimestamp();
  }
}, CHECK_PAGES_EXIST);

function getOpenedMidenPagesN() {
  return browser.extension.getViews().length;
}

async function getLastClosedTimeOrNow(): Promise<number> {
  return Number((await browser.storage.local.get(CLOSURE_STORAGE_KEY))[CLOSURE_STORAGE_KEY] ?? Date.now());
}

async function updateClosureTimestamp() {
  await browser.storage.local.set({ 'last-page-closure-timestamp': Date.now().toString() });
}

async function lock() {
  const res = await request({
    type: WalletMessageType.LockRequest
  });
  assertResponse(res.type === WalletMessageType.LockResponse);
}
