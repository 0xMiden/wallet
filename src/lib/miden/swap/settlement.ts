import type { InputNoteRecord } from '@miden-sdk/miden-sdk/lazy';

import type { SwapTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { classifySwapOrderNotes, localSwapOrders, orderIdString, SWAP_ORDER_EXPIRY_SECONDS } from './classification';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { initiateConsumeNotesTransaction } from '../transaction/initiate';
import type { ConsumableNote, SwapOrderNoteMetadata } from '../types';

export { classifySwapOrderNotes } from './classification';

export interface SwapSettlementResult {
  queuedTransactionIds: string[];
  managedNoteIds: Set<string>;
}

/**
 * Queue terminal swap settlement batches. Active, unexpired orders are left
 * untouched. Consume deduplication/backoff remains owned by the existing
 * initiateConsumeNotesTransaction path.
 */
export async function reconcileSwapOrderNotes(
  accountId: string,
  notes: Array<ConsumableNote & { swapOrder?: SwapOrderNoteMetadata }>,
  delegateTransaction?: boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<SwapSettlementResult> {
  const orders = await localSwapOrders(accountId);
  const queuedTransactionIds: string[] = [];
  const managedNoteIds = new Set(notes.filter(n => n.swapOrder).map(n => n.id));

  for (const order of orders) {
    if (order.extraInputs.autoConsume === false) continue;
    const orderId = orderIdString(order.extraInputs.orderId);
    const orderNotes = notes.filter(note => note.swapOrder?.orderId === orderId);
    if (orderNotes.length === 0) continue;

    const state = orderNotes[0]!.swapOrder!.lineageState;
    const expiresAt =
      order.extraInputs.expiresAt ??
      (order.completedAt ?? order.initiatedAt) + (order.extraInputs.expirySeconds ?? SWAP_ORDER_EXPIRY_SECONDS);
    const expired = nowSeconds >= expiresAt;
    if (state === 'active' && !expired) continue;

    if (expired && order.extraInputs.expiryTriggeredAt == null) {
      // Persist the intent before queueing. If a solver races this write, the
      // subsequent consume uses only notes still consumable after sync; retries
      // remain idempotent through consume-note deduplication.
      await Repo.transactions.where({ id: order.id }).modify(tx => {
        const swap = tx as SwapTransaction;
        swap.extraInputs = { ...swap.extraInputs, expiresAt, expiryTriggeredAt: nowSeconds };
      });
    }

    const settleable = expired ? orderNotes : orderNotes.filter(note => note.swapOrder?.role === 'payback');
    if (settleable.length === 0) continue;
    const txId = await initiateConsumeNotesTransaction(accountId, settleable, delegateTransaction);
    queuedTransactionIds.push(txId);
  }

  return { queuedTransactionIds, managedNoteIds };
}

/** Read the SDK records, attach lineage metadata, and run one settlement tick. */
export async function settleSwapOrders(
  accountId: string,
  delegateTransaction?: boolean
): Promise<SwapSettlementResult> {
  const managedNotes = await withWasmClientLock(async () => {
    const client = await getMidenClient();
    const rawNotes = (await client.getConsumableNotes(accountId)) as InputNoteRecord[];
    const classified = await classifySwapOrderNotes(rawNotes, accountId, client);
    return rawNotes.flatMap(note => {
      const id = note.id()?.toString();
      const swapOrder = id ? classified.get(id) : undefined;
      if (!id || !swapOrder) return [];
      const metadata = note.metadata();
      return [
        {
          id,
          faucetId: '',
          amount: '',
          senderAddress: '',
          isBeingClaimed: false,
          type: metadata ? (metadata.noteType().toString().toLowerCase() as ConsumableNote['type']) : 'unknown',
          swapOrder
        }
      ];
    });
  });
  return reconcileSwapOrderNotes(accountId, managedNotes, delegateTransaction);
}
