// Import directly from the transaction module, not through activity/index.ts.
// The activity re-export creates a circular init deadlock in the Vite SW bundle:
// init_store → init_fetchBalances → init_prices → init_store (via __esmMin async factories).
// Direct import avoids this because transaction-processor doesn't need the
// activity module's full init chain.
import { type GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import * as Repo from 'lib/miden/repo';
import {
  cancelStuckTransactions,
  getAllUncompletedTransactions,
  isQueuedRowReady,
  nextQueuedWakeDelayMs,
  safeGenerateTransactionsLoop
} from 'lib/miden/transaction';
import { isExtension } from 'lib/platform';
import { WalletMessageType } from 'lib/shared/types';

import { getAccountsWriteQueue } from './accounts-write-queue';
import { getIntercom } from './defaults';
import { clearRecoveryAuthorization } from './recovery-authorization';
import { accountsUpdated, withUnlocked } from './store';

// NOTE: `webextension-polyfill` throws at module load time when
// `globalThis.chrome?.runtime?.id` is undefined (the desktop Tauri host has
// no chrome runtime at all). This module is statically reachable from
// `mobile-adapter → actions → dapp → transaction-processor`, so a plain
// `import browser from 'webextension-polyfill'` breaks the desktop bundle
// at load time and leaves the wallet stuck on the splash screen.
//
// Fix: load the polyfill lazily and ONLY from within the functions that
// actually need it, so the rejection is caught there instead of crashing
// module init. `startTransactionProcessing` runs in the service worker and,
// off the extension, in the app realm: after an unlock (#1202) and after a
// dApp confirmation (dapp.ts startDappBackgroundProcessing). On desktop its
// getBrowser() await rejects inside the try/catch, which then runs the loop
// without alarms. The other polyfill paths are service-worker-only.
//
// Mobile does NOT hit that throw: vite.mobile.config.ts aliases
// `webextension-polyfill` to `src/lib/webextension-polyfill-mock.js`, whose
// `alarms` calls are no-ops, so the await below resolves a non-null
// `browser` there too. `browser !== null` is therefore true on both
// extension and mobile; code that must run only in the extension's service
// worker gates on `isExtension()` from `lib/platform` instead.
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
// One-shot wake for a run that ends with rows still Queued (#1223). A run stops after a fixed number of passes, a row
// its guardian backed off can come due after that, and with the popup closed nothing else restarts processing.
// Chrome fires a one-shot alarm no sooner than about 30 s out, which only delays such a row.
const QUEUED_ROW_WAKE_ALARM = 'miden-tx-queued-wake';
let isProcessing = false;
// Set when a kick arrives while a run is already in flight. A kick that lands
// after the loop's last pass but before this run clears `isProcessing` would
// otherwise be silently dropped, leaving a newly-queued tx stuck (#907).
let processingRequested = false;

/**
 * Sign callback that runs in the service worker and, off the extension, in the
 * app realm's processing loop (`startTransactionProcessing`), which an unlock
 * (#1202) or a dApp confirmation (dapp.ts startDappBackgroundProcessing) starts.
 * Re-acquires the vault on each call (same pattern as dapp.ts).
 *
 * Exported for testing. `withUnlocked` → `assertUnlocked` refuses to run the
 * factory at all once the vault is gone, throwing an explicit
 * locked-classified error, so a background Guardian consume that reaches
 * `executeTransaction`'s sign step AFTER an auto-lock nulled the vault no longer
 * produces an opaque `TypeError: Cannot read properties of null`. The guardian
 * transaction loop classifies that locked error and DEFERS the tx (leaves it
 * Queued for retry after unlock) rather than marking it Failed and losing the
 * note-claim (issue #313). This file used to carry a local `withUnlockedVault`
 * wrapper for that check; the gate now lives in `back/store.ts`, where it covers
 * every caller — including the dApp private-data readers.
 */
export async function swSignCallback(publicKey: string, signingInputs: string): Promise<Uint8Array> {
  return withUnlocked(async ({ vault }) => {
    const signatureHex = await vault.signTransaction(publicKey, signingInputs);
    return new Uint8Array(Buffer.from(signatureHex, 'hex'));
  });
}

/**
 * Vault-backed Guardian account provider for the service worker and, off the
 * extension, for the app realm's processing loop, which an unlock (#1202) or a
 * dApp confirmation (dapp.ts startDappBackgroundProcessing) starts.
 * Uses the Vault directly instead of the Zustand store.
 */
export const vaultGuardianProvider: GuardianAccountProvider = {
  prepareRecoveryTransaction: id => withUnlocked(({ vault }) => vault.prepareRecoveryTransaction(id)),
  releaseRecoveryAuthorization: async id => {
    clearRecoveryAuthorization(id);
  },
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
  signWord: async (publicKey: string, wordHex: string, transactionId?: string) => {
    return withUnlocked(async ({ vault }) => {
      return await vault.signWord(publicKey, wordHex, transactionId);
    });
  },
  persistNewHotKey: async (newHotPubKey: string, newHotCiphertext: string) => {
    return withUnlocked(async ({ vault }) => {
      await vault.persistNewHotKey(newHotPubKey, newHotCiphertext);
    });
  },
  swapHotKey: async (accountPublicKey: string, newHotPubKey: string, expectedHotPubKey?: string | null) => {
    // Fire `accountsUpdated` after the vault swap so the SW's Effector store
    // reflects the new hotPublicKey. Without this, storage is correct but the
    // Effector snapshot served via frontStore stays at the pre-rotation
    // accounts array — every popup that pulls state then sees the OLD
    // hotPublicKey, builds a MultisigService bound to it, and signWord trips
    // "Some storage item not found" against the now-removed old ciphertext.
    // SW reload masks the bug because the Effector store reinitializes from
    // storage on boot. Mirrors what Actions.swapHotKey does for the
    // intercom-driven path; we don't route through Actions.swapHotKey here
    // because importing actions.ts drags webextension-polyfill into the
    // transaction-processor's init chain.
    // On the accounts write queue for the same reason the actions-level writers
    // are: this is a read-modify-write of the whole accounts array, and a
    // concurrent one (an account create, or the detached Guardian recovery
    // clearing its flag) would drop one of the two writes.
    return withUnlocked(({ vault }) =>
      getAccountsWriteQueue().add(async () => {
        const updated = await vault.swapHotKey(accountPublicKey, newHotPubKey, expectedHotPubKey);
        accountsUpdated(updated);
      })
    );
  },
  setGuardianEndpoint: async (accountPublicKey: string, guardianEndpoint: string) => {
    // Mirror swapHotKey: persist then `accountsUpdated` so the Effector store
    // (and every popup pulling from it) reflects the new per-account endpoint.
    // Otherwise the popup keeps resolving the old guardian for this account.
    return withUnlocked(({ vault }) =>
      getAccountsWriteQueue().add(async () => {
        const updated = await vault.setGuardianEndpoint(accountPublicKey, guardianEndpoint);
        accountsUpdated(updated);
      })
    );
  }
};

/**
 * Start processing queued transactions, in the service worker and, off the
 * extension, in the app realm: after an unlock (the in-process unlock kick,
 * #1202) and after a dApp confirmation (dapp.ts startDappBackgroundProcessing).
 * One run at a time: a call made while a run is in flight starts no loop of
 * its own but is recorded and honoured with one more run when this one ends
 * (#907). navigator.locks in safeGenerateTransactionsLoop guards the loop itself.
 */
export async function startTransactionProcessing(): Promise<void> {
  if (isProcessing) {
    processingRequested = true;
    return;
  }
  isProcessing = true;

  let browser: BrowserPolyfill | null = null;
  try {
    // In the Vite SW build, the activity module's re-export of lib/miden/transaction
    // doesn't await the async transaction module init (Rolldown treats
    // `export * from '../transaction'` as synchronous). Wait up to 60s for the
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
        return;
      }
      console.log('[TransactionProcessor] transactions module ready');
    }

    try {
      browser = await getBrowser();
      // This run is the drive a pending wake was waiting for.
      browser.alarms.clear(QUEUED_ROW_WAKE_ALARM);
      browser.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 }); // ~25s
    } catch {
      // Desktop only - the import above throws there (no chrome runtime);
      // mobile's polyfill alias resolves without throwing, so it never
      // reaches this catch. The processing loop below still runs, it just
      // won't have an SW-keepalive alarm, which is fine because desktop
      // isn't a service worker.
      browser = null;
    }

    let attempts = 0;
    // Loop-pass ceiling, not a wall-clock bound: a single pass can spend a
    // minute or more (a structural op waiting out a Guardian conflict in process,
    // ~60s, or a Guardian request running to its GUARDIAN_REQUEST_TIMEOUT_MS
    // cut-off), so 60 passes is NOT "5 minutes". Terminal per-tx caps live
    // elsewhere (MAX_QUEUED_AGE / MAX_WAIT_BEFORE_CANCEL).
    const maxAttempts = 60;

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

      // Straight on only after a pass whose row left the queue or was parked, and only toward a row the loop's own
      // pick would take. A pass whose row was turned away waits, so one refusal is not followed at once by the next
      // ready row against the same Guardian, and any other pass waits so a lock held elsewhere or a queue of cooling
      // rows cannot spin through the pass ceiling.
      //
      // And only in the extension's service worker: `isExtension()`, never `browser !== null`, because the mobile
      // build's polyfill alias makes `browser` non-null there too. Every in-realm run - mobile (the mock loads) and
      // desktop (the import or the alarms calls throw) - keeps the 5 s wait after every pass, because there the
      // processor shares the WASM lock with the UI's sync and balance reads.
      const nowSec = Math.floor(Date.now() / 1000);
      if (isExtension() && result === 'processed' && remaining.some(row => isQueuedRowReady(row, nowSec))) continue;

      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  } catch (e) {
    console.error('[TransactionProcessor] Error:', e);
  } finally {
    try {
      browser?.alarms.clear(ALARM_NAME);
    } catch {
      // Best effort.
    }
    // Armed before `isProcessing` drops, so a kick landing during the read is honoured by the restart below, which
    // clears the wake, rather than starting a run this create would land behind.
    //
    // Extension-only: `isExtension()`, never `browser !== null`, because the mobile build's polyfill alias makes
    // `browser` non-null there too. Arming it there would waste a vault probe and a queue read for an alarm that's
    // a no-op off the extension's service worker.
    if (isExtension() && browser && !processingRequested) await armQueuedRowWake(browser);
    isProcessing = false;
    if (processingRequested) {
      processingRequested = false;
      void startTransactionProcessing();
    }
  }
}

