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

const lineageState = (state: number): SwapOrderNoteMetadata['lineageState'] => {
  // PswapLineageState discriminants are part of the persisted SDK format:
  // Active=0, FullyFilled=1, Reclaimed=2.
  if (state === 1) return 'filled';
  if (state === 2) return 'reclaimed';
  return 'active';
};

export const isSwapTransaction = (tx: ITransaction): tx is SwapTransaction => tx.type === 'swap';

const isSwapOrder = (tx: SwapTransaction): tx is SwapOrder => tx.extraInputs.orderId != null;

export async function localSwapOrders(accountId: string): Promise<SwapOrder[]> {
  const rows = await Repo.transactions
    .filter(
      tx =>
        tx.status === ITransactionStatus.Completed &&
        compareAccountIds(tx.accountId, accountId) &&
        isSwapTransaction(tx) &&
        isSwapOrder(tx)
    )
    .toArray();
  return rows.filter(isSwapTransaction).filter(isSwapOrder);
}

function attachmentOrderAndDepth(note: InputNoteRecord): { orderId: string; depth: number } | null {
  try {
    for (const attachment of note.attachments?.() ?? []) {
      for (const word of attachment.toWords()) {
        const values = word.toU64s();
        if (values.length === 4 && values[3] === 0n && values[1] != null && values[2] != null) {
          return { orderId: values[1].toString(), depth: Number(values[2]) };
        }
      }
    }
  } catch {}
  return null;
}

/** Classify only notes belonging to swap orders created by this wallet. */
export async function classifySwapOrderNotes(
  notes: InputNoteRecord[],
  accountId: string,
  client: MidenClientInterface
): Promise<Map<string, SwapOrderNoteMetadata>> {
  const orders = await localSwapOrders(accountId);
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
      const noteId = note.id()?.toString();
      if (!noteId) continue;
      let role: SwapOrderNoteMetadata['role'] | undefined;
      let depth = currentDepth;
      if (noteId === currentTipNoteId) role = 'tip';
      else {
        const attached = attachmentOrderAndDepth(note);
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
