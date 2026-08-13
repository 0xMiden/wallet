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
(window as any).chrome.runtime.connect({
  name: 'Popup Connection'
});

// Set immediately, and then every x seconds
if (getOpenedMidenPagesN() > 0) {
  await updateClosureTimestamp();
}
setInterval(async () => {
  if (getOpenedMidenPagesN() > 0) {
    await browser.runtime.sendMessage('wakeup');
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
