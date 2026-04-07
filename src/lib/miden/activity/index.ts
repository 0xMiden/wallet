import { isExtension } from 'lib/platform';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';

export * from './helpers';
export * from './transactions';
export * from './notes';

/**
 * Tell the service worker to start processing queued transactions.
 * On extension, this triggers the SW transaction processor.
 * On mobile, transactions are processed in the frontend — this just
 * notifies the backend so auto-backup can trigger.
 * Fire-and-forget.
 */
export function requestSWTransactionProcessing(): void {
  getIntercom()
    .request({ type: WalletMessageType.ProcessTransactionsRequest })
    .catch(() => {});
}
