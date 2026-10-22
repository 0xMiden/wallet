import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { useSwapOrderTrackingStore } from 'lib/miden/swap/order-tracking-store';
import { isOpenRecoveredOrder, isRecoveredSwapOrder } from 'lib/miden/swap/recovered-order';
import { getSwapSettlementNotes } from 'lib/miden/transaction/get';

import type { IHistoryEntry } from './IHistoryEntry';
import { swapFillProgress } from './swapFillProgress';
import { deriveSwapReceipt } from './swapReceipt';

type HistoryProgress = Pick<IHistoryEntry, 'swapFillProgress'>;

/** Local evidence only: no sync, balances, quote prices or additional SDK calls. */
export const resolveSwapHistoryProgress = async (tx: ITransaction): Promise<HistoryProgress> => {
  if (tx.type !== 'swap' || tx.status !== ITransactionStatus.Completed) return {};
  const extra = tx.extraInputs;
  if (!extra || extra.requestedAmount === undefined) return {};
  try {
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
      settlement: await getSwapSettlementNotes(tx.id),
      autoConsume: extra.autoConsume !== false,
      recovered,
      slippageBps: extra.slippageBps,
      expiresAt: extra.expiresAt ?? null
    });
    const progress = swapFillProgress(receipt.filledAmount, extra.requestedAmount);
    return progress ? { swapFillProgress: progress.text } : {};
  } catch {
    // Progress is optional. An unavailable local read must not hide the order.
    return {};
  }
};
