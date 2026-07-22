import * as Repo from 'lib/miden/repo';

import { classifySwapOrderNotes, isSwapTransaction, localSwapOrders, orderIdString } from './classification';
import { toNoteTypeString } from '../helpers';
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
    // Expiry-driven reclaim requires an explicit expiresAt (stamped at
    // completion since this feature shipped). Orders persisted before that
    // have no expiry fields; fabricating one from completedAt would deem every
    // pre-existing open order instantly expired and reclaim its tip.
    const expiresAt = order.extraInputs.expiresAt;
    const expired = expiresAt != null && nowSeconds >= expiresAt;
    if (state === 'active' && !expired) continue;

    if (expired && order.extraInputs.expiryTriggeredAt == null) {
      // Persist the intent before queueing. If a solver races this write, the
      // subsequent consume uses only notes still consumable after sync; retries
      // remain idempotent through consume-note deduplication.
      await Repo.transactions.where({ id: order.id }).modify(tx => {
        if (!isSwapTransaction(tx)) return;
        tx.extraInputs = { ...tx.extraInputs, expiryTriggeredAt: nowSeconds };
      });
    }

    const settleable = expired ? orderNotes : orderNotes.filter(note => note.swapOrder?.role === 'payback');
    if (settleable.length === 0) continue;
    // The service worker cannot read the delegated-proving setting
    // (localStorage-backed), so fall back to the preference captured on the
    // swap row at initiate time.
    const delegate = delegateTransaction ?? order.delegateTransaction;
    const txId = await initiateConsumeNotesTransaction(accountId, settleable, delegate);
    queuedTransactionIds.push(txId);
  }

  return { queuedTransactionIds, managedNoteIds };
}

/** Read the SDK records, attach lineage metadata, and run one settlement tick. */
export async function settleSwapOrders(
  accountId: string,
  delegateTransaction?: boolean
): Promise<SwapSettlementResult> {
  // Cheap Dexie-only gate: this runs on a 3s frontend interval, so don't
  // touch the WASM client (lock acquisition + full consumable-notes read)
  // for wallets with no completed swap orders.
  const orders = await localSwapOrders(accountId);
  if (orders.length === 0) {
    return { queuedTransactionIds: [], managedNoteIds: new Set() };
  }

  const managedNotes = await withWasmClientLock(async () => {
    const client = await getMidenClient();
    const rawNotes = await client.getConsumableNotes(accountId);
    const classified = await classifySwapOrderNotes(rawNotes, accountId, client);
    return rawNotes.flatMap(note => {
      const id = note.id()?.toString();
      const swapOrder = id ? classified.get(id) : undefined;
      if (!id || !swapOrder) return [];
      const metadata = note.metadata();
      const type: ConsumableNote['type'] = metadata ? toNoteTypeString(metadata.noteType()) : 'unknown';
      return [
        {
          id,
          faucetId: '',
          amount: '',
          senderAddress: '',
          isBeingClaimed: false,
          type,
          swapOrder
        }
      ];
    });
  });
  return reconcileSwapOrderNotes(accountId, managedNotes, delegateTransaction);
}
