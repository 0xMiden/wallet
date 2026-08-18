import { TransactionResult } from '@miden-sdk/miden-sdk/lazy';
import { liveQuery } from 'dexie';

import * as Repo from 'lib/miden/repo';
import { u8ToB64 } from 'lib/shared/helpers';

import { type SignCallbackReason } from './sign-callback';
import { ITransaction, ITransactionStage, ITransactionStatus, TransactionOutput } from '../db/types';
import { getMidenClient } from '../sdk/miden-client';

/**
 * Feature flag: is the offscreen WASM client active? Read as a module constant
 * (mirroring `back/miden-client-proxy.ts`) so a flag-OFF build dead-code-
 * eliminates the flag-on branch of {@link readLastAuthReason}.
 *
 * The default is SPLIT by bundle, and the split matters HERE more than anywhere:
 * `vite.background.config.ts` defaults `MIDEN_USE_OFFSCREEN_CLIENT` to `'true'`, and
 * the service worker is the only bundle that runs `safeGenerateTransactionsLoop` on
 * the extension: all three front-side drivers check `isExtension()` first and either
 * return (`GeneratingTransaction`, `HotKeyRotationGate`) or hand off to the service
 * worker (`TransactionProgressModal`) — so it is the only bundle that ever calls
 * {@link readLastAuthReason}. On a default Chrome build the `return undefined` branch
 * below is therefore the one that executes; it is not the exotic path.
 * `vite.extension.config.ts` (popup/side panel), `vite.contentScripts.config.ts` and
 * `vite.desktop.config.ts` default it `'false'`, and `vite.mobile.config.ts` hardcodes
 * `'false'` — on mobile/desktop the loop runs front-side against the inline client,
 * which is where the flag-off branch stays live.
 */
const USE_OFFSCREEN_CLIENT = process.env.MIDEN_USE_OFFSCREEN_CLIENT === 'true';

// Re-export the sign-callback classification from its leaf home (issue #260,
// slice 5). It moved to `./sign-callback` to break a `helper ↔ proxy` import
// cycle (the offscreen write proxy needs the classifier). Re-exporting keeps
// every existing caller — `import { buildSignCallbackError, ... } from './helper'`
// / `./index` — unchanged.
export { buildSignCallbackError, buildSignCallbackOptions, type SignCallbackError } from './sign-callback';
// `SignCallbackReason` is imported locally (used in `readLastAuthReason`'s
// return type) and re-exported from that local binding to avoid naming it in
// two separate re-export statements.
export type { SignCallbackReason };

/**
 * Detect the eventually-consistent Guardian canonicalization error:
 *
 *   "Refusing to overwrite local state: incoming nonce 0 is not greater
 *    than local nonce 1 for account 0x..."
 *
 * Thrown by the WASM SDK when it's asked to sync a stale view of an account
 * the local client has already advanced past. For Guardian accounts this
 * happens because guardian canonicalization runs asynchronously after the
 * tx is accepted on-chain — by the time we try to sync, the local nonce has
 * already moved forward and the guardian's reply looks stale. The transaction
 * itself is fine; the next sync tick will reconcile. Treat as success.
 */
export function isGuardianCanonicalizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /Refusing to overwrite local state/i.test(message) || /is not greater than local nonce/i.test(message);
}

/**
 * True when `err` signals the wallet is LOCKED (its vault reference is
 * null / unavailable) rather than a genuine transaction failure. The
 * transaction loop uses this to DEFER a tx (leave it Queued) so the next
 * auto-consume cycle retries it after unlock, instead of marking it Failed.
 *
 * Two signals, mirroring `buildSignCallbackError`'s locked classification:
 *   - a `reason: 'locked'` tag (attached by `buildSignCallbackError` or by
 *     the vault-backed guardian provider's null-vault guard), or
 *   - an explicit "locked" / "not initialized" message.
 *
 * Deliberately NARROWER than `buildSignCallbackError`: it does NOT treat a
 * bare `Cannot read properties of null` TypeError as locked. That regex is
 * safe inside the sign-callback wrapper (only reached on an actual sign
 * attempt), but here it runs over EVERY `generateTransaction` failure, and
 * classifying arbitrary null-derefs as "locked" would requeue genuinely
 * broken transactions forever. The guardian provider throws an explicit
 * locked message, so this precise match is sufficient.
 */
export function isLockedError(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { reason?: unknown }).reason === 'locked') {
    return true;
  }
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /wallet is locked|vault is (?:null|locked|unavailable)|not initialized/i.test(msg);
}

/**
 * Update the status of the transaction
 * @param id The id of the transaction to update
 * @throws if the transaction has been cancelled
 */
