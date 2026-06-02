// Import directly from the transactions module, not through activity/index.ts.
// The activity re-export creates a circular init deadlock in the Vite SW bundle:
// init_store → init_fetchBalances → init_prices → init_store (via __esmMin async factories).
// Direct import avoids this because transaction-processor doesn't need the
// activity module's full init chain.
import {
  cancelStuckTransactions,
  getAllUncompletedTransactions,
  safeGenerateTransactionsLoop
} from 'lib/miden/activity/transactions';
import { WalletMessageType } from 'lib/shared/types';

import { getIntercom } from './defaults';
import { withUnlocked } from './store';

// NOTE: `webextension-polyfill` throws at module load time when
// `globalThis.chrome?.runtime?.id` is undefined (non-extension
// context like a mobile WebView or the desktop Tauri host). This
// module is statically reachable from `mobile-adapter → actions →
// dapp → transaction-processor`, so a plain `import browser from
// 'webextension-polyfill'` breaks the mobile bundle at load time
// and leaves the wallet stuck on the splash screen.
//
// Fix: load the polyfill lazily and ONLY from within the functions
// that actually need it. Those functions are service-worker-only
// code paths that never run on mobile / desktop, so the await
// never happens outside the extension build.
type BrowserPolyfill = typeof import('webextension-polyfill');
async function getBrowser(): Promise<BrowserPolyfill> {
  const mod = await import('webextension-polyfill');
  // The polyfill ships as a CJS module with a namespace-default
  // export; at runtime both `mod.default` (when bundled as ESM) and
  // `mod` itself (direct import) are the same browser-API object.
  /* c8 ignore start */ return (mod as { default?: BrowserPolyfill }).default ?? mod; /* c8 ignore stop */
}

const ALARM_NAME = 'miden-tx-processor';
// Defence-in-depth self-heal alarm. Fires at a cadence comfortably past
// `MAX_WAIT_BEFORE_CANCEL` (30 min) so that any orphan transaction left
// in `GeneratingTransaction` after the SW dies mid-call is reaped within
// at most ~one alarm period after the SW respawns. The setupTransactionProcessor
// startup gate also catches orphans, but the alarm closes the corner case
// where the SW respawns for an unrelated reason (sync, dApp request, etc.)
// and never observes the orphan via that startup hook.
const STUCK_TX_HEAL_ALARM = 'miden-tx-stuck-heal';
const STUCK_TX_HEAL_PERIOD_MIN = 5;
let isProcessing = false;

/**
 * Sign callback that runs in the service worker.
 * Re-acquires the vault on each call (same pattern as dapp.ts).
 */
async function swSignCallback(publicKey: string, signingInputs: string): Promise<Uint8Array> {
  return withUnlocked(async ({ vault }) => {
    const signatureHex = await vault.signTransaction(publicKey, signingInputs);
    return new Uint8Array(Buffer.from(signatureHex, 'hex'));
  });
}

/**
 * Start processing queued transactions in the service worker.
 * Deduplicates via isProcessing flag + navigator.locks in safeGenerateTransactionsLoop.
 */
export async function startTransactionProcessing(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  // In the Vite SW build, the activity module's re-export of transactions.ts
  // doesn't await the async transactions module init (Rolldown treats
  // `export * from './transactions'` as synchronous). Wait up to 60s for the
  // function to become available. The init chain is:
  // init_transactions → init_store (Zustand) → init_front → various frontend inits
  // This may take time as module factories resolve asynchronously.
  if (typeof safeGenerateTransactionsLoop !== 'function') {
    console.log('[TransactionProcessor] Waiting for transactions module init...');
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (typeof safeGenerateTransactionsLoop === 'function') break;
    }
    if (typeof safeGenerateTransactionsLoop !== 'function') {
      console.error('[TransactionProcessor] safeGenerateTransactionsLoop still not available after 60s');
      isProcessing = false;
      return;
    }
    console.log('[TransactionProcessor] transactions module ready');
  }

  let browser: BrowserPolyfill | null = null;
  try {
    try {
      browser = await getBrowser();
      browser.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 }); // ~25s
    } catch {
      // Non-extension context (mobile / desktop) — no alarms API.
      // The processing loop below still runs, it just won't have an
      // SW-keepalive alarm, which is fine because mobile / desktop
      // aren't service workers.
      browser = null;
    }

    let attempts = 0;
    const maxAttempts = 60; // Max 5 minutes (60 * 5 seconds)

    while (attempts < maxAttempts) {
      attempts++;
      console.log('[TransactionProcessor] Loop attempt', attempts);
      const result = await safeGenerateTransactionsLoop(swSignCallback);
      console.log('[TransactionProcessor] Loop result:', result);

      // Broadcast progress so popup UI can update
      try {
        getIntercom()!.broadcast({ type: WalletMessageType.SyncCompleted });
      } catch {
        // No frontends connected
      }

      const remaining = await getAllUncompletedTransactions();
      if (remaining.length === 0) break;

      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  } catch (e) {
    console.error('[TransactionProcessor] Error:', e);
  } finally {
    isProcessing = false;
    try {
      browser?.alarms.clear(ALARM_NAME);
    } catch {
      // Best effort.
    }
  }
}