/**
 * True while the vault is unlocked. Gates both arming and firing the queued-row wake (#1223): a locked vault fails
 * every row at its first step and unlocking restarts processing itself (#924), and a wake would only reap claims
 * while locked, doubling each expired auto-claim's retry backoff (#215).
 */
function isVaultUnlocked(): boolean {
  try {
    withUnlocked(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Arm the one-shot wake for the soonest Queued row, if any. Never rejects: its caller must still reset `isProcessing`. */
async function armQueuedRowWake(browser: BrowserPolyfill): Promise<void> {
  if (!isVaultUnlocked()) return;
  try {
    const delayMs = nextQueuedWakeDelayMs(await getAllUncompletedTransactions());
    if (delayMs !== undefined) browser.alarms.create(QUEUED_ROW_WAKE_ALARM, { when: Date.now() + delayMs });
  } catch (e) {
    console.warn('[TransactionProcessor] Could not arm the queued-row wake:', e);
  }
}

// Diagnostic record persisted to `chrome.storage.local` when the self-heal
// keeps failing. Read it from the SW DevTools console with
// `chrome.storage.local.get('stuckTxHealDiagnostic')`.
const STUCK_TX_HEAL_DIAGNOSTIC_KEY = 'stuckTxHealDiagnostic';
interface StuckTxHealDiagnostic {
  lastFailureAt: number;
  message: string;
  consecutiveFailures: number;
}

/**
 * Escalate a self-heal failure that survived the Dexie re-open + retry.
 *
 * A bare `console.error` is invisible without an open DevTools session, so a
 * silently-wedged heal is undiagnosable in the field. The transaction analytics
 * sink was removed (it was dead Aleo-era code), so no analytics is emitted here.
 * Escalating to a Dexie table is just as self-defeating: the heal usually fails
 * BECAUSE IndexedDB is down. Persist a small diagnostic to `chrome.storage.local`
 * instead — it works in the MV3 service worker and survives a broken IndexedDB —
 * bumping a consecutive-failure counter so a persistently-wedged heal is visible.
 * Loaded lazily via `getBrowser()` and fully swallowed on error so escalation
 * can never break the heal itself (and so non-extension bundles never touch it).
 */
async function reportHealFailure(err: unknown): Promise<void> {
  console.error('[TransactionProcessor] Stuck-tx self-heal failed:', err);
  try {
    const browser = await getBrowser();
    const previous = (await browser.storage.local.get(STUCK_TX_HEAL_DIAGNOSTIC_KEY))[STUCK_TX_HEAL_DIAGNOSTIC_KEY] as
      | StuckTxHealDiagnostic
      | undefined;
    const diagnostic: StuckTxHealDiagnostic = {
      lastFailureAt: Date.now(),
      message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1
    };
    await browser.storage.local.set({ [STUCK_TX_HEAL_DIAGNOSTIC_KEY]: diagnostic });
  } catch {
    // No `browser.storage` (non-extension bundle) or a storage write failure —
    // the console.error above remains as the fallback diagnostic surface.
  }
}

/**
 * Clear the persisted heal-failure diagnostic after a successful heal.
 *
 * `reportHealFailure` bumps `consecutiveFailures` but never resets it, so
 * without this a record persisted while the DB was down would linger forever
 * once the DB recovers — implying a wedged heal that has actually healed, and
 * turning `consecutiveFailures` into a monotonic total. Removing the key on a
 * successful heal keeps the counter truly *consecutive*. The `remove` is
 * idempotent (a no-op when nothing is stored) and fully swallowed on error so
 * clearing can never break the heal (and so non-extension bundles never touch
 * `browser.storage`).
 */
async function clearHealDiagnostic(): Promise<void> {
  try {
    const browser = await getBrowser();
    await browser.storage.local.remove(STUCK_TX_HEAL_DIAGNOSTIC_KEY);
  } catch {
    // No `browser.storage` (non-extension bundle) or a remove failure — a stale
    // record, if any, is harmless and the next failed heal re-persists a fresh one.
  }
}

/**
 * Run the stuck-transaction self-heal, recovering from a stale Dexie handle.
 *
 * An MV3 SW respawn can leave the Dexie connection closed, so the first read
 * inside `cancelStuckTransactions` rejects with `DatabaseClosedError` and,
 * without recovery, every subsequent alarm tick fails identically and the
 * heal never progresses (issue #254). Re-open the connection once and retry;
 * if that (or any other error) still fails, escalate rather than swallow.
 */
async function healStuckTransactions(): Promise<void> {
  try {
    await cancelStuckTransactions();
    // First-call success: clear any diagnostic left by earlier failed ticks.
    await clearHealDiagnostic();
  } catch (err) {
    if ((err as { name?: unknown })?.name === 'DatabaseClosedError') {
      try {
        await Repo.db.open();
        await cancelStuckTransactions();
        // Post-reopen retry success: clear any lingering diagnostic too.
        await clearHealDiagnostic();
        return;
      } catch (retryErr) {
        await reportHealFailure(retryErr);
        return;
      }
    }
    await reportHealFailure(err);
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
          // Keepalive alarm fires to keep SW alive; no action needed,
          // processing loop is running.
        } else if (alarm.name === STUCK_TX_HEAL_ALARM) {
          // Defence-in-depth self-heal: reap any orphans whose
          // processingStartedAt is past MAX_WAIT_BEFORE_CANCEL, the signed
          // comparison `isTransactionStuck` makes (a stamp ahead of the
          // clock is never reaped here). This is independent of
          // `startTransactionProcessing` so we don't depend on the SW being
          // mid-loop when an orphan ages out.
          void healStuckTransactions();
        } else if (alarm.name === QUEUED_ROW_WAKE_ALARM) {
          // The vault may have locked between arming and firing; re-probe rather than trust the arm-time check.
          if (isVaultUnlocked()) void startTransactionProcessing();
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
  // whose first action is `cancelStuckTransactions()`, so a stale
  // `GeneratingTransaction` orphan is flipped to Failed within the first
  // tick, then any newly-queued txs are picked up. A row stamped beyond the
  // threshold ahead of the clock is not one of those: only the cold-start
  // sweep, run from `browser.runtime.onStartup`, fails such a row, so a
  // respawned SW (not a genuine cold start) leaves it queued until the
  // clock catches back up to it. Combined with the bounded retry policy in
  // `initiateConsumeTransaction`, the cancel cascade documented in #216 is
  // bounded by #215's per-noteId retry cap.
  getAllUncompletedTransactions()
    .then(uncompleted => {
      if (uncompleted.length > 0) {
        console.log('[TransactionProcessor] Resuming orphaned transactions:', uncompleted.length);
        startTransactionProcessing();
      }
    })
    .catch(err => console.warn('[TransactionProcessor] Startup check error:', err));

  // Also fire a one-shot self-heal sweep at startup so an aged-out orphan
  // is reaped even when nothing else is queued. (The alarm above catches
  // the steady state; this catches the very-first SW respawn after long
  // idle, before the first alarm tick.)
  void healStuckTransactions();
}
