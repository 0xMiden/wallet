import browser from 'webextension-polyfill';

import { getAllUncompletedTransactions, hasQueuedTransactions, safeGenerateTransactionsLoop } from 'lib/miden/activity';
import { WalletMessageType } from 'lib/shared/types';

import { getIntercom } from './defaults';
import { withUnlocked } from './store';

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

  // Keep SW alive while processing
  browser.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 }); // ~25s

  try {
    let attempts = 0;
    const maxAttempts = 60; // Max 5 minutes (60 * 5 seconds)

    while (attempts < maxAttempts) {
      attempts++;
      await safeGenerateTransactionsLoop(swSignCallback, false);

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
    browser.alarms.clear(ALARM_NAME);
  }
}

/**
 * Set up on SW startup: check for orphaned transactions and resume processing.
 */
export function setupTransactionProcessor(): void {
  // Listen for keepalive alarm
  browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM_NAME) {
      // Alarm fires to keep SW alive — no action needed, processing loop is running
    }
  });

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
