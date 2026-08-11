import { compareAccountIds } from 'lib/miden/activity/utils';
import { type ITransaction, ITransactionStatus, type SwapTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import type { ConsumableNoteDto } from '../sdk/consumable-notes';
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
 * The `client` arg is still the live client — it drives the per-order PSWAP
 * lineage lookup (`client.client.pswap.lineage`), a separate reach-through that
 * is NOT reduced to a DTO here and is deferred to a later slice.
 */
export async function classifySwapOrderNotes(
  notes: ConsumableNoteDto[],
  accountId: string,
  client: MidenClientInterface,
  preloadedOrders?: SwapOrder[]
): Promise<Map<string, SwapOrderNoteMetadata>> {
  const orders = preloadedOrders ?? (await localSwapOrders(accountId));
  const result = new Map<string, SwapOrderNoteMetadata>();

  // Sequential on purpose: the WASM client is single-threaded, and the outer
  // withWasmClientLock held by callers does not serialize sibling promises
  // launched by the same holder — concurrent lineage() calls throw
  // "recursive use of an object ... unsafe aliasing".
  for (const order of orders) {
    const orderId = orderIdString(order.extraInputs.orderId);
    let lineage: Awaited<ReturnType<typeof client.client.pswap.lineage>> = null;
    try {
      lineage = await client.client.pswap.lineage(orderId);
    } catch (err) {
      console.warn('[swap-settlement] lineage lookup failed', orderId, err);
      continue;
    }
    if (!lineage) continue;

    const currentTipNoteId = lineage.currentTipNoteId().toString();
    const currentDepth = lineage.currentDepth();
    const state = lineageState(lineage.state());
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
