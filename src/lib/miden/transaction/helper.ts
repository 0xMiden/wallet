import { TransactionResult } from '@miden-sdk/miden-sdk/lazy';
import { liveQuery } from 'dexie';

import * as Repo from 'lib/miden/repo';
import { u8ToB64 } from 'lib/shared/helpers';

import { takeLastSignReason, type SignCallbackReason } from './sign-callback';
import { ITransaction, ITransactionStage, ITransactionStatus, TransactionOutput } from '../db/types';
import { getMidenClient } from '../sdk/miden-client';

// Re-export the sign-callback classification from its leaf home (issue #260,
// slice 5). It moved to `./sign-callback` to break a `helper ↔ proxy` import
// cycle (the offscreen write proxy needs the classifier + `readLastAuthReason`
// needs the SW-side reason slot). Re-exporting keeps every existing caller —
// `import { buildSignCallbackError, ... } from './helper'` / `./index` —
// unchanged.
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
    Object.assign(t, otherValues);
    t.status = status;
  });
};

/**
 * Informational stage write. Called at phase boundaries inside
 * `generateTransaction` / `completeSendTransaction` so the progress modal
 * can show "Syncing" / "Sending" / "Confirming" / "Delivering" instead of
 * a single opaque "Generating transaction". Does not gate on status —
 * late writes after `Completed` are no-ops via the `.modify` callback
 * (the stage field is informational and only read while status is
 * pre-terminal).
 */
export const setTransactionStage = async (id: string, stage: ITransactionStage) => {
  await Repo.transactions.where({ id }).modify(tx => {
    if (tx.status !== ITransactionStatus.Completed && tx.status !== ITransactionStatus.Failed) {
      tx.stage = stage;
    }
  });
};

/**
 * Reads the last sign-callback failure reason (`locked` / `rejected` / …), used
 * by the transaction loop to DEFER a locked-mid-sign tx instead of Failing it
 * (issue #313 note-loss guard).
 *
 * Two sources, checked in order:
 *  1. The SW-side reason slot (issue #260, slice 5). When the flag-on offscreen
 *     write signs via reverse-IPC, the sign runs on the SW but the SDK captures
 *     the error on the OFFSCREEN client — so the SW-inline client's
 *     `lastAuthError()` would miss it. The reverse-IPC handler records the
 *     classified reason into `sign-callback.ts`'s slot; take-and-clear it here so
 *     it is scoped to exactly the op that just failed and can never bleed into a
 *     later op. On flag-off nothing ever records into the slot, so this is
 *     `undefined` and we fall straight through — byte-identical to today.
 *  2. The SW-inline client's `lastAuthError()` — the original path, still
 *     authoritative for the write methods that remain SW-inline under flag-on
 *     (send / swap / newTransaction in slice 5a) and for the whole flag-off world.
 */
export async function readLastAuthReason(): Promise<SignCallbackReason | undefined> {
  const offscreenSignReason = takeLastSignReason();
  if (offscreenSignReason) return offscreenSignReason;
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