export const updateTransactionStatus = async <K extends keyof ITransaction>(
  id: string,
  status: ITransactionStatus,
  otherValues: Pick<ITransaction, K>
) => {
  const tx = await Repo.transactions.where({ id }).first();
  if (!tx) throw new Error('No transaction found to update');
  if (tx.status === ITransactionStatus.Failed || tx.status === ITransactionStatus.Completed) {
    throw new Error('Transaction already in a finalized state');
  }

  await Repo.transactions.where({ id: id }).modify(t => {
    // Snapshot the stamps accumulated DURING the run, before the assign below
    // can overwrite them with a stale forwarded copy (see the Completed branch).
    const runStageTimestamps = t.stageTimestamps;
    Object.assign(t, otherValues);
    t.status = status;
    // Stamp the terminal stage on success. `setTransactionStage` refuses writes
    // once a row is terminal, so the trailing setTransactionStage(id,'complete')
    // in generateTransaction is a silent no-op and a SUCCESSFUL row keeps
    // whatever stage it happened to be in — a completed replace-hot-key freezes
    // at 'confirming', a completed guardian consume at 'guardian-synced'. That
    // read as "still in flight" and cost several investigations (#618).
    //
    // Unconditional, and AFTER the Object.assign so it wins: completeCustomTransaction
    // forwards `interpretTransactionResult(...)`, i.e. the whole pick-time row, so any
    // presence check on `otherValues.stage` misfires there and writes the stale
    // pick-time stage straight back. No Completed caller passes `stage` deliberately —
    // the only deliberate stage payload is requeueTransactionForRetry, which writes Queued.
    //
    // Failed rows keep their stage: there it records WHERE the failure happened
    // and is diagnostically load-bearing (GeneratingTransaction reads it to pin
    // the failed step).
    if (status === ITransactionStatus.Completed) {
      t.stage = 'complete';
      // Restore the run's stamps, for the same reason the stage write above is
      // unconditional: completeCustomTransaction forwards
      // `interpretTransactionResult(...)`, i.e. the whole row as picked at loop
      // time — which predates every stamp `setTransactionStage` wrote during the
      // run, so the assign above would hand back an empty set and every step
      // would render without a duration (#524). No Completed caller supplies
      // stamps deliberately; the only deliberate payload is
      // requeueTransactionForRetry, and that writes Queued, not Completed.
      if (runStageTimestamps) t.stageTimestamps = runStageTimestamps;
      // The same write also closes the LAST processing step: its span runs to the
      // synthetic `complete` boundary, since no following stage exists to end it.
      if (!t.stageTimestamps) t.stageTimestamps = {};
      if (t.stageTimestamps.complete === undefined) t.stageTimestamps.complete = Date.now();
    }
  });
};

/**
 * Informational stage write. Called at phase boundaries inside
 * `generateTransaction` / `completeSendTransaction` so the progress modal
 * can show "Syncing" / "Sending" / "Confirming" / "Delivering" instead of
 * a single opaque "Generating transaction". Does not gate on status —
 * late writes after a terminal status are no-ops via the `.modify` callback.
 *
 * That terminal guard is load-bearing, NOT a formality: a Failed row's stage
 * records WHERE it failed and `GeneratingTransaction` reads it to pin the failed
 * step, so a late write would erase the failure location. Completed rows are
 * stamped `'complete'` by `updateTransactionStatus` itself (#618), which is why
 * this function stays the pre-terminal writer.
 */
export const setTransactionStage = async (
  id: string,
  stage: ITransactionStage,
  opts?: { readonly timingOnly?: boolean }
) => {
  await Repo.transactions.where({ id }).modify(tx => {
    if (tx.status !== ITransactionStatus.Completed && tx.status !== ITransactionStatus.Failed) {
      // `tx.stage` is CONTROL state, `tx.stageTimestamps` is TELEMETRY, and the two
      // are written together only when the writer is reliable and in-order.
      //
      // Two funds-safety gates in `transaction/index.ts` read `tx.stage` to decide a
      // failed guardian tx is PRE-submit and may therefore be auto-requeued — "submit
      // is stamped 'submitting' and runs only AFTER prove, so nothing reached the
      // chain". That inference is only sound if every writer of `stage` is ordered
      // with respect to the work it describes.
      //
      // A stamp replayed from the OFFSCREEN realm is not: it crosses `chrome.runtime`
      // fire-and-forget, with no delivery or ordering guarantee against the op's own
      // reply. A dropped or late `submitting` would leave the row reading `proving`
      // after submit had actually run, and the requeue gate would re-submit a
      // transaction that may already be on chain. So cross-realm stamps record the
      // boundary for the progress screen and leave `stage` alone — the service
      // worker's own in-order writes remain its only author.
      if (!opts?.timingOnly) tx.stage = stage;
      // Record the first time this stage was entered so the UI can compute
      // per-step durations from persisted stamps (see ITransaction.stageTimestamps).
      // First-entry-wins: a stage re-set on requeue keeps its original boundary.
      if (!tx.stageTimestamps) tx.stageTimestamps = {};
      if (tx.stageTimestamps[stage] === undefined) tx.stageTimestamps[stage] = Date.now();
    }
  });
};

