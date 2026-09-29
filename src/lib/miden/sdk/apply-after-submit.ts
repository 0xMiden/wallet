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

import { ApplyAfterSubmitError } from './sdk-error-code';

/** The waits before the second and the third attempt. */
export const APPLY_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

/** The parts of the submitted transaction's result a retry reads. */
export interface SubmittedResult<Id> {
  executedTransaction(): {
    id(): { toHex(): string };
    accountId(): Id;
    initialAccountHeader(): { to_commitment(): { toHex(): string } };
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
    if (!(await storeHoldsInitialAccount(options))) break;
    await sleep(delayMs);
    // The wait parked, and an eviction during it hands the client to a successor.
    if (!options.holdIsCurrent()) break;
    try {
      await options.apply();
      return;
    } catch (error) {
      lastError = error;
      report(options, error);
    }
  }
  throw new ApplyAfterSubmitError(lastError);
}

function report<Id>(options: ApplyAfterSubmitRetry<Id>, error: unknown): void {
  try {
    options.onApplyFailed?.(error);
  } catch {
    // A breadcrumb must never cost the landed verdict.
  }
}

/** Fails closed: an evicted hold, a missing or unreadable account, or any other commitment refuses. */
async function storeHoldsInitialAccount<Id>(options: ApplyAfterSubmitRetry<Id>): Promise<boolean> {
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
