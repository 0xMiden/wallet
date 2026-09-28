import { useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { earnWithdrawalRetryKind, EarnWithdrawalRetryKind } from 'lib/epoch/earn-withdraw-policy';
import {
  cancelTransactionById,
  isCancellableTransaction,
  isRequeueableTransaction,
  isUnverifiableSendRetryError,
  requestSWTransactionProcessing,
  requeueFailedTransaction,
  retryEarnWithdrawReceive,
  USER_CANCELLED_TRANSACTION_REASON
} from 'lib/miden/activity';
import { ITransaction } from 'lib/miden/db/types';
import { cancelSwapOrder } from 'lib/miden/swap/cancel-order';
import { useConfirm } from 'lib/ui/dialog';
import { navigate } from 'lib/woozie';

import { IHistoryEntry } from './IHistoryEntry';

/**
 * Everything a transaction detail page can DO with its row, in one place.
 *
 * `HistoryDetails` and its swap branch are two renderings of the same page, so
 * the handlers, the in-flight flags and the error strings have to be one object
 * they both read: a second copy in `SwapDetail` would be a second set of
 * eligibility rules to keep in step with `retry.ts`, which is exactly how a
 * button that cannot succeed gets shipped.
 */
export interface TransactionActions {
  /** Stop a row that has not been picked up (or a value transfer mid-pipeline). */
  canCancel: boolean;
  isCancelling: boolean;
  cancelError: string | null;
  onCancel: () => void;

  /** Re-queue a Failed row through the FIFO loop. */
  canRetry: boolean;
  /** Set only for an `earn-withdraw`, whose Retry has its own label and path. */
  earnRetryKind: EarnWithdrawalRetryKind | undefined;
  isRetrying: boolean;
  retryError: string | null;
  /** The refusal took the user's word for it; offer the acknowledged retry. */
  needsSendAcknowledgement: boolean;
  onRetry: (acknowledgeUnverifiedSend?: boolean) => void;

  /** Take a live swap order's offered tip back (swap rows only). */
  isCancellingOrder: boolean;
  cancelOrderError: string | null;
  onCancelOrder: () => void;
}

export const useTransactionActions = (
  transactionId: string,
  entry: IHistoryEntry | null,
  transaction: ITransaction | undefined
): TransactionActions => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [needsSendAcknowledgement, setNeedsSendAcknowledgement] = useState(false);
  const [isCancellingOrder, setIsCancellingOrder] = useState(false);
  const [cancelOrderError, setCancelOrderError] = useState<string | null>(null);

  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    setCancelError(null);

    try {
      await cancelTransactionById(transactionId, USER_CANCELLED_TRANSACTION_REASON);
    } catch (error) {
      console.error('[HistoryDetails] Failed to cancel transaction:', error);
      setCancelError(error instanceof Error ? error.message : t('smthWentWrong'));
    } finally {
      setIsCancelling(false);
    }
  }, [t, transactionId]);

  const handleRetry = useCallback(
    async (acknowledgeUnverifiedSend = false) => {
      if (!entry) return;
      setIsRetrying(true);
      setRetryError(null);
      setNeedsSendAcknowledgement(false);
      try {
        if (entry.txType === 'earn-withdraw') {
          await retryEarnWithdrawReceive(transactionId);
        } else {
          await requeueFailedTransaction(transactionId, { acknowledgeUnverifiedSend });
          requestSWTransactionProcessing();
          navigate(`/generating-transaction/${encodeURIComponent(transactionId)}`);
          return;
        }
      } catch (error) {
        console.error('[HistoryDetails] Failed to retry transaction:', error);
        setRetryError(error instanceof Error ? error.message : t('smthWentWrong'));
        setNeedsSendAcknowledgement(isUnverifiableSendRetryError(error));
      } finally {
        setIsRetrying(false);
      }
    },
    [entry, t, transactionId]
  );

  /**
   * Cancelling a live order gives up a place in the order book that cannot be
   * taken back, so it goes through the app's destructive confirmation sheet
   * (`useConfirm`, design-system "Confirm / alert") rather than acting on the
   * tap. The queued-transaction Cancel above deliberately keeps acting on the
   * tap: it stops something the user is already watching fail.
   */
  const handleCancelOrder = useCallback(async () => {
    const accepted = await confirm({
      title: t('swapCancelOrderConfirmTitle'),
      children: t('swapCancelOrderConfirmBody'),
      confirmLabel: t('swapCancelOrder'),
      destructive: true
    });
    if (!accepted) return;

    setIsCancellingOrder(true);
    setCancelOrderError(null);
    try {
      await cancelSwapOrder(transactionId);
    } catch (error) {
      console.error('[HistoryDetails] Failed to cancel swap order:', error);
      setCancelOrderError(error instanceof Error ? error.message : t('smthWentWrong'));
    } finally {
      setIsCancellingOrder(false);
    }
  }, [confirm, t, transactionId]);

  // Cancel is offered on a narrower set than "pending": a structural op that has
  // already been picked up cannot be stopped, retried, or completed afterwards,
  // so the button only mislabels a rotation that is going to land anyway.
  const canCancel = entry ? isCancellableTransaction({ status: entry.status, type: entry.txType }) : false;
  const earnRetryKind = earnWithdrawalRetryKind(transaction);
  const canRetry =
    entry !== null &&
    !entry.isCancelled &&
    !transaction?.restoredFromBackup &&
    (entry.txType === 'earn-withdraw'
      ? earnRetryKind !== undefined
      : isRequeueableTransaction({
          status: entry.status,
          type: entry.txType,
          // Epoch (Fast) bridged sends are not replayable - their Epoch intent is
          // already gone, so a requeue would mint a second orphan collateral note.
          bridgeProvider: entry.bridgeProvider,
          restoredFromBackup: transaction?.restoredFromBackup
        }));

  return {
    canCancel,
    isCancelling,
    cancelError,
    onCancel: () => void handleCancel(),
    canRetry,
    earnRetryKind,
    isRetrying,
    retryError,
    needsSendAcknowledgement,
    onRetry: (acknowledgeUnverifiedSend = false) => void handleRetry(acknowledgeUnverifiedSend),
    isCancellingOrder,
    cancelOrderError,
    onCancelOrder: () => void handleCancelOrder()
  };
};
