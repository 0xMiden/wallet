import { getAllUncompletedTransactions, hasQueuedTransactions, safeGenerateTransactionsLoop } from 'lib/miden/activity';
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
type BrowserPolyfill = typeof import('webextension-polyfill').default;
async function getBrowser(): Promise<BrowserPolyfill> {
  const mod = await import('webextension-polyfill');
  return mod.default;
}

const ALARM_NAME = 'miden-tx-processor';
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

  // Keep SW alive while processing. The polyfill is only needed
  // here — load it lazily so mobile / desktop bundles don't blow
  // up at module-evaluation time (see getBrowser comment above).
  const browser = await getBrowser();
  browser.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 }); // ~25s

  try {
    let attempts = 0;
    const maxAttempts = 60; // Max 5 minutes (60 * 5 seconds)

    while (attempts < maxAttempts) {
      attempts++;
      console.log('[TransactionProcessor] Loop attempt', attempts);
      const result = await safeGenerateTransactionsLoop(swSignCallback, false);
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
      const browser = await getBrowser();
      browser.alarms.clear(ALARM_NAME);
    } catch {
      // Non-extension context — no alarms to clear.
    }
  }
}

/**
 * Set up on SW startup: check for orphaned transactions and resume processing.
 */
export function setupTransactionProcessor(): void {
  // Listen for keepalive alarm — extension only. Lazy-load so
  // non-extension bundles never evaluate the polyfill.
  void (async () => {
    try {
      const browser = await getBrowser();
      browser.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === ALARM_NAME) {
          // Alarm fires to keep SW alive — no action needed, processing loop is running
        }
      });
    } catch {
      // Non-extension context: no alarms API, nothing to register.
    }
  })();

  // Check for orphaned transactions on startup
  hasQueuedTransactions()
    .then(hasQueued => {
      if (hasQueued) {
        console.log('[TransactionProcessor] Resuming orphaned transactions');
        startTransactionProcessing();
      }
    })
    .catch(err => console.warn('[TransactionProcessor] Startup check error:', err));
}