/**
 * Reads the last sign-callback failure reason (`locked` / `rejected` / …) from
 * the SW-inline WASM client, used by the transaction loop to DEFER a
 * locked-mid-sign tx instead of Failing it (issue #313 note-loss guard).
 *
 * Invariant (issue #260 flip-prep #2): consult the SW client's `lastAuthError()`
 * IFF the SW client actually did the sign — i.e. the FLAG-OFF (inline) write path.
 * Under the flag-ON offscreen write the sign runs in the OFFSCREEN realm and the
 * SDK captures the error on the OFFSCREEN client; the SW-inline client NEVER
 * signed for that op, so its `lastAuthError()` is stale / another op's. Deferring
 * a genuinely-failed offscreen write on that stale slot would leave it Queued
 * FOREVER (never Failed). So under flag-on this returns `undefined` and the loop
 * relies solely on the op-keyed error tag (`isLockedError(e)`, set by
 * `dispatchOffscreenWrite` when the reverse-IPC sign reported 'locked').
 *
 * Flag-OFF is byte-identical to before: `USE_OFFSCREEN_CLIENT` is false, the
 * guard below dead-code-eliminates, and this reads the SW client exactly as it
 * always has.
 */
export async function readLastAuthReason(): Promise<SignCallbackReason | undefined> {
  // Flag-on: the offscreen realm signed, not this SW client — its lastAuthError()
  // is not authoritative for the failing op. The locked signal (if any) rides the
  // op-keyed error tag instead.
  if (USE_OFFSCREEN_CLIENT) return undefined;
  try {
    const midenClient = await getMidenClient();
    const rawClient = (midenClient as any).client;
    if (!rawClient || typeof rawClient.lastAuthError !== 'function') return undefined;
    const raw = rawClient.lastAuthError();
    if (!raw || typeof raw !== 'object') return undefined;
    const reason = (raw as { reason?: unknown }).reason;
    if (reason === 'locked' || reason === 'rejected' || reason === 'not_found' || reason === 'internal') {
      return reason;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Timeout for waiting on consume transactions (5 minutes)
const WAIT_FOR_CONSUME_TX_TIMEOUT = 5 * 60_000;

export const waitForConsumeTx = async (id: string, signal?: AbortSignal): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    let subscription: { unsubscribe: () => void } | null = null;

    const timeoutId = setTimeout(() => {
      subscription?.unsubscribe();
      reject(new Error('Transaction timed out. Please try again.'));
    }, WAIT_FOR_CONSUME_TX_TIMEOUT);

    const cleanup = () => {
      clearTimeout(timeoutId);
      subscription?.unsubscribe();
    };

    subscription = liveQuery(() => Repo.transactions.where({ id }).first()).subscribe(tx => {
      if (!tx) {
        cleanup();
        reject(new Error('Transaction not found'));
        return;
      }

      if (tx.status === ITransactionStatus.Completed) {
        cleanup();
        resolve(tx.transactionId!);
      } else if (tx.status === ITransactionStatus.Failed) {
        cleanup();
        reject(new Error('Consume transaction failed'));
      }
    });

    signal?.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
};

const WAIT_FOR_TX_TIMEOUT = 5 * 60_000; // 5 minutes

export const waitForTransactionCompletion = async (transactionId: string) => {
  return new Promise<TransactionOutput>(resolve => {
    let subscription: { unsubscribe: () => void } | null = null;

    const timeoutId = setTimeout(() => {
      subscription?.unsubscribe();
      resolve({ errorMessage: 'Transaction timed out' });
    }, WAIT_FOR_TX_TIMEOUT);

    const cleanup = () => {
      clearTimeout(timeoutId);
      subscription?.unsubscribe();
    };

    subscription = liveQuery(() => Repo.transactions.where({ id: transactionId }).first()).subscribe({
      next: tx => {
        if (!tx) {
          // Transaction not found - resolve with error
          cleanup();
          resolve({ errorMessage: 'Transaction not found' });
          return;
        }

        if (tx.status === ITransactionStatus.Completed) {
          cleanup();
          const txResult = TransactionResult.deserialize(tx.resultBytes!);
          const res = {
            txHash: tx.transactionId!,
            outputNotes: txResult
              .executedTransaction()
              .outputNotes()
              .notes()
              .map(no => no.intoFull())
              .filter(no => !!no)
              .map(fullNote => u8ToB64(fullNote.serialize()))
          };
          resolve(res);
        } else if (tx.status === ITransactionStatus.Failed) {
          cleanup();
          resolve({ errorMessage: tx.error || 'Transaction failed' });
        }
      },
      error: err => {
        cleanup();
        resolve({ errorMessage: err?.message || 'Subscription error' });
      }
    });
  });
};
