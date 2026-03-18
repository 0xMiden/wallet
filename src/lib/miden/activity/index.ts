import { isExtension } from 'lib/platform';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';

export * from './helpers';
export * from './transactions';
export * from './notes';

/**
 * Tell the service worker to start processing queued transactions.
 * No-op if not running as an extension. Fire-and-forget.
 */
export function requestSWTransactionProcessing(): void {
  if (!isExtension()) return;
  getIntercom()
    .request({ type: WalletMessageType.ProcessTransactionsRequest })
    .catch(() => {});
}
