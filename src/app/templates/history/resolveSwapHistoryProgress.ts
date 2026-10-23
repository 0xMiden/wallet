import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { useSwapOrderTrackingStore } from 'lib/miden/swap/order-tracking-store';
import { isOpenRecoveredOrder, isRecoveredSwapOrder } from 'lib/miden/swap/recovered-order';
import {
  getSwapSettlementNotesForOrders,
  settlementNotesFromLinkedRows,
  type SwapSettlementNotes
} from 'lib/miden/transaction/get';

import type { IHistoryEntry } from './IHistoryEntry';
import { swapFillProgress } from './swapFillProgress';
import { deriveSwapReceipt } from './swapReceipt';

type HistoryProgress = Pick<IHistoryEntry, 'swapFillProgress'>;

const emptySettlementNotes = (): SwapSettlementNotes => ({
  settled: [],
  reclaimed: [],
  settledTransactions: [],
  reclaimedTransactions: []
});

const isSwapProgressRow = (tx: ITransaction): boolean => {
  if (tx.type !== 'swap' || tx.status !== ITransactionStatus.Completed) return false;
  const extra = tx.extraInputs;
  return Boolean(extra) && extra.requestedAmount !== undefined;
};

const progressFromSettlement = (tx: ITransaction, settlement: SwapSettlementNotes): HistoryProgress => {
  const extra = tx.extraInputs;
  if (!extra || extra.requestedAmount === undefined) return {};
  const recovered = isOpenRecoveredOrder(tx);
  const closedRecovered = isRecoveredSwapOrder(tx) && !recovered;
  const tracking =
    closedRecovered || extra.orderId == null
      ? null
      : (useSwapOrderTrackingStore.getState().entries[String(extra.orderId)]?.tracking ?? null);
  const receipt = deriveSwapReceipt({
    originalOutputNoteIds: tx.outputNoteIds,
    requestedAmount: extra.requestedAmount,
    requestedFaucetId: extra.requestedFaucetId,
    tracking,
    settlement,
    autoConsume: extra.autoConsume !== false,
    recovered,
    slippageBps: extra.slippageBps,
    expiresAt: extra.expiresAt ?? null
  });
  const progress = swapFillProgress(receipt.filledAmount, extra.requestedAmount);
  return progress ? { swapFillProgress: progress.text } : {};
};

const resolveSwapHistoryProgressForRows = async (
  txs: readonly ITransaction[],
  linkedRows?: readonly ITransaction[] | null
): Promise<Map<string, HistoryProgress>> => {
  const progress = new Map<string, HistoryProgress>();
  const eligible: ITransaction[] = [];
  const seen = new Set<string>();
  for (const tx of txs) {
    if (!isSwapProgressRow(tx) || seen.has(tx.id)) continue;
    seen.add(tx.id);
    eligible.push(tx);
  }
  // No eligible order: do not open Dexie.
  if (eligible.length === 0) return progress;

  if (linkedRows === null) return progress;

  let notes: Map<string, SwapSettlementNotes>;
  try {
    const orderIds = eligible.map(tx => tx.id);
    notes =
      linkedRows !== undefined
        ? settlementNotesFromLinkedRows(orderIds, linkedRows)
        : await getSwapSettlementNotesForOrders(orderIds);
  } catch {
    // A failed read leaves every eligible row without a percentage and does not fail the fetch.
    for (const tx of eligible) progress.set(tx.id, {});
    return progress;
  }

  for (const tx of eligible) {
    try {
      progress.set(tx.id, progressFromSettlement(tx, notes.get(tx.id) ?? emptySettlementNotes()));
    } catch {
      progress.set(tx.id, {});
    }
  }
  return progress;
};

/**
 * Local evidence only: no sync, balances, quote prices or additional SDK calls.
 * When a history page already loaded linked rows, completed consumes come from that set;
 * otherwise the eligible orders are read once. `null` means the shared read failed.
 */
export async function resolveSwapHistoryProgress(
  txs: readonly ITransaction[],
  linkedRows?: readonly ITransaction[] | null
): Promise<Map<string, HistoryProgress>>;
export async function resolveSwapHistoryProgress(
  txs: readonly ITransaction[],
  linkedRows?: readonly ITransaction[] | null
): Promise<Map<string, HistoryProgress>> {
  return resolveSwapHistoryProgressForRows(txs, linkedRows);
}
