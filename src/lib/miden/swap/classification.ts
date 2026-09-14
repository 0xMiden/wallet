import { compareAccountIds } from 'lib/miden/activity/utils';
import { type ITransaction, ITransactionStatus, type SwapTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { midenClientProxy } from '../back/miden-client-proxy';
import type { ConsumableNoteDto } from '../sdk/consumable-notes';
import { assertWasmHoldCurrent, type WasmLockHold } from '../sdk/miden-client';
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

const lineageState = (state: number): SwapOrderNoteMetadata['lineageState'] => {
  // PswapLineageState discriminants are part of the persisted SDK format:
  // Active=0, FullyFilled=1, Reclaimed=2.
  if (state === 1) return 'filled';
  if (state === 2) return 'reclaimed';
  return 'active';
};

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
        // "Orders created by THIS wallet" is the whole point of this list, and a
        // restored row is not evidence of that — it says whatever the backup's
        // author wrote. Downstream this drives reclaim, which initiates a real
        // consume against the order's own `expiresAt` and asset data.
        !tx.restoredFromBackup &&
        compareAccountIds(tx.accountId, accountId) &&
        isSwapTransaction(tx)
    )
    .toArray();
  return rows.filter((tx): tx is SwapOrder => isSwapTransaction(tx) && isSwapOrder(tx));
}

/**
 * Classify notes belonging to this wallet's orders using one synced lineage snapshot.
 * Reuse preloadedOrders to avoid another transactions-table scan in the same tick.
 */
export async function classifySwapOrderNotes(
  notes: ConsumableNoteDto[],
  accountId: string,
  preloadedOrders: SwapOrder[] | undefined,
  hold: WasmLockHold
): Promise<Map<string, SwapOrderNoteMetadata>> {
  const orders = preloadedOrders ?? (await localSwapOrders(accountId));
  const result = new Map<string, SwapOrderNoteMetadata>();

  if (orders.length === 0) return result;
  const assertLive = () => assertWasmHoldCurrent(hold, 'during swap lineage classification');
  assertLive();
  const snapshot = await midenClientProxy.getPswapLineages(assertLive);
  assertLive();
  const lineages = new Map(snapshot.map(lineage => [lineage.orderId, lineage]));
  for (const order of orders) {
    const orderId = orderIdString(order.extraInputs.orderId);
    const lineage = lineages.get(orderId);
    if (!lineage) continue;

    const currentTipNoteId = lineage.currentTipNoteId;
    const currentDepth = lineage.currentDepth;
    const state = lineageState(lineage.state);
    const expiresAt =
      order.extraInputs.expiresAt ??
      (order.completedAt ?? order.initiatedAt) + (order.extraInputs.expirySeconds ?? SWAP_ORDER_EXPIRY_SECONDS);

    for (const note of notes) {
      const noteId = note.noteId;
      if (!noteId) continue;
      let role: SwapOrderNoteMetadata['role'] | undefined;
      let depth = currentDepth;
      if (noteId === currentTipNoteId) role = 'tip';
      else {
        const attached = note.swapAttachment;
        if (attached?.orderId === orderId && attached.depth <= currentDepth) {
          role = 'payback';
          depth = attached.depth;
        }
      }
      if (!role) continue;
      result.set(noteId, {
        orderId,
        depth,
        role,
        lineageState: state,
        expiresAt,
        expiryTriggeredAt: order.extraInputs.expiryTriggeredAt,
        autoConsume: order.extraInputs.autoConsume ?? true
      });
    }
  }
  return result;
}
