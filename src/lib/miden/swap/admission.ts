import { getMessage } from 'lib/i18n/core';
import { isLiveTransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { cacheScope } from 'lib/miden-chain/native-asset';

/** Called within the outgoing queue's Dexie write transaction, immediately before insertion. */
export async function assertSwapQueueAvailable(accountId: string, scope: string): Promise<void> {
  if (scope !== cacheScope()) throw new Error(getMessage('swapBalanceUnavailable'));
  // Refuse unresolved outgoing work rather than guess its fees or the value of a custom request.
  // Claims can also charge vault fees, so they block admission too. Execution checks after queueing:
  // a later send, another device or a chain change cannot be reserved by this local queue.
  const pending = await Repo.transactions
    .filter(
      row =>
        sameWalletAccountId(row.accountId, accountId) &&
        (isLiveTransaction(row) || row.status === ITransactionStatus.Unconfirmed)
    )
    .toArray();
  if (pending.length > 0) throw new Error(getMessage('swapPendingSpend'));
}
