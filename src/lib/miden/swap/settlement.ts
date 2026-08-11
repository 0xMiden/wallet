import * as Repo from 'lib/miden/repo';

import {
  classifySwapOrderNotes,
  isSwapTransaction,
  localSwapOrders,
  orderIdString,
  type SwapOrder
} from './classification';
import { midenClientProxy } from '../back/miden-client-proxy';
import { ITransactionStatus } from '../db/types';
import { toNoteTypeString } from '../helpers';
import { withWasmClientLock } from '../sdk/miden-client';
import { initiateConsumeNotesTransaction } from '../transaction/initiate';
import type { ConsumableNote, SwapOrderNoteMetadata } from '../types';

export { classifySwapOrderNotes } from './classification';

export interface SwapSettlementResult {
  queuedTransactionIds: string[];
  managedNoteIds: Set<string>;
}

/**
 * Self-heal a lost settlement stamp. `completeConsumeTransaction`'s stamp on
 * the swap row is best-effort and runs exactly once (the consume row goes
 * Completed and is never reprocessed), so a single swallowed write failure
 * would otherwise pin the swap row's chip on Pending forever. When an order
 * has no consumable notes left and no stamp, look for its completed tagged
 * consume and re-stamp from it. A settle consume outranks a reclaim one —
 * funds were received.
 */
async function repairSettlementStamp(order: SwapOrder): Promise<void> {
  const consumes = await Repo.transactions
    .filter(
      tx =>
        tx.type === 'consume' &&
        tx.status === ITransactionStatus.Completed &&
        tx.extraInputs?.swapOrderTxId === order.id
    )
    .toArray();
  const settle = consumes.find(tx => tx.extraInputs?.swapSettleKind !== 'reclaim') ?? consumes[0];
  if (!settle) return;
  const stampedAt = settle.completedAt ?? Math.floor(Date.now() / 1000);
  await Repo.transactions.where({ id: order.id }).modify(tx => {
    if (!isSwapTransaction(tx)) return;
    tx.extraInputs = {
      ...tx.extraInputs,
      ...(settle.extraInputs?.swapSettleKind === 'reclaim' ? { reclaimedAt: stampedAt } : { settledAt: stampedAt })
    };
  });
}

/**
 * Queue terminal swap settlement batches. Active, unexpired orders are left
 * untouched. Consume deduplication/backoff remains owned by the existing
 * initiateConsumeNotesTransaction path.
 *
 * Pass `preloadedOrders` when the caller already ran `localSwapOrders` this
 * tick — it is an unindexed full scan of the transactions table and must not
 * be repeated per stage.
 */
export async function reconcileSwapOrderNotes(
  accountId: string,
  notes: Array<ConsumableNote & { swapOrder?: SwapOrderNoteMetadata }>,
  delegateTransaction?: boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  preloadedOrders?: SwapOrder[]
): Promise<SwapSettlementResult> {
  const orders = preloadedOrders ?? (await localSwapOrders(accountId));
  const queuedTransactionIds: string[] = [];
  const managedNoteIds = new Set(notes.filter(n => n.swapOrder).map(n => n.id));

  for (const order of orders) {
    if (order.extraInputs.autoConsume === false) continue;
    const orderId = orderIdString(order.extraInputs.orderId);
    const orderNotes = notes.filter(note => note.swapOrder?.orderId === orderId);
    if (orderNotes.length === 0) {
      // Nothing consumable left but no settlement stamp: either the stamp
      // write was lost after the consume completed, or nothing was tagged
      // (nothing to repair — the lookup no-ops until the state changes).
      if (order.extraInputs.settledAt == null && order.extraInputs.reclaimedAt == null) {
        await repairSettlementStamp(order);
      }
      continue;
    }

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
    // An expired batch that still carries payback notes delivered funds — it
    // settles (Confirmed), it doesn't reclaim. Only a fund-less batch (tip
    // alone) is a reclaim. Partial fills stay lineage-'active' until expiry,
    // so this same-tick bundle is their normal settlement path.
    const hasPayback = settleable.some(note => note.swapOrder?.role === 'payback');
    // Link the consume row back to its swap order so history renders the
    // order as a single swap row (the linked consume is suppressed) and
    // `completeConsumeTransaction` can stamp the settlement on the swap row.
    // The id may be a dedup winner from an earlier tick — re-tagging is
    // idempotent. Swap-managed notes never reach manual claim paths, so a
    // consume covering them is always a settlement consume.
    await Repo.transactions.where({ id: txId }).modify(tx => {
      if (tx.type !== 'consume') return;
      tx.extraInputs = {
        ...(tx.extraInputs ?? {}),
        swapOrderTxId: order.id,
        swapSettleKind: hasPayback ? 'settle' : 'reclaim'
      };
    });
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
  // for wallets with no completed swap orders. The orders list is threaded
  // into classify + reconcile so the full-table scan runs once per tick.
  const orders = await localSwapOrders(accountId);
  if (orders.length === 0) {
    return { queuedTransactionIds: [], managedNoteIds: new Set() };
  }

  const managedNotes = await withWasmClientLock(async () => {
    // Both the consumable-note read (slice 4) and the per-order PSWAP lineage inside
    // classifySwapOrderNotes (slice 7a) now route through the proxy, so flag-ON they
    // read the offscreen client's canonical state; no live client is threaded here.
    // The caller lock still serializes the flag-OFF inline reads (byte-identical).
    const rawNotes = await midenClientProxy.getConsumableNotes(accountId);
    const classified = await classifySwapOrderNotes(rawNotes, accountId, orders);
    return rawNotes.flatMap<ConsumableNote>(note => {
      const id = note.noteId;
      const swapOrder = id ? classified.get(id) : undefined;
      if (!id || !swapOrder) return [];
      const type: ConsumableNote['type'] = note.noteType !== undefined ? toNoteTypeString(note.noteType) : 'unknown';
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
  return reconcileSwapOrderNotes(accountId, managedNotes, delegateTransaction, undefined, orders);
}
