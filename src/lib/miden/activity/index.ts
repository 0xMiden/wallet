import { isExtension } from 'lib/platform';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';

export * from './helpers';
export * from './transactions';
export * from './notes';

/**
 * Tell the service worker to start processing queued transactions.
 * No-op if not running as an extension. Fire-and-forget by contract
 * (no unhandled-rejection risk for the many call sites that don't
 * `.catch`), but failures are now logged. Pre-#216 the `.catch(() => {})`
 * silently swallowed every failure mode — port disconnect, SW dead
 * during transition, intercom rejection — making the popup-mount
 * recovery path invisible. The SW now also has startup-side orphan
 * recovery and a periodic self-heal alarm in `setupTransactionProcessor`,
 * so a dropped nudge here is recoverable; the warning lets us at least
 * see the failure happen.
 */
export function requestSWTransactionProcessing(): void {
  if (!isExtension()) return;
  getIntercom()
    .request({ type: WalletMessageType.ProcessTransactionsRequest })
    .catch(err => {
      console.warn('[requestSWTransactionProcessing] Failed to nudge SW:', err);
    });
}

/**
 * Speculatively pre-prove a send transaction with the params currently
 * showing on the review screen, so when the user clicks Confirm the prove
 * is already done. Cache lives in the SW's SpeculationManager keyed by
 * params hash; consumed by MidenClientInterface.proveLocallyViaOffscreen
 * on actual submit. Fire-and-forget — failures degrade gracefully (the
 * Confirm path falls through to fresh execute+prove).
 *
 * Caller is responsible for gating: only call when local proving is the
 * effective mode (!isDelegateProofEnabled()), the build opted into
 * MIDEN_USE_SPECULATIVE_PROVING, AND there are no per-tx params that
 * speculation can't handle (currently: skip when recallBlocks is set,
 * since reclaim height drifts between speculate-time and commit-time).
 */
export function requestSpeculateSend(params: {
  accountId: string;
  recipientAccountId: string;
  faucetId: string;
  noteType: 'public' | 'private';
  amount: bigint;
}): void {
  if (!isExtension()) return;
  getIntercom()
    .request({
      type: WalletMessageType.SpeculateSendRequest,
      accountId: params.accountId,
      recipientAccountId: params.recipientAccountId,
      faucetId: params.faucetId,
      noteType: params.noteType,
      amount: params.amount.toString()
    })
    .catch(err => {
      console.warn('[requestSpeculateSend] failed:', err);
    });
}

/** Drop the cached speculation. Called when the review screen unmounts. */
export function requestSpeculateInvalidate(): void {
  if (!isExtension()) return;
  getIntercom()
    .request({ type: WalletMessageType.SpeculateInvalidate })
    .catch(err => {
      console.warn('[requestSpeculateInvalidate] failed:', err);
    });
}
