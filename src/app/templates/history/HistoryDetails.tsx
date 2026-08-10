import React, { FC, useCallback, useEffect, useRef, useState, memo } from 'react';

import BigNumber from 'bignumber.js';
import clsx from 'clsx';
import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { Icon, IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import {
  cancelTransactionById,
  isRequeueableTransaction,
  isUserCancelledTransaction,
  requestSWTransactionProcessing,
  requeueFailedTransaction,
  retryEarnWithdrawReceive,
  SwapOrderState,
  USER_CANCELLED_TRANSACTION_REASON
} from 'lib/miden/activity';
import {
  IBridgedReceiveExtraInputs,
  IBridgedSendExtraInputs,
  IEarnDepositExtraInputs,
  IEarnWithdrawExtraInputs,
  ITransaction,
  ITransactionStatus
} from 'lib/miden/db/types';
import { useAllAccounts, useAccount } from 'lib/miden/front';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { useSwapOrderTrackingStore } from 'lib/miden/swap/order-tracking-store';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';
import { formatAmount } from 'lib/shared/format';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { goBack, navigate } from 'lib/woozie';
import {
  TransactionSummaryBadge,
  useTransactionSummaryBadgeContent
} from 'screens/generating-transaction/TransactionSummaryBadge';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

import AddressChip from '../AddressChip';
import HashChip from '../HashChip';
import { BridgeClaimSection } from './BridgeClaimSection';
import { DetailCard, DetailRow, ExternalLinkValue, StatusPill } from './DetailCard';
import { IHistoryEntry } from './IHistoryEntry';
import TransactionIcon, { getTransactionIconBackgroundColor } from './TransactionIcon';
import {
  BRIDGE_STATUS_LABEL_KEY,
  bridgeInRowDisplay,
  bridgeRowDisplay,
  bridgeStatusOf,
  EARN_WITHDRAW_STATUS_LABEL_KEY,
  earnWithdrawAmountFields,
  earnWithdrawToneOf,
  formatDate,
  isBridgeInEntry
} from './transactionUtils';
import { useSwapSettlementNotes } from './useSwapSettlementNotes';

const SEPOLIA_ADDRESS_URL = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;
const SEPOLIA_TX_URL = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

interface HistoryDetailsProps {
  transactionId: string;
}

/** Requested side of a swap transaction, persisted on `SwapTransaction.extraInputs`. */
interface SwapExtraInputs {
  requestedFaucetId?: string;
  requestedAmount?: bigint;
  orderId?: bigint;
}

/** Requested-token display info for the swap order tracking card. */
interface RequestedTokenInfo {
  amount: bigint;
  decimals?: number;
  symbol?: string;
}

const DISPLAY_DECIMAL_PLACES = 3;

const SectionDivider: FC<{ color: string }> = ({ color }) => (
  <div
    data-testid="history-section-divider"
    className="h-1 w-full shrink-0 rounded-full"
    style={{ backgroundColor: color }}
  />
);

/** Bridge hero amounts: "IN → OUT" with the destination token greyed, matching the activity row. */
const BridgeHeroAmounts: FC<{ entry: IHistoryEntry }> = ({ entry }) => {
  const bridgeIn = isBridgeInEntry(entry);
  const { inSymbol, outSymbol, outAmount } = bridgeIn ? bridgeInRowDisplay(entry) : bridgeRowDisplay(entry);
  const inAmount = (bridgeIn ? entry.bridgeInSourceAmount : entry.amount?.toString()) ?? '—';
  return (
    <div className="mt-1 flex max-w-full flex-wrap items-baseline justify-center gap-2 text-center font-heading font-extrabold text-[2.5rem] leading-none">
      <span className="text-heading-gray">{inAmount}</span>
      <span className="text-text-muted">{inSymbol}</span>
      <Icon name={IconName.ArrowRight} size="md" className="mx-0.5 self-center" />
      <span className="text-heading-gray">{outAmount ?? inAmount}</span>
      <span className="text-text-muted">{outSymbol}</span>
    </div>
  );
};

/** Pending/Confirmed/Failed for a bridge, derived from the route's own lifecycle. */
const BridgeStatusPill: FC<{ entry: IHistoryEntry }> = ({ entry }) => {
  const { t } = useTranslation();
  const status = bridgeStatusOf(entry);
  const tone =
    status === 'confirmed'
      ? 'bg-status-positive/15 text-status-positive'
      : status === 'failed'
        ? 'bg-status-negative/15 text-status-negative'
        : 'bg-status-pending/15 text-status-pending';
  return (
    <div className={clsx('flex items-center gap-1.5 rounded-5 px-3 py-1', tone)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span className="text-xs font-medium">{t(BRIDGE_STATUS_LABEL_KEY[status])}</span>
    </div>
  );
};

/** Pending/Confirmed/Failed pill for a Smart Deposit's solver-fulfilled lending leg (`epochStatus`). */
const EarnDepositStatusPill: FC<{ status: NonNullable<IEarnDepositExtraInputs['epochStatus']> }> = ({ status }) => {
  const { t } = useTranslation();
  const toneClass =
    status === 'confirmed'
      ? 'bg-status-positive/15 text-status-positive'
      : status === 'failed'
        ? 'bg-status-negative/15 text-status-negative'
        : 'bg-status-pending/15 text-status-pending';
  return (
    <div className={clsx('flex items-center gap-1.5 rounded-5 px-3 py-1', toneClass)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span className="text-xs font-medium">{t(status)}</span>
    </div>
  );
};

/** Redeeming/Delivering/Received/Failed pill for a Smart Withdraw, mirroring `BridgeStatusPill`. */
const EarnWithdrawStatusPill: FC<{ phase: IEarnWithdrawExtraInputs['phase'] }> = ({ phase }) => {
  const { t } = useTranslation();
  const tone = earnWithdrawToneOf(phase);
  const toneClass =
    tone === 'confirmed'
      ? 'bg-status-positive/15 text-status-positive'
      : tone === 'failed'
        ? 'bg-status-negative/15 text-status-negative'
        : 'bg-status-pending/15 text-status-pending';
  return (
    <div className={clsx('flex items-center gap-1.5 rounded-5 px-3 py-1', toneClass)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span className="text-xs font-medium">{t(EARN_WITHDRAW_STATUS_LABEL_KEY[phase])}</span>
    </div>
  );
};

function formatDisplayAmount(amount: string | number | bigint): string {
  const amountString = amount.toString();
  const displayAmount = new BigNumber(amountString);

  if (!displayAmount.isFinite()) {
    return amountString;
  }

  return displayAmount.decimalPlaces(DISPLAY_DECIMAL_PLACES, BigNumber.ROUND_DOWN).toFixed();
}

function formatFiatDisplayAmount(
  t: TFunction,
  amount: string | number | bigint,
  tokenSymbol: string,
  tokenPrices: TokenPrices
): string | undefined {
  const displayAmount = new BigNumber(amount.toString());

  if (!displayAmount.isFinite()) {
    return undefined;
  }

  const { price } = getTokenPrice(tokenPrices, tokenSymbol);
  const fiatAmount = displayAmount.abs().times(price);

  return t('historyDetailsFiatApprox', { amount: `$${fiatAmount.toFixed(2)}` });
}

/** Right-aligned stack of trimmed, copyable note ids. */
const NoteIdList: FC<{ noteIds: string[]; testId: string }> = ({ noteIds, testId }) => (
  <div data-testid={testId} className="flex min-w-0 flex-col items-end gap-1">
    {noteIds.map(noteId => (
      <HashChip key={noteId} hash={noteId} trimHash fill="#9E9E9E" copyIcon={false} />
    ))}
  </div>
);

const AccountDisplay: FC<{
  address: string | undefined;
  account: WalletAccount;
  allAccounts: WalletAccount[];
}> = memo(({ address, account, allAccounts }) => {
  const { t } = useTranslation();
  if (!address) return null;

  const getDisplayName = (publicKey: string): string | undefined => {
    if (account?.publicKey === publicKey) {
      return `${t('you')} (${account.name})`;
    }
    const matchingAccount = allAccounts.find(acc => acc.publicKey === publicKey);
    if (matchingAccount) {
      return `${t('you')} (${matchingAccount.name})`;
    }
    return undefined;
  };

  return (
    <AddressChip
      address={address}
      fill="#9E9E9E"
      className="ml-2"
      displayName={getDisplayName(address)}
      copyIcon={false}
    />
  );
});

export const HistoryDetails: FC<HistoryDetailsProps> = ({ transactionId }) => {
  const { t } = useTranslation();
  const allAccounts = useAllAccounts();
  const account = useAccount();
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  // The row is observed via Dexie liveQuery — every write (status advance,
  // extraInputs patch from the app-root watchers, cancel/retry) pushes a fresh
  // row and re-derives the view. This page polls nothing itself.
  const { row, loaded } = useTransactionRow(transactionId);
  const [entry, setEntry] = useState<IHistoryEntry | null>(null);
  const [transaction, setTransaction] = useState<ITransaction | undefined>();
  const transactionSummaryBadgeContent = useTransactionSummaryBadgeContent(transaction);
  const [deriveError, setDeriveError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Failed txs persist a friendly `error` plus the untouched thrown `rawError`;
  // this reveals the latter on demand.
  const [showFullError, setShowFullError] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // Swap order tracking: the orderId is persisted on the swap tx's extraInputs
  // by `completeSwapTransaction`; the live lineage is polled by the app-root
  // `SwapOrderTrackingManager` and read here from its store.
  const [orderId, setOrderId] = useState<string | bigint | null>(null);
  const [requestedToken, setRequestedToken] = useState<RequestedTokenInfo | null>(null);
  // Smart Withdraw metadata (market, position owner, intent nonce, phase) for the details card.
  const [earnWithdraw, setEarnWithdraw] = useState<IEarnWithdrawExtraInputs | null>(null);
  // Smart Deposit (open-position) metadata for the details card.
  const [earnDeposit, setEarnDeposit] = useState<IEarnDepositExtraInputs | null>(null);
  // liveQuery re-emits on ANY transactions-table write, so cache metadata
  // lookups per faucet — re-derives must not refetch.
  const tokenMetadataCache = useRef(new Map<string, Awaited<ReturnType<typeof getTokenMetadata>>>());
  const getCachedTokenMetadata = useCallback(async (faucetId: string) => {
    const cache = tokenMetadataCache.current;
    if (!cache.has(faucetId)) cache.set(faucetId, await getTokenMetadata(faucetId));
    return cache.get(faucetId);
  }, []);

  // Derive the display entry from the observed row. The metadata lookups are
  // async, so this is an effect (not a useMemo); the `cancelled` flag keeps a
  // stale derive from clobbering a newer one.
  useEffect(() => {
    if (!row) return;
    const tx = row;
    let cancelled = false;

    const derive = async () => {
      try {
        setDeriveError(null);
        const tokenMetadata = tx.faucetId ? await getCachedTokenMetadata(tx.faucetId) : undefined;
        if (cancelled) return;
        // Bridge metadata (route/provider, EVM destination, per-route status) lives
        // on `extraInputs`; without it the detail view can't tell Fast (Epoch) from
        // Slow (Agglayer) and defaults every bridge to the Slow route.
        const bridge: IBridgedSendExtraInputs | undefined = tx.type === 'bridged-send' ? tx.extraInputs : undefined;
        const bridgeReceive: IBridgedReceiveExtraInputs | undefined =
          tx.type === 'bridged-receive' ? tx.extraInputs : undefined;
        const earnWithdrawExtra: IEarnWithdrawExtraInputs | undefined =
          tx.type === 'earn-withdraw' ? tx.extraInputs : undefined;
        const earnDepositExtra: IEarnDepositExtraInputs | undefined =
          tx.type === 'earn-deposit' ? tx.extraInputs : undefined;
        // Source side (USDC) while in flight, destination side once the bridged
        // note was consumed — identical rule to the activity row.
        const earnWithdrawFields = earnWithdrawExtra
          ? earnWithdrawAmountFields(earnWithdrawExtra, tx.amount, tokenMetadata)
          : undefined;
        const historyEntry = {
          address: tx.accountId,
          key: `completed-${tx.id}`,
          timestamp: tx.completedAt ?? tx.initiatedAt,
          message: tx.displayMessage,
          status: tx.status,
          transactionIcon: tx.displayIcon,
          amount: earnWithdrawFields
            ? earnWithdrawFields.amount
            : tx.amount
              ? formatAmount(tx.amount, tokenMetadata?.decimals)
              : undefined,
          token: earnWithdrawFields ? earnWithdrawFields.token : tokenMetadata ? tokenMetadata.symbol : undefined,
          earnWithdrawPhase: earnWithdrawExtra?.phase,
          earnDepositStatus: earnDepositExtra?.epochStatus,
          secondaryAddress: tx.secondaryAccountId,
          txId: tx.id,
          noteType: tx.noteType,
          noteId: tx.outputNoteIds?.[0],
          externalTxId: tx.transactionId,
          faucetId: tx.faucetId,
          outputNoteIds: tx.outputNoteIds,
          txType: tx.type,
          errorMessage: tx.error,
          rawErrorMessage: tx.rawError,
          isCancelled: isUserCancelledTransaction(tx.error),
          bridgeProvider: bridge?.provider,
          bridgeDestinationAddress: bridge?.destinationAddress,
          bridgeDestinationNetwork: bridge?.destinationNetwork,
          bridgeClaimStatus: bridge?.claimStatus,
          bridgeOutputAmount: bridge?.outputAmount,
          bridgeOutputSymbol: bridge?.outputSymbol,
          bridgeIntentNonce: bridge?.intentNonce,
          bridgeFillTxHash: bridge?.fillTxHash,
          bridgeFillChainId: bridge?.fillChainId,
          bridgeEpochStatus: bridge?.epochStatus,
          bridgeInProvider: bridgeReceive?.provider,
          bridgeInSourceAddress: bridgeReceive?.sourceAddress,
          bridgeInSourceAmount: bridgeReceive?.sourceAmount,
          bridgeInSourceSymbol: bridgeReceive?.sourceSymbol,
          bridgeInEvmTxHash: bridgeReceive?.evmTxHash,
          bridgeInPhase: bridgeReceive?.phase,
          bridgeInOutputAmount: bridgeReceive?.outputAmount,
          bridgeInOutputSymbol: bridgeReceive?.outputSymbol,
          bridgeInMidenNoteId: bridgeReceive?.midenNoteId
        } as IHistoryEntry;

        if (tx.type === 'swap') {
          const extra: SwapExtraInputs = tx.extraInputs ?? {};
          if (extra.orderId != null) {
            // The DEX faucets are usually absent from assetsMetadata (where
            // getTokenMetadata would fall back to MIDEN), so resolve via the
            // swap-token registry first.
            const swapToken = getSwapTokenByFaucetId(extra.requestedFaucetId);
            const requestedMeta =
              !swapToken && extra.requestedFaucetId ? await getCachedTokenMetadata(extra.requestedFaucetId) : undefined;
            if (cancelled) return;
            setRequestedToken({
              amount: extra.requestedAmount ?? 0n,
              decimals: swapToken?.decimals ?? requestedMeta?.decimals,
              symbol: swapToken?.symbol ?? requestedMeta?.symbol
            });
            setOrderId(extra.orderId);
          }
        }

        setEarnWithdraw(earnWithdrawExtra ?? null);
        setEarnDeposit(earnDepositExtra ?? null);

        setTransaction(tx);
        setEntry(historyEntry);
      } catch (error) {
        console.error('[HistoryDetails] Failed to derive transaction view:', error);
        if (!cancelled) setDeriveError(error instanceof Error ? error.message : t('historyDetailsLoadError'));
      }
    };

    void derive();
    return () => {
      cancelled = true;
    };
  }, [row, getCachedTokenMetadata, t]);

  // Unknown id (liveQuery settled with no row) or a failed derive.
  const loadError = deriveError ?? (loaded && !row ? t('historyDetailsLoadError') : null);

  // Swap order tracking is polled at the app root (`SwapOrderTrackingManager`);
  // this page only reads its store — and revives a given-up poll on open.
  const orderKey = orderId != null ? String(orderId) : undefined;
  const trackingEntry = useSwapOrderTrackingStore(s => (orderKey !== undefined ? s.entries[orderKey] : undefined));
  const swapTracking = trackingEntry?.tracking ?? null;
  // No store entry yet = the root manager hasn't polled this order — that reads
  // as "loading", matching the old page-owned poll that fired on mount.
  const trackingLoading = trackingEntry ? trackingEntry.loading : true;
  useEffect(() => {
    if (orderKey !== undefined) useSwapOrderTrackingStore.getState().requestRefresh(orderKey);
  }, [orderKey]);

  // Settlement notes are a pure Dexie read — live, push-based, no polling.
  const settlementNotes = useSwapSettlementNotes(transaction?.type === 'swap' ? transaction.id : undefined);

  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    setCancelError(null);

    try {
      // The cancel is a Dexie write — liveQuery pushes the updated row.
      await cancelTransactionById(transactionId, USER_CANCELLED_TRANSACTION_REASON);
    } catch (error) {
      console.error('[HistoryDetails] Failed to cancel transaction:', error);
      setCancelError(error instanceof Error ? error.message : t('smthWentWrong'));
    } finally {
      setIsCancelling(false);
    }
  }, [t, transactionId]);

  // Retry a failed transaction by re-queueing it through the FIFO loop, then
  // hand off to the generating-transaction page which observes the row (and,
  // on mobile/desktop, drives the loop). A failed Smart Withdraw has no Miden
  // row to replay — the whole withdrawal is resubmitted as a BRAND NEW Epoch
  // intent (fresh nonce) reusing this same row, so the page just observes it
  // updating in place (via liveQuery) rather than navigating.
  const handleRetry = useCallback(async () => {
    if (!entry) return;
    setIsRetrying(true);
    setRetryError(null);
    try {
      if (entry.txType === 'earn-withdraw') {
        await retryEarnWithdrawReceive(transactionId);
      } else {
        await requeueFailedTransaction(transactionId);
        requestSWTransactionProcessing();
        navigate(`/generating-transaction/${encodeURIComponent(transactionId)}`);
        return; // navigating away — leave the spinner as-is
      }
    } catch (error) {
      console.error('[HistoryDetails] Failed to retry transaction:', error);
      setRetryError(error instanceof Error ? error.message : t('smthWentWrong'));
    } finally {
      setIsRetrying(false);
    }
  }, [entry, t, transactionId]);

  const orderStatusLabel = (state: SwapOrderState): string => {
    switch (state) {
      case 'filled':
        return t('orderStatusFilled');
      case 'reclaimed':
        return t('orderStatusReclaimed');
      default:
        return t('orderStatusActive');
    }
  };

  // How much of the requested amount has been filled so far, derived from the
  // original requested amount and the lineage's still-outstanding remainder.
  const filledRequested =
    requestedToken && swapTracking
      ? swapTracking.remainingRequested > requestedToken.amount
        ? 0n
        : requestedToken.amount - swapTracking.remainingRequested
      : undefined;

  // For a bridge the sender is always the Miden account; the EVM destination is
  // shown in the BridgeClaimSection (with the right explorer link), so the Miden
  // "to" row is omitted here.
  const isBridgeOut = entry?.txType === 'bridged-send' && !entry.isCancelled;
  const isBridgeIn = entry ? isBridgeInEntry(entry) && entry.txType === 'bridged-receive' : false;
  const isBridge = isBridgeOut || isBridgeIn;
  const isEarnWithdraw = entry?.txType === 'earn-withdraw' && earnWithdraw !== null;
  const isEarnDeposit = entry?.txType === 'earn-deposit' && earnDeposit !== null;
  const fromAddress = isBridgeOut
    ? entry?.address
    : isBridgeIn
      ? undefined
      : entry?.message === 'Sent'
        ? entry?.address
        : entry?.secondaryAddress;
  const toAddress = isBridgeOut
    ? undefined
    : isBridgeIn
      ? entry?.address
      : entry?.message === 'Sent'
        ? entry?.secondaryAddress
        : entry?.address;
  const settledNoteIds = settlementNotes?.settled ?? [];
  const reclaimedNoteIds = settlementNotes?.reclaimed ?? [];
  const hasNoteData =
    entry?.noteId ||
    (entry?.outputNoteIds && entry.outputNoteIds.length > 0) ||
    settledNoteIds.length > 0 ||
    reclaimedNoteIds.length > 0;
  const createdCount = entry?.outputNoteIds?.length ?? (entry?.noteId ? 1 : 0);
  const approximateUsdAmount =
    entry?.amount !== undefined && entry.token
      ? formatFiatDisplayAmount(t, entry.amount, entry.token, tokenPrices)
      : undefined;
  // The shared badge resolves its own amounts from the raw tx; for the types
  // whose hero already reads as "amount token → recipient" we override the left
  // side with the formatted history amount so both views agree.
  const historySummaryBadgeContent =
    transactionSummaryBadgeContent &&
    entry?.amount !== undefined &&
    entry.token &&
    (entry.txType === 'send' || entry.txType === 'bridged-send' || entry.txType === 'earn-deposit')
      ? {
          ...transactionSummaryBadgeContent,
          lhs: `${formatDisplayAmount(entry.amount)} ${entry.token}`
        }
      : transactionSummaryBadgeContent;
  const sectionDividerColor = entry ? getTransactionIconBackgroundColor(entry) : 'transparent';
  const isPending =
    entry?.status === ITransactionStatus.Queued || entry?.status === ITransactionStatus.GeneratingTransaction;
  // Retry only makes sense when there's something recoverable: a re-queueable
  // failed Miden tx (structural Guardian ops and earn deposits are excluded — the
  // user re-initiates those from Settings / the Earn flow), or a failed Smart
  // Withdraw, which is fully resubmittable as a brand-new Epoch intent whether or
  // not the previous one ever reached the allocator.
  const canRetry =
    entry !== null &&
    !entry.isCancelled &&
    (entry.txType === 'earn-withdraw'
      ? earnWithdraw?.phase === 'failed'
      : isRequeueableTransaction({ status: entry.status, type: entry.txType }));

  return (
    <PageLayout hideToolbar>
      <div className="flex flex-1 flex-col min-h-0 px-4">
        <ScreenHeader title={t('transaction')} backLabel={t('back')} onBack={goBack} />

        {loadError ? (
          <div className="flex-1 flex flex-col items-center justify-center p-4">
            <p className="text-red-500 text-center mb-2">{t('smthWentWrong')}</p>
            <p className="text-text-muted text-sm text-center select-text">{loadError}</p>
            <p className="text-text-muted text-xs text-center mt-2 select-text">
              {t('historyDetailsIdLabel', { id: transactionId })}
            </p>
          </div>
        ) : entry === null ? (
          <ActivitySpinner />
        ) : (
          <div className="flex-1 flex flex-col overflow-y-auto">
            {/* Top Section — a bridge reads "IN → OUT" across the two chains. */}
            <div className="flex flex-col items-center justify-center pt-6 pb-5">
              <TransactionIcon entry={entry} size="lg" />
              {historySummaryBadgeContent ? (
                <TransactionSummaryBadge {...historySummaryBadgeContent} className="mt-2" />
              ) : isBridge ? (
                <BridgeHeroAmounts entry={entry} />
              ) : (
                <div className="mt-1 flex max-w-full items-baseline justify-center gap-2 text-center font-heading font-extrabold text-[2.5rem] leading-none">
                  {entry.amount !== undefined && (
                    <span className="text-heading-gray">{formatDisplayAmount(entry.amount)}</span>
                  )}
                  {entry.token && <span className="text-text-muted">{entry.token}</span>}
                </div>
              )}
              {approximateUsdAmount && <p className="text-sm font-medium text-gray">{approximateUsdAmount}</p>}
              <div className="mt-2">
                {isBridge ? (
                  <BridgeStatusPill entry={entry} />
                ) : isEarnWithdraw && earnWithdraw ? (
                  <EarnWithdrawStatusPill phase={earnWithdraw.phase} />
                ) : isEarnDeposit && earnDeposit && entry.status === ITransactionStatus.Completed ? (
                  // Miden note landed — the pill tracks the solver-fulfilled
                  // lending leg instead of the (long-settled) Miden tx status.
                  <EarnDepositStatusPill status={earnDeposit.epochStatus ?? 'pending'} />
                ) : (
                  <StatusPill status={entry.status} isCancelled={entry.isCancelled} />
                )}
              </div>
            </div>

            {/* Transfer Details */}
            <div className="mt-4">
              <SectionDivider color={sectionDividerColor} />
              <div className="mt-5">
                <DetailCard title={t('transferDetails')}>
                  <DetailRow label={t('date')}>
                    <span className="text-sm text-heading-gray font-medium">{formatDate(entry.timestamp)}</span>
                  </DetailRow>

                  {isBridgeIn && entry.bridgeInSourceAddress && (
                    <DetailRow label={t('from')}>
                      <ExternalLinkValue
                        displayValue={
                          <HashChip
                            hash={entry.bridgeInSourceAddress}
                            trimHash
                            fill="#9E9E9E"
                            className="ml-2"
                            copyIcon={false}
                          />
                        }
                        href={SEPOLIA_ADDRESS_URL(entry.bridgeInSourceAddress)}
                      />
                    </DetailRow>
                  )}

                  {entry.externalTxId && (
                    <DetailRow label={t('txIdLabel')}>
                      <ExternalLinkValue
                        displayValue={
                          <HashChip
                            hash={entry.externalTxId}
                            trimHash
                            fill="#9E9E9E"
                            className="ml-2"
                            copyIcon={false}
                          />
                        }
                        href={`https://testnet.midenscan.com/tx/${entry.externalTxId}`}
                      />
                    </DetailRow>
                  )}

                  {fromAddress && (
                    <DetailRow label={t('from')}>
                      <ExternalLinkValue
                        displayValue={
                          <AccountDisplay address={fromAddress} account={account} allAccounts={allAccounts} />
                        }
                        href={`https://testnet.midenscan.com/account/${fromAddress}`}
                      />
                    </DetailRow>
                  )}

                  {toAddress && (
                    <DetailRow label={t('to')} isLast>
                      <ExternalLinkValue
                        displayValue={
                          <AccountDisplay address={toAddress} account={account} allAccounts={allAccounts} />
                        }
                        href={`https://testnet.midenscan.com/account/${toAddress}`}
                      />
                    </DetailRow>
                  )}
                </DetailCard>
              </div>
            </div>

            {/* Smart Withdraw details (market, position owner, intent, note) */}
            {isEarnWithdraw && earnWithdraw && (
              <div className="mt-6">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('earnWithdrawDetailsTitle')}>
                    <DetailRow label={t('earnMarketLabel')}>
                      <span className="text-sm text-heading-gray font-medium select-text">
                        {earnWithdraw.marketUid.split(':')[0] || earnWithdraw.marketUid}
                      </span>
                    </DetailRow>
                    <DetailRow label={t('positionOwnerLabel')}>
                      <ExternalLinkValue
                        displayValue={
                          <HashChip
                            hash={earnWithdraw.evmOwner}
                            trimHash
                            fill="#9E9E9E"
                            className="ml-2"
                            copyIcon={false}
                          />
                        }
                        href={SEPOLIA_ADDRESS_URL(earnWithdraw.evmOwner)}
                      />
                    </DetailRow>
                    {earnWithdraw.withdrawIntentNonce && (
                      <DetailRow label={t('redeemIntentLabel')}>
                        <HashChip
                          hash={earnWithdraw.withdrawIntentNonce}
                          trimHash
                          fill="#9E9E9E"
                          className="ml-2"
                          copyIcon={false}
                        />
                      </DetailRow>
                    )}
                    {earnWithdraw.evmTxHash && (
                      <DetailRow label={t('txIdLabel')}>
                        <ExternalLinkValue
                          displayValue={
                            <HashChip
                              hash={earnWithdraw.evmTxHash}
                              trimHash
                              fill="#9E9E9E"
                              className="ml-2"
                              copyIcon={false}
                            />
                          }
                          href={SEPOLIA_TX_URL(earnWithdraw.evmTxHash)}
                        />
                      </DetailRow>
                    )}
                    <DetailRow label={t('note')} isLast={earnWithdraw.phase !== 'failed'}>
                      <span className="text-sm text-heading-gray font-medium select-text">
                        {earnWithdraw.midenNoteId ? (
                          <HashChip
                            hash={earnWithdraw.midenNoteId}
                            trimHash
                            fill="#9E9E9E"
                            className="ml-2"
                            copyIcon={false}
                          />
                        ) : (
                          t('pending')
                        )}
                      </span>
                    </DetailRow>
                    {earnWithdraw.phase === 'failed' && earnWithdraw.error && (
                      <DetailRow label={t('error')} isLast>
                        <span className="text-sm text-status-negative font-medium wrap-break-word select-text">
                          {earnWithdraw.error}
                        </span>
                      </DetailRow>
                    )}
                  </DetailCard>
                </div>
              </div>
            )}

            {/* Smart Deposit details (market, position owner, intent, Sepolia tx) */}
            {isEarnDeposit && earnDeposit && (
              <div className="mt-6">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('earnDepositDetailsTitle')}>
                    <DetailRow label={t('earnMarketLabel')}>
                      <span className="text-sm text-heading-gray font-medium select-text">
                        {earnDeposit.marketUid.split(':')[0] || earnDeposit.marketUid}
                      </span>
                    </DetailRow>
                    <DetailRow
                      label={t('positionOwnerLabel')}
                      isLast={!earnDeposit.intentNonce && !earnDeposit.evmTxHash}
                    >
                      <ExternalLinkValue
                        displayValue={
                          <HashChip
                            hash={earnDeposit.evmRecipient}
                            trimHash
                            fill="#9E9E9E"
                            className="ml-2"
                            copyIcon={false}
                          />
                        }
                        href={SEPOLIA_ADDRESS_URL(earnDeposit.evmRecipient)}
                      />
                    </DetailRow>
                    {earnDeposit.intentNonce && (
                      <DetailRow label={t('depositIntentLabel')} isLast={!earnDeposit.evmTxHash}>
                        <HashChip
                          hash={earnDeposit.intentNonce}
                          trimHash
                          fill="#9E9E9E"
                          className="ml-2"
                          copyIcon={false}
                        />
                      </DetailRow>
                    )}
                    {earnDeposit.evmTxHash && (
                      <DetailRow label={t('txIdLabel')} isLast>
                        <ExternalLinkValue
                          displayValue={
                            <HashChip
                              hash={earnDeposit.evmTxHash}
                              trimHash
                              fill="#9E9E9E"
                              className="ml-2"
                              copyIcon={false}
                            />
                          }
                          href={SEPOLIA_TX_URL(earnDeposit.evmTxHash)}
                        />
                      </DetailRow>
                    )}
                  </DetailCard>
                </div>
              </div>
            )}

            {/* Failure reason (persisted on `tx.error` by cancelTransaction) */}
            {(entry.status === ITransactionStatus.Failed || (isBridgeIn && entry.bridgeInPhase === 'failed')) &&
              entry.errorMessage && (
                <div className="mt-6">
                  <SectionDivider color={sectionDividerColor} />
                  <div className="mt-5">
                    <DetailCard title={entry.isCancelled ? t('cancelled') : t('error')}>
                      <p
                        className={clsx(
                          'px-4 py-3 text-sm font-medium wrap-break-word select-text',
                          entry.isCancelled ? 'text-gray-500' : 'text-status-negative'
                        )}
                      >
                        {entry.errorMessage}
                      </p>
                      {entry.rawErrorMessage && (
                        <div className="px-4 pb-3">
                          <button
                            type="button"
                            className="text-sm font-medium text-text-muted underline"
                            onClick={() => setShowFullError(v => !v)}
                          >
                            {showFullError ? t('hideFullError') : t('showFullError')}
                          </button>
                          {showFullError && (
                            <p className="mt-2 text-xs font-medium text-text-muted wrap-break-word select-text">
                              {entry.rawErrorMessage}
                            </p>
                          )}
                        </div>
                      )}
                    </DetailCard>
                  </div>
                </div>
              )}

            {/* Bridge route + EVM-side claim (bridged-send only) */}
            {isBridgeOut && (
              <>
                <div className="mt-6">
                  <SectionDivider color={sectionDividerColor} />
                </div>
                <BridgeClaimSection entry={entry} />
              </>
            )}

            {/* Inbound bridge details (bridged-receive only) */}
            {isBridgeIn && (
              <div className="mt-6 mb-4">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('bridgeDetails')}>
                    <DetailRow label={t('route')}>
                      <span className="text-sm text-heading-gray font-medium">
                        {entry.bridgeInProvider === 'epoch' ? t('fastRouteLabel') : t('slowRouteLabel')}
                      </span>
                    </DetailRow>
                    {entry.bridgeInEvmTxHash && (
                      <DetailRow label={t('txIdLabel')}>
                        <ExternalLinkValue
                          displayValue={
                            <HashChip
                              hash={entry.bridgeInEvmTxHash}
                              trimHash
                              fill="#9E9E9E"
                              className="ml-2"
                              copyIcon={false}
                            />
                          }
                          href={SEPOLIA_TX_URL(entry.bridgeInEvmTxHash)}
                        />
                      </DetailRow>
                    )}
                    <DetailRow label={t('noteId')} isLast>
                      <span className="text-sm text-heading-gray font-medium">
                        {entry.bridgeInMidenNoteId ? (
                          <HashChip
                            hash={entry.bridgeInMidenNoteId}
                            trimHash
                            fill="#9E9E9E"
                            className="ml-2"
                            copyIcon={false}
                          />
                        ) : (
                          t('pending')
                        )}
                      </span>
                    </DetailRow>
                  </DetailCard>
                </div>
              </div>
            )}

            {/* Swap order tracking */}
            {entry.txType === 'swap' && orderId != null && (
              <div className="mt-6" data-testid="swap-order-card">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('orderTracking')}>
                    <DetailRow label={t('orderStatus')} isLast={!swapTracking}>
                      {swapTracking ? (
                        <div className="flex items-center gap-2">
                          <span data-testid="swap-order-status" className="text-sm text-heading-gray font-medium">
                            {orderStatusLabel(swapTracking.state)}
                          </span>
                          {trackingLoading && (
                            <span
                              data-testid="swap-order-polling"
                              className="flex items-center gap-1.5 text-xs font-medium text-text-muted"
                            >
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary-500" />
                              {t('loading')}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span
                          data-testid={trackingLoading ? 'swap-order-polling' : undefined}
                          className="text-sm text-text-muted font-medium"
                        >
                          {trackingLoading ? t('loading') : t('trackingUnavailable')}
                        </span>
                      )}
                    </DetailRow>
                    {swapTracking && (
                      <DetailRow label={t('fillRounds')} isLast={!requestedToken}>
                        <span data-testid="swap-order-fill-rounds" className="text-sm text-heading-gray font-medium">
                          {swapTracking.currentDepth}
                        </span>
                      </DetailRow>
                    )}
                    {swapTracking && requestedToken && (
                      <DetailRow label={t('amountFilled')} isLast>
                        <span data-testid="swap-order-amount-filled" className="text-sm text-heading-gray font-medium">
                          {t('historyDetailsAmountFilledValue', {
                            filled: formatAmount(filledRequested ?? 0n, requestedToken.decimals),
                            total: formatAmount(requestedToken.amount, requestedToken.decimals),
                            symbol: requestedToken.symbol ? ` ${requestedToken.symbol}` : ''
                          })}
                        </span>
                      </DetailRow>
                    )}
                  </DetailCard>
                </div>
              </div>
            )}

            {/* Notes */}
            {hasNoteData && (
              <div className="mt-6 mb-4">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('notesSection')}>
                    <DetailRow
                      label={t('created')}
                      isLast={settledNoteIds.length === 0 && reclaimedNoteIds.length === 0}
                    >
                      <span className="text-sm text-heading-gray font-medium">{createdCount}</span>
                    </DetailRow>

                    {/* Swap settlement: the notes the suppressed consume rows claimed. */}
                    {settledNoteIds.length > 0 && (
                      <DetailRow label={t('claimed')} isLast={reclaimedNoteIds.length === 0}>
                        <NoteIdList noteIds={settledNoteIds} testId="swap-settled-notes" />
                      </DetailRow>
                    )}

                    {reclaimedNoteIds.length > 0 && (
                      <DetailRow label={t('reclaimed')} isLast>
                        <NoteIdList noteIds={reclaimedNoteIds} testId="swap-reclaimed-notes" />
                      </DetailRow>
                    )}
                  </DetailCard>
                </div>
              </div>
            )}
          </div>
        )}

        {isPending && (
          <div className="shrink-0 pt-3 pb-4">
            {cancelError && <p className="mb-2 text-center text-sm text-status-negative">{cancelError}</p>}
            <Button
              variant={ButtonVariant.Primary}
              title={t('cancel')}
              isLoading={isCancelling}
              disabled={isCancelling}
              onClick={handleCancel}
              className="max-w-none bg-status-negative hover:bg-status-negative focus:bg-status-negative"
            />
          </div>
        )}

        {canRetry && (
          <div className="shrink-0 pt-3 pb-4">
            {retryError && <p className="mb-2 text-center text-sm text-status-negative">{retryError}</p>}
            <Button
              variant={ButtonVariant.Primary}
              title={t('retry')}
              isLoading={isRetrying}
              disabled={isRetrying}
              onClick={handleRetry}
              className="max-w-none"
            />
          </div>
        )}
      </div>
    </PageLayout>
  );
};
