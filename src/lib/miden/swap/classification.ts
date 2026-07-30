import type { InputNoteRecord } from '@miden-sdk/miden-sdk/lazy';

import { compareAccountIds } from 'lib/miden/activity/utils';
import { type ITransaction, ITransactionStatus, type SwapTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import type { MidenClientInterface } from '../sdk/miden-client-interface';
import type { SwapOrderNoteMetadata } from '../types';

export const SWAP_ORDER_EXPIRY_SECONDS = 120;

export type SwapOrder = SwapTransaction & {
  extraInputs: SwapTransaction['extraInputs'] & {
    orderId: bigint | string;
    expiresAt?: number;
    expiryTriggeredAt?: number;
  };
};

export const orderIdString = (value: bigint | string): string => value.toString();

export const isSwapTransaction = (tx: ITransaction): tx is SwapTransaction => tx.type === 'swap';

// Optional-chained: persisted rows are plain objects, and a legacy or
// partially-written swap row without extraInputs must not throw inside the
// Dexie filter predicate (a throw rejects the whole toArray()).
const isSwapOrder = (tx: SwapTransaction): tx is SwapOrder => tx.extraInputs?.orderId != null;

export async function localSwapOrders(accountId: string): Promise<SwapOrder[]> {
  const rows = await Repo.transactions
    .filter(
      tx =>
        tx.status === ITransactionStatus.Completed &&
        compareAccountIds(tx.accountId, accountId) &&
        isSwapTransaction(tx)
    )
    .toArray();
  return rows.filter((tx): tx is SwapOrder => isSwapTransaction(tx) && isSwapOrder(tx));
}

/**
 * Classify only notes belonging to swap orders created by this wallet.
 * Pass `preloadedOrders` when the caller already ran `localSwapOrders` this
 * tick — it is an unindexed full scan of the transactions table.
 */
export async function classifySwapOrderNotes(
  notes: InputNoteRecord[],
  accountId: string,
  client: MidenClientInterface,
  preloadedOrders?: SwapOrder[]
): Promise<Map<string, SwapOrderNoteMetadata>> {
  // Reduced 0.16 test build: the client.pswap lineage resource is absent on this SDK
  // branch, so swap-order note classification/settlement is unavailable. Returns empty.
  void [notes, accountId, client, preloadedOrders];
  return new Map<string, SwapOrderNoteMetadata>();
}
