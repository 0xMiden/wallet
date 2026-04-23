// Import directly from the transactions module, not through activity/index.ts.
// The activity re-export creates a circular init deadlock in the Vite SW bundle:
// init_store → init_fetchBalances → init_prices → init_store (via __esmMin async factories).
// Direct import avoids this because transaction-processor doesn't need the
// activity module's full init chain.
import {
  getAllUncompletedTransactions,
  hasQueuedTransactions,
  safeGenerateTransactionsLoop
} from 'lib/miden/activity/transactions';
import { type GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
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
 * Vault-backed Guardian account provider for service worker context.
 * Uses the Vault directly instead of the Zustand store.
 */
const vaultGuardianProvider: GuardianAccountProvider = {
  getAccounts: async () => {
    return withUnlocked(async ({ vault }) => {
      return await vault.fetchAccounts();
    });
  },
  getPublicKeyForCommitment: async (commitment: string) => {
    return withUnlocked(async ({ vault }) => {
      return await vault.getPublicKeyForCommitment(commitment);
    });
  },
  signWord: async (publicKey: string, wordHex: string) => {
    return withUnlocked(async ({ vault }) => {
      return await vault.signWord(publicKey, wordHex);
    });
  }
};

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
      const result = await safeGenerateTransactionsLoop(swSignCallback, false, vaultGuardianProvider);
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
  // Listen for keepalive alarm — extension only. Lazy-load so
  // non-extension bundles never evaluate the polyfill.
  void (async () => {
    try {
      const browser = await getBrowser();
      browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
        if (alarm.name === ALARM_NAME) {
          // Alarm fires to keep SW alive — no action needed, processing loop is running
        }
      });
    } catch {
      /* c8 ignore start */
      // Non-extension context: no alarms API, nothing to register.
    } /* c8 ignore stop */
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
