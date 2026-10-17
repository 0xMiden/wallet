import { isLiveTransaction, type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { type PswapOrderLineageRead, readPswapOrderLineage } from 'lib/miden/sdk/pswap-order-note';
import type { SwapOrderTracking } from 'lib/miden/transaction/get';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';

import { isOpenRecoveredOrder, type RecoveredSwapOrderRef } from './recovered-order';

export type RecoveredOrderTracking = { kind: 'open'; tracking: SwapOrderTracking } | { kind: 'closed' };

/**
 * Track recovered orders from the node, the only lineage a device that did not place them has (#1487). The order
 * is open while its lineage has an unspent tip: the order note itself with nothing filled, or the remainder a partial
 * fill left, which is recorded on the row as what its Cancel returns. It is closed (`closeRecoveredSwapOrder`) only
 * when a spend left no remainder. An order with no entry in the answer is unresolved: the read failed, the node knows
 * no such note, or a consume of this wallet may still be landing.
 */
export async function trackRecoveredSwapOrders(
  orders: RecoveredSwapOrderRef[]
): Promise<Map<string, RecoveredOrderTracking>> {
  const results = new Map<string, RecoveredOrderTracking>();
  if (orders.length === 0) return results;
  await ensureSdkWasmReady();
  for (const order of orders) {
    let read: PswapOrderLineageRead;
    try {
      read = await readPswapOrderLineage(order.noteId, order.orderId, order.accountId);
    } catch (error) {
      console.warn('[swap-order-tracking] could not read a recovered order lineage', error);
      continue;
    }
    if (read.kind === 'open') {
      if (read.depth > 0 && read.noteId !== order.tipNoteId) await recordRecoveredSwapTip(order.txId, read);
      results.set(order.orderId, {
        kind: 'open',
        tracking: {
          orderId: order.orderId,
          state: 'active',
          currentDepth: read.depth,
          remainingOffered: read.offeredAmount,
          remainingRequested: read.requestedAmount
        }
      });
    } else if (read.kind === 'finished' && (await closeRecoveredSwapOrder(order.txId))) {
      results.set(order.orderId, { kind: 'closed' });
    }
  }
  return results;
}

/** Record the remainder a recovered order's Cancel returns, on a row that is still an open recovered order. */
async function recordRecoveredSwapTip(
  txId: string,
  tip: { noteId: string; depth: number; offeredAmount: bigint }
): Promise<void> {
  await Repo.transactions.where({ id: txId }).modify(row => {
    // `false`, not a bare return - dexie re-puts the deep clone for any other value.
    if (!isOpenRecoveredOrder(row)) return false;
    row.extraInputs = {
      ...row.extraInputs,
      recoveredTip: { noteId: tip.noteId, depth: tip.depth, remainingOffered: tip.offeredAmount }
    };
    return undefined;
  });
}

const isRunning = (row: ITransaction): boolean =>
  isLiveTransaction(row) || row.status === ITransactionStatus.Unconfirmed;

/**
 * Record why a recovered order's lineage ended: a completed consume of this wallet linked to the order is its
 * settlement or reclaim, a settle outranking a reclaim as funds arrived, and with none the order ended elsewhere.
 * Returns false and records nothing while a linked consume is still running, since that consume may be what spent it.
 */
export async function closeRecoveredSwapOrder(
  txId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const consumes = await Repo.transactions
    .where('extraInputs.swapOrderTxId')
    .equals(txId)
    .filter(row => row.type === 'consume')
    .toArray();
  if (consumes.some(isRunning)) return false;
  const completed = consumes.filter(row => row.status === ITransactionStatus.Completed);
  const consume = completed.find(row => row.extraInputs?.swapSettleKind !== 'reclaim') ?? completed[0];
  const closedAt = consume?.completedAt ?? nowSeconds;
  const stamp =
    consume === undefined
      ? { orderNoteSpentAt: nowSeconds }
      : consume.extraInputs?.swapSettleKind === 'reclaim'
        ? { reclaimedAt: closedAt }
        : { settledAt: closedAt };
  await Repo.transactions.where({ id: txId }).modify(row => {
    // `false`, not a bare return - dexie re-puts the deep clone for any other value.
    if (row.type !== 'swap') return false;
    row.extraInputs = { ...row.extraInputs, ...stamp };
    return undefined;
  });
  return true;
}