/**
 * Set up on SW startup: check for orphaned transactions and resume processing.
 */
export function setupTransactionProcessor(): void {
  // Register alarm listeners and the standalone self-heal alarm — extension
  // only. Lazy-load so non-extension bundles never evaluate the polyfill.
  void (async () => {
    try {
      const browser = await getBrowser();
      browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
        if (alarm.name === ALARM_NAME) {
          // Keepalive alarm fires to keep SW alive — no action needed,
          // processing loop is running.
        } else if (alarm.name === STUCK_TX_HEAL_ALARM) {
          // Defence-in-depth self-heal: reap any orphans whose
          // processingStartedAt is past MAX_WAIT_BEFORE_CANCEL. This is
          // independent of `startTransactionProcessing` so we don't depend
          // on the SW being mid-loop when an orphan ages out.
          cancelStuckTransactions().catch(err =>
            console.warn('[TransactionProcessor] Stuck-tx heal alarm error:', err)
          );
        }
      });
      // Long-period self-heal alarm. Chrome MV3 clamps periodInMinutes to
      // a 1-minute floor in production, but our value is well above that
      // so no clamping kicks in.
      browser.alarms.create(STUCK_TX_HEAL_ALARM, { periodInMinutes: STUCK_TX_HEAL_PERIOD_MIN });
    } catch {
      /* c8 ignore start */
      // Non-extension context: no alarms API, nothing to register.
    } /* c8 ignore stop */
  })();

  // Check for orphaned transactions on startup. Use
  // `getAllUncompletedTransactions` (which includes BOTH `Queued` and
  // `GeneratingTransaction`) so that an SW death mid-`generateTransaction`
  // is recovered the next time the SW spawns. The previous gate used
  // `hasQueuedTransactions` (Queued-only), which left
  // `GeneratingTransaction` orphans invisible to startup recovery — they
  // could only be reaped by a user-initiated transaction nudging the
  // processor loop, sometimes hours later (issue #216).
  //
  // Note: `startTransactionProcessing` calls `safeGenerateTransactionsLoop`,
  // whose first action is `cancelStuckTransactions()` — so a stale
  // `GeneratingTransaction` orphan is flipped to Failed within the first
  // tick, then any newly-queued txs are picked up. Combined with the
  // bounded retry policy in `initiateConsumeTransaction`, the cancel
  // cascade documented in #216 is bounded by #215's per-noteId retry cap.
  getAllUncompletedTransactions()
    .then(uncompleted => {
      if (uncompleted.length > 0) {
        console.log('[TransactionProcessor] Resuming orphaned transactions:', uncompleted.length);
        startTransactionProcessing();
      }
    })
    .catch(err => console.warn('[TransactionProcessor] Startup check error:', err));

  // Also fire a one-shot self-heal sweep at startup so an aged-out
  // orphan is reaped even when nothing else is queued. (The alarm above
  // catches the steady state; this catches the very-first SW respawn
  // after long idle, before the first alarm tick.)
  cancelStuckTransactions().catch(err => console.warn('[TransactionProcessor] Startup heal error:', err));
}
