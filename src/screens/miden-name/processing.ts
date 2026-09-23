import { requestSWTransactionProcessing, startBackgroundTransactionProcessing } from 'lib/miden/activity';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { isExtension } from 'lib/platform';

type SignTransaction = Parameters<typeof startBackgroundTransactionProcessing>[0];

/**
 * Start the transaction loop after a Miden Name row was queued. Same rule as
 * the tracker (`MidenNameWatcher`): the service worker owns the loop on the
 * extension; on mobile and desktop this realm runs it.
 */
export function startMidenNameProcessing(signTransaction: SignTransaction): void {
  try {
    if (isExtension()) requestSWTransactionProcessing();
    else startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
  } catch (error) {
    // The row is queued. The next processing trigger picks it up.
    console.warn('[miden-name] could not start transaction processing', error);
  }
}
