import { TransactionResult } from '@miden-sdk/miden-sdk/lazy';
import { liveQuery } from 'dexie';

import * as Repo from 'lib/miden/repo';
import { u8ToB64 } from 'lib/shared/helpers';

import { ITransaction, ITransactionStage, ITransactionStatus, TransactionOutput } from '../db/types';
import { getMidenClient } from '../sdk/miden-client';

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
 * Stable tags attached to errors the sign callback throws, so the catch
 * site for a failed executeTransaction can pattern-match on the raw
 * thrown value (recovered via `midenClient.lastAuthError()`) and treat
 * each failure mode differently — e.g. retry a `locked` failure after
 * the wallet unlocks instead of marking the tx permanently Failed.
 */
export type SignCallbackReason = 'locked' | 'rejected' | 'not_found' | 'internal';

export interface SignCallbackError extends Error {
  reason: SignCallbackReason;
}

/**
 * Wrap an underlying sign failure in a typed Error that the SDK will
 * capture verbatim (see `WebClient.lastAuthError`). Classifies by
 * inspecting the underlying error's shape — current signals are the
 * Zustand-store locked state (string "Not initialized" from
 * `assertInited`) and generic TypeError for null-vault access.
 */
export function buildSignCallbackError(err: unknown): SignCallbackError {
  const underlying = err instanceof Error ? err : new Error(String(err));
  let reason: SignCallbackReason = 'internal';
  const msg = underlying.message || '';
  if (/not initialized|locked|vault.*null|Cannot read propert/i.test(msg)) {
    reason = 'locked';
  }
  const wrapped = Object.assign(new Error(`Sign callback failed (${reason}): ${msg}`), {
    reason,
    cause: underlying
  }) as SignCallbackError;
  return wrapped;
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
 * Reads the SDK-captured last auth error and extracts a `reason` tag if
 * present. Returns undefined if there was no auth failure or the thrown
 * value didn't carry a reason.
 */
export async function readLastAuthReason(): Promise<SignCallbackReason | undefined> {
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
