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
