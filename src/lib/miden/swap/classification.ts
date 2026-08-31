import { compareAccountIds } from 'lib/miden/activity/utils';
import { type ITransaction, ITransactionStatus, type SwapTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { midenClientProxy } from '../back/miden-client-proxy';
import type { ConsumableNoteDto } from '../sdk/consumable-notes';
import type { PswapLineageDto } from '../sdk/pswap-lineage';
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
 * Classify only notes belonging to swap orders created by this wallet.
 * Pass `preloadedOrders` when the caller already ran `localSwapOrders` this
 * tick — it is an unindexed full scan of the transactions table.
 *
 * Since slice 4 (issue #260) the notes arrive as plain {@link ConsumableNoteDto}s
 * rather than live `InputNoteRecord`s: the per-note swap-order id/depth is
 * precomputed into `dto.swapAttachment` by the reducer (which holds the live
 * record), so this classifier no longer reaches through to `note.attachments()`.
 * Since slice 7a the per-order PSWAP lineage lookup routes through
 * `midenClientProxy.getPswapLineage` (a plain {@link PswapLineageDto}), so flag-ON
 * it reads the OFFSCREEN client's canonical synced lineage (the SW client is
 * dormant then and would classify against stale tip/depth/state); flag-OFF is the
 * byte-identical inline `client.client.pswap.lineage` reduction under the caller
 * lock. No live client is threaded through here any more.
 */
export async function classifySwapOrderNotes(
  notes: ConsumableNoteDto[],
  accountId: string,
  preloadedOrders?: SwapOrder[]
): Promise<Map<string, SwapOrderNoteMetadata>> {
  const orders = preloadedOrders ?? (await localSwapOrders(accountId));
  const result = new Map<string, SwapOrderNoteMetadata>();

  // Sequential on purpose: the WASM client is single-threaded, and the outer
  // withWasmClientLock held by callers does not serialize sibling promises
  // launched by the same holder — concurrent lineage() calls throw
  // "recursive use of an object ... unsafe aliasing". Flag-ON each getPswapLineage
  // is a separate offscreen op serialized by the offscreen doc's own mutex, so the
  // sequential await preserves the one-at-a-time invariant either way.
  for (const order of orders) {
    const orderId = orderIdString(order.extraInputs.orderId);
    let lineage: PswapLineageDto | null = null;
    try {
      lineage = await midenClientProxy.getPswapLineage(orderId);
    } catch (err) {
      console.warn('[swap-settlement] lineage lookup failed', orderId, err);
      continue;
    }
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
