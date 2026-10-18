import {
  type IRecoveredSwapTip,
  type ISwapExtraInputs,
  type ITransaction,
  ITransactionStatus
} from 'lib/miden/db/types';

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
  /** What a Cancel returns: the remainder the last partial fill left, else the order note itself at depth 0. */
  tipNoteId: string;
  tipDepth: number;
  tipOfferedAmount: bigint;
  /** The row carries a settledAt or reclaimedAt no lineage read recorded, which an open read clears. */
  provisionalClosure?: boolean;
}

const swapExtraOf = (tx: ITransaction): Partial<ISwapExtraInputs> => tx.extraInputs ?? {};

/**
 * A swap order Guardian history recovery rebuilt. Whether it is closed is its lineage's to say on the node, so only
 * `closeRecoveredSwapOrder` stamps its settlement or reclaim, once the walk reads finished, from the consumes linked
 * to it, and records `lineageClosedAt` with it: one of them may be a partial fill's payout while the remainder is
 * still open (#1487).
 */
export const isRecoveredSwapOrder = (tx: ITransaction): boolean => tx.type === 'swap' && tx.recovered === true;

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

/** A malformed stored remainder falls back to the order note and counts as depth 0 when confirming an open read. */
export function recordedRecoveredSwapTip(tx: ITransaction): IRecoveredSwapTip | undefined {
  const recorded = swapExtraOf(tx).recoveredTip;
  return recorded != null &&
    typeof recorded.noteId === 'string' &&
    Number.isSafeInteger(recorded.depth) &&
    recorded.depth > 0 &&
    typeof recorded.remainingOffered === 'bigint'
    ? recorded
    : undefined;
}

/**
 * The recovered order while its lineage has not closed it: no recorded close and no spent order note. A settledAt or
 * reclaimedAt with no record is the pre-fix recovery reconcile's, so the order is still tracked and its next read
 * decides (#1487).
 */
export function recoveredSwapOrderRef(tx: ITransaction): RecoveredSwapOrderRef | undefined {
  const extra = swapExtraOf(tx);
  if (
    tx.recovered !== true ||
    tx.status !== ITransactionStatus.Completed ||
    extra.lineageClosedAt != null ||
    extra.orderNoteSpentAt != null ||
    typeof tx.amount !== 'bigint' ||
    typeof extra.requestedAmount !== 'bigint' ||
    extra.orderId == null
  )
    return undefined;
  const noteId = recoveredOrderNoteId(tx);
  if (noteId === undefined) return undefined;
  const tip = recordedRecoveredSwapTip(tx);
  return {
    txId: tx.id,
    accountId: tx.accountId,
    orderId: String(extra.orderId),
    noteId,
    offeredAmount: tx.amount,
    requestedAmount: extra.requestedAmount,
    tipNoteId: tip?.noteId ?? noteId,
    tipDepth: tip?.depth ?? 0,
    tipOfferedAmount: tip?.remainingOffered ?? tx.amount,
    ...(extra.settledAt != null || extra.reclaimedAt != null ? { provisionalClosure: true } : {})
  };
}

export const isOpenRecoveredOrder = (tx: ITransaction): boolean => recoveredSwapOrderRef(tx) !== undefined;

/**
 * An open recovered order this wallet's Cancel stamped: the one restored row settlement acts on. The stamp is the
 * permission, which is why a backup import drops a dump's own.
 */
export const isRecoveredReturnOrder = (tx: ITransaction): boolean =>
  swapExtraOf(tx).expiryTriggeredAt != null && isOpenRecoveredOrder(tx);
