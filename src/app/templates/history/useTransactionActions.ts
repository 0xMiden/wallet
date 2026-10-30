import { useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { earnWithdrawalRetryKind, EarnWithdrawalRetryKind } from 'lib/epoch/earn-withdraw-policy';
import {
  acknowledgementOf,
  cancelTransactionById,
  isCancellableTransaction,
  isRequeueableTransaction,
  requestSWTransactionProcessing,
  requeueFailedTransaction,
  retryEarnWithdrawReceive,
  USER_CANCELLED_TRANSACTION_REASON
} from 'lib/miden/activity';
import { ITransaction } from 'lib/miden/db/types';
import { cancelSwapOrder } from 'lib/miden/swap/cancel-order';
import { getPaybackClaimState } from 'lib/miden/swap/payback-claim';
import { ClaimFeeRefusedError } from 'lib/miden/transaction/claim-fee';
import { retryRefusalText } from 'lib/miden/transaction/retry-refusal';
import { snapshotPendingRetry, type UiEvidenceInput } from 'lib/telemetry/ui-producer-diagnostics';
import type { UserErrorId } from 'lib/telemetry/user-visible-error';
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
  cancelErrorId: UserErrorId | null;
  onCancel: () => void;

  /** Re-queue a Failed row through the FIFO loop. */
  canRetry: boolean;
  /** Set only for an `earn-withdraw`, whose Retry has its own label and path. */
  earnRetryKind: EarnWithdrawalRetryKind | undefined;
  isRetrying: boolean;
  retryError: string | null;
  retryErrorId: UserErrorId | null;
  retryErrorDiagnostics: Extract<UiEvidenceInput, { kind: 'history_retry' }> | undefined;
  /**
   * The acknowledgement the last refusal offered, exactly as rendered: it answers the attempt the user was shown
   * (#1081). Null when the refusal offers none, as the liveness refusal never does.
   */
  acknowledgement: { attemptId: string | null } | null;
  onRetry: (acknowledged?: { attemptId: string | null }) => void;

  /** Take a live swap order's offered tip back (swap rows only). */
  isCancellingOrder: boolean;
  cancelOrderError: string | null;
  cancelOrderErrorId: UserErrorId | null;
  onCancelOrder: () => void;

  /** Re-run a swap's stuck payout claim (`entry.paybackClaimStuck`) now, ahead of its daily retry. */
  isRetryingPayback: boolean;
  paybackRetryError: string | null;
  paybackRetryErrorId: UserErrorId | null;
  paybackRetryErrorDiagnostics: Extract<UiEvidenceInput, { kind: 'history_payback_retry' }> | undefined;
  onRetryPayback: () => void;
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
  const [cancelErrorId, setCancelErrorId] = useState<{ id: UserErrorId; transactionId: string } | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryErrorId, setRetryErrorId] = useState<{
    id: UserErrorId;
    transactionId: string;
    diagnostics?: Extract<UiEvidenceInput, { kind: 'history_retry' }>;
  } | null>(null);
  const [acknowledgement, setAcknowledgement] = useState<{ attemptId: string | null } | null>(null);
  const [isCancellingOrder, setIsCancellingOrder] = useState(false);
  const [cancelOrderError, setCancelOrderError] = useState<string | null>(null);
  const [cancelOrderErrorId, setCancelOrderErrorId] = useState<{ id: UserErrorId; transactionId: string } | null>(null);
  const [isRetryingPayback, setIsRetryingPayback] = useState(false);
  const [paybackRetryError, setPaybackRetryError] = useState<string | null>(null);
  const [paybackRetryErrorId, setPaybackRetryErrorId] = useState<{
    id: UserErrorId;
    transactionId: string;
    diagnostics?: Extract<UiEvidenceInput, { kind: 'history_payback_retry' }>;
  } | null>(null);

  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    setCancelError(null);
    setCancelErrorId(null);

    try {
      await cancelTransactionById(transactionId, USER_CANCELLED_TRANSACTION_REASON);
    } catch (error) {
      console.error('[HistoryDetails] Failed to cancel transaction:', error);
      setCancelError(error instanceof Error ? error.message : t('smthWentWrong'));
      setCancelErrorId({ id: error instanceof Error ? 'raw_history_cancel_failed' : 'smthWentWrong', transactionId });
    } finally {
      setIsCancelling(false);
    }
  }, [t, transactionId]);

  const handleRetry = useCallback(
    async (acknowledged?: { attemptId: string | null }) => {
      if (!entry) return;
      setIsRetrying(true);
      setRetryError(null);
      setRetryErrorId(null);
      setAcknowledgement(null);
      try {
        if (entry.txType === 'earn-withdraw') {
          await retryEarnWithdrawReceive(transactionId);
        } else {
          await requeueFailedTransaction(transactionId, acknowledged === undefined ? {} : { acknowledged });
          requestSWTransactionProcessing();
          navigate(`/generating-transaction/${encodeURIComponent(transactionId)}`);
          return;
        }
      } catch (error) {
        if (error instanceof ClaimFeeRefusedError) {
          setRetryError(t('insufficientFeeAsset'));
          setRetryErrorId({ id: 'insufficientFeeAsset', transactionId });
        } else {
          console.error('[HistoryDetails] Failed to retry transaction:', error);
          setRetryError(retryRefusalText(error, t));
          setRetryErrorId({
            id: error instanceof Error ? 'raw_history_retry_failed' : 'smthWentWrong',
            transactionId,
            diagnostics:
              error instanceof Error
                ? {
                    kind: 'history_retry',
                    retryNoticeOrigin: entry.txType === 'earn-withdraw' ? 'history_earn_receive' : 'history_primary',
                    pendingRetryReason: snapshotPendingRetry(error) ?? 'unexpected'
                  }
                : undefined
          });
        }
        setAcknowledgement(acknowledgementOf(error));
      } finally {
        setIsRetrying(false);
      }
    },
    [entry, t, transactionId]
  );

  const failedPaybackClaimId = entry?.paybackClaimStuck?.failedClaimId;
  const handleRetryPayback = useCallback(async () => {
    if (!failedPaybackClaimId) return;
    setIsRetryingPayback(true);
    setPaybackRetryError(null);
    setPaybackRetryErrorId(null);
    try {
      // Re-read first: the page's state can trail a claim the daily retry already queued, and requeueing the failed
      // row beside it would race two claims for the same notes. A fresh stuck state names the claim to retry, which
      // can be a newer failed row than the one on screen; the live read clears the notice when it is not stuck.
      let claimId = failedPaybackClaimId;
      if (transaction) {
        const fresh = await getPaybackClaimState(transaction);
        if (!fresh.stuck) return;
        claimId = fresh.failedClaimId;
      }
      // A manual retry, like the row's own Retry: it skips the daily backoff (#313) for this one claim.
      await requeueFailedTransaction(claimId, {});
      requestSWTransactionProcessing();
      navigate(`/generating-transaction/${encodeURIComponent(claimId)}`);
    } catch (error) {
      if (error instanceof ClaimFeeRefusedError) {
        setPaybackRetryError(t('insufficientFeeAsset'));
        setPaybackRetryErrorId({ id: 'insufficientFeeAsset', transactionId });
      } else {
        console.error('[HistoryDetails] Failed to retry the payout claim:', error);
        setPaybackRetryError(retryRefusalText(error, t));
        setPaybackRetryErrorId({
          id: error instanceof Error ? 'raw_history_retry_failed' : 'smthWentWrong',
          transactionId,
          diagnostics:
            error instanceof Error
              ? {
                  kind: 'history_payback_retry',
                  retryNoticeOrigin: 'history_payback',
                  pendingRetryReason: snapshotPendingRetry(error) ?? 'unexpected'
                }
              : undefined
        });
      }
    } finally {
      setIsRetryingPayback(false);
    }
  }, [failedPaybackClaimId, t, transaction, transactionId]);

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
    setCancelOrderErrorId(null);
    try {
      await cancelSwapOrder(transactionId);
    } catch (error) {
      console.error('[HistoryDetails] Failed to cancel swap order:', error);
      setCancelOrderError(error instanceof Error ? error.message : t('smthWentWrong'));
      setCancelOrderErrorId({
        id: error instanceof Error ? 'raw_history_swap_cancel_failed' : 'smthWentWrong',
        transactionId
      });
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
    cancelErrorId: cancelErrorId?.transactionId === transactionId ? cancelErrorId.id : null,
    onCancel: () => void handleCancel(),
    canRetry,
    earnRetryKind,
    isRetrying,
    retryError,
    retryErrorId: retryErrorId?.transactionId === transactionId ? retryErrorId.id : null,
    retryErrorDiagnostics: retryErrorId?.transactionId === transactionId ? retryErrorId.diagnostics : undefined,
    acknowledgement,
    onRetry: acknowledged => void handleRetry(acknowledged),
    isCancellingOrder,
    cancelOrderError,
    cancelOrderErrorId: cancelOrderErrorId?.transactionId === transactionId ? cancelOrderErrorId.id : null,
    onCancelOrder: () => void handleCancelOrder(),
    isRetryingPayback,
    paybackRetryError,
    paybackRetryErrorId: paybackRetryErrorId?.transactionId === transactionId ? paybackRetryErrorId.id : null,
    paybackRetryErrorDiagnostics:
      paybackRetryErrorId?.transactionId === transactionId ? paybackRetryErrorId.diagnostics : undefined,
    onRetryPayback: () => void handleRetryPayback()
  };
};
