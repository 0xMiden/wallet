// The local store update for a transaction the node already accepted (#1233), shared by every
// staged submit so the Guardian pipelines and the plain writes cannot drift apart.
//
// The store's apply is four writes (the transaction record, the account, notes, tags), and a
// failed one is often transient: an IndexedDB abort, a database closed under a version change.
// The SDK's own recovery for this error is to apply the same update again, and that has a
// deadline: the first sync covering the inclusion block locks the account and every later apply
// is refused. So retry here, in the hold that submitted, and only while the store still holds the
// account the transaction started from. Once the account write landed, a second apply archives
// the post-transaction values as the "replaced" history and corrupts what an undo restores.

import type { OutputNote } from '@miden-sdk/miden-sdk/lazy';

import { ApplyAfterSubmitError, type LandedTransaction } from './sdk-error-code';
import { splitExecutedOutputNotes } from '../activity/fee-notes';
import { toNoteTypeString } from '../helpers';
import { NoteTypeEnum } from '../types';

/** The waits before the second and the third attempt. */
export const APPLY_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

/**
 * The parts of the submitted transaction's result the helper reads: a retry reads the account id and
 * its initial header, and the error carries `id()`, the private output note count and the final
 * header's commitment.
 */
export interface SubmittedResult<Id> {
  executedTransaction(): {
    id(): { toHex(): string };
    accountId(): Id;
    initialAccountHeader(): { to_commitment(): { toHex(): string } };
    finalAccountHeader?(): { to_commitment(): { toHex(): string } };
    outputNotes(): { notes(): OutputNote[] };
  };
}

export interface ApplyAfterSubmitRetry<Id> {
  /** One store update for the submitted transaction. The SDK borrows the result, so every call applies the same one. */
  apply: () => Promise<unknown>;
  result: SubmittedResult<Id>;
  /** The transaction's account as the local store holds it, read on the client that submitted. */
  readLocalAccount: (accountId: Id) => Promise<{ to_commitment(): { toHex(): string } } | null | undefined>;
  /** False once the hold that submitted no longer owns the WASM mutex. */
  holdIsCurrent: () => boolean;
  /** Hears each failed attempt. A throw here is ignored. */
  onApplyFailed?: (error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Apply a transaction the node already accepted, retrying a failed apply while that is safe. A
 * failure that outlasts the retries rejects as `ApplyAfterSubmitError`, so the row takes its type's
 * landed verdict and is never requeued into a second submit.
 */
export async function applyAfterSubmit<Id>(options: ApplyAfterSubmitRetry<Id>): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  try {
    await options.apply();
    return;
  } catch (error) {
    lastError = error;
    report(options, error);
  }
  for (const delayMs of APPLY_RETRY_DELAYS_MS) {
    // Wait first: a transient that broke the apply can break an immediate read too, and the compare
    // belongs right before the write it guards.
    await sleep(delayMs);
    if (!(await storeHoldsInitialAccount(options))) break;
    try {
      await options.apply();
      return;
    } catch (error) {
      lastError = error;
      report(options, error);
    }
  }
  throw new ApplyAfterSubmitError(lastError, readLanded(options));
}

/**
 * Read only once every attempt failed, and only while this hold still owns the client the result is a
 * borrow of: an evicted holder never becomes current again, so a current hold means no eviction
 * happened. An evicted hold reports no facts and touches nothing.
 */
function readLanded<Id>(options: ApplyAfterSubmitRetry<Id>): LandedTransaction {
  if (!options.holdIsCurrent()) return {};
  return {
    transactionId: readTransactionId(options.result),
    privateOutputNotes: countPrivateOutputNotes(options.result),
    finalAccountCommitment: readFinalAccountCommitment(options.result)
  };
}

function report<Id>(options: ApplyAfterSubmitRetry<Id>, error: unknown): void {
  try {
    options.onApplyFailed?.(error);
  } catch {
    // A breadcrumb must never cost the landed verdict.
  }
}

function readTransactionId<Id>(result: SubmittedResult<Id>): string | undefined {
  try {
    return result.executedTransaction().id().toHex();
  } catch {
    return undefined;
  }
}

function readFinalAccountCommitment<Id>(result: SubmittedResult<Id>): string | undefined {
  try {
    return result.executedTransaction().finalAccountHeader?.().to_commitment().toHex();
  } catch {
    return undefined;
  }
}

/**
 * The private notes `completeCustomTransaction` would have relayed, counted as it picks them. The fee
 * note is set aside first, though it is always public, and a realm that has not discovered the fee
 * leaves it in, which changes nothing here.
 */
function countPrivateOutputNotes<Id>(result: SubmittedResult<Id>): number | undefined {
  try {
    const { userNotes } = splitExecutedOutputNotes(result.executedTransaction());
    return userNotes.filter(note => toNoteTypeString(note.metadata().noteType()) === NoteTypeEnum.Private).length;
  } catch {
    return undefined;
  }
}

/** Fails closed: an evicted hold, a missing or unreadable account, or any other commitment refuses. */
async function storeHoldsInitialAccount<Id>(options: ApplyAfterSubmitRetry<Id>): Promise<boolean> {
  // The wait parked, and an eviction during it hands the client to a successor.
  if (!options.holdIsCurrent()) return false;
  try {
    const executed = options.result.executedTransaction();
    const initial = executed.initialAccountHeader().to_commitment().toHex();
    const account = await options.readLocalAccount(executed.accountId());
    // The read parked, and the account is a borrow of the client this hold owns.
    if (!account || !options.holdIsCurrent()) return false;
    return account.to_commitment().toHex() === initial;
  } catch {
    return false;
  }
}
