import browser from 'webextension-polyfill';

import { CHECK_PAGES_EXIST, WALLET_AUTOLOCK_TIME } from 'lib/fixed-times';
import { assertResponse, request } from 'lib/miden/front';
import { WalletMessageType } from 'lib/shared/types';

import { getIsLockUpEnabled } from './index';

const CLOSURE_STORAGE_KEY = 'last-page-closure-timestamp';

const isSinglePageOpened = () => getOpenedMidenPagesN() === 1;

export const needsLocking = async () => {
  if (!getIsLockUpEnabled() || !isSinglePageOpened()) return false;
  // This check is the wallet's only idle lock, so a closure time it cannot read counts as expired.
  const lastClosedTime = await getLastClosedTimeOrNow().catch(err => {
    console.warn('[lock-up] Could not read the closure time; locking:', err);
    return -Infinity;
  });
  return Date.now() - lastClosedTime >= WALLET_AUTOLOCK_TIME;
};

/**
 * Locks the wallet when this page is the first to open after the auto-lock time, or when the closure time cannot be
 * read or is not a number, then keeps the closure timestamp fresh while any wallet page is open. A failed storage
 * read or write, or a failed lock request, never rejects it: the popup, side panel and options pages await it before
 * they render.
 */
export async function runLockUpChecks(): Promise<void> {
  if (await needsLocking()) {
    lock().catch(err => console.warn('[lock-up] Auto-lock request failed:', err));
  }

  // Establish background connection. sw.js will update timestamp on close
  const popupPort = chrome.runtime.connect({ name: 'Popup Connection' });
  // Read the error on disconnect. Without a listener that touches it, a connect
  // that finds no receiving end (service worker still starting, or the context
  // orphaned by an extension reload) leaves `runtime.lastError` unread, and
  // Chrome logs "Unchecked runtime.lastError: Could not establish connection".
  // This port is fire-and-forget by design - the service worker only uses its
  // disconnect to timestamp closure - so there is nothing to retry here.
  popupPort.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
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
        // uncaught rejection every 10s for the life of the page - and skipped
        // the timestamp update below, which is the part that actually matters.
        await browser.runtime.sendMessage('wakeup');
      } catch {
        // fall through to the timestamp update
      }
      await updateClosureTimestamp();
    }
  }, CHECK_PAGES_EXIST);
}

function getOpenedMidenPagesN() {
  return browser.extension.getViews().length;
}

async function getLastClosedTimeOrNow(): Promise<number> {
  const stored: unknown = (await browser.storage.local.get(CLOSURE_STORAGE_KEY))[CLOSURE_STORAGE_KEY];
  // A missing key is a fresh install, which never locks.
  if (stored === undefined || stored === null) return Date.now();
  const lastClosedTime = Number(stored);
  if (!Number.isFinite(lastClosedTime)) {
    console.warn('[lock-up] The closure time is not a number; locking:', stored);
    return -Infinity;
  }
  return lastClosedTime;
}

async function updateClosureTimestamp() {
  try {
    await browser.storage.local.set({ [CLOSURE_STORAGE_KEY]: Date.now().toString() });
  } catch {
    // the next tick writes it again
  }
}

async function lock() {
  const res = await request({
    type: WalletMessageType.LockRequest
  });
  assertResponse(res.type === WalletMessageType.LockResponse);
}
