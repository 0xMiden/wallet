import { type ISwapExtraInputs, type ITransaction, ITransactionStatus } from 'lib/miden/db/types';

/**
 * A swap order rebuilt by Guardian history recovery. Recovery writes Auto accept off and no expiry, and this device's
 * SDK never tracked the order, so neither its lineage nor its output note exists here: the node's copy of the order
 * note is the only evidence of whether it is still open, and cancelling that note is the only way its funds come back
 * (#1487).
 */
export interface RecoveredSwapOrderRef {
  txId: string;
  accountId: string;
  orderId: string;
  noteId: string;
  offeredAmount: bigint;
  requestedAmount: bigint;
}

const swapExtraOf = (tx: ITransaction): Partial<ISwapExtraInputs> => tx.extraInputs ?? {};

/**
 * The order note of a recovered swap: the one output note whose recovered summary carries the row's order id and a
 * requested asset (a payback carries the order id only). None when two notes claim it or the row does not list it.
 */
export function recoveredOrderNoteId(tx: ITransaction): string | undefined {
  const orderId = swapExtraOf(tx).orderId;
  if (tx.type !== 'swap' || orderId == null) return undefined;
  const candidates = (tx.recovery?.outputNotes ?? []).filter(
    note => note.swap?.orderId === String(orderId) && note.swap.requestedAsset !== undefined
  );
  const [note] = candidates;
  return candidates.length === 1 && note && tx.outputNoteIds?.includes(note.id) ? note.id : undefined;
}

/** The recovered order while nothing has closed it: no settlement, no reclaim, no spent order note. */
export function recoveredSwapOrderRef(tx: ITransaction): RecoveredSwapOrderRef | undefined {
  const extra = swapExtraOf(tx);
  if (
    tx.recovered !== true ||
    tx.status !== ITransactionStatus.Completed ||
    extra.settledAt != null ||
    extra.reclaimedAt != null ||
    extra.orderNoteSpentAt != null ||
    typeof tx.amount !== 'bigint' ||
    typeof extra.requestedAmount !== 'bigint' ||
    extra.orderId == null
  )
    return undefined;
  const noteId = recoveredOrderNoteId(tx);
  if (noteId === undefined) return undefined;
  return {
    txId: tx.id,
    accountId: tx.accountId,
    orderId: String(extra.orderId),
    noteId,
    offeredAmount: tx.amount,
    requestedAmount: extra.requestedAmount
  };
}

export const isOpenRecoveredOrder = (tx: ITransaction): boolean => recoveredSwapOrderRef(tx) !== undefined;

/**
 * An open recovered order this wallet's Cancel stamped: the one restored row settlement acts on. The stamp is the
 * permission, which is why a backup import drops a dump's own.
 */
export const isRecoveredReturnOrder = (tx: ITransaction): boolean =>
  swapExtraOf(tx).expiryTriggeredAt != null && isOpenRecoveredOrder(tx);
