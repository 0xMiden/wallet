import React, { FC, useCallback, useEffect, useRef, useState, memo } from 'react';

import BigNumber from 'bignumber.js';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { Icon, IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import {
  cancelTransactionById,
  getTransactionById,
  isUserCancelledTransaction,
  trackOrderId,
  SwapOrderState,
  SwapOrderTracking,
  USER_CANCELLED_TRANSACTION_REASON
} from 'lib/miden/activity';
import {
  IBridgedReceiveExtraInputs,
  IBridgedSendExtraInputs,
  IEarnWithdrawExtraInputs,
  ITransactionStatus
} from 'lib/miden/db/types';
import { useAllAccounts, useAccount } from 'lib/miden/front';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';
import { formatAmount } from 'lib/shared/format';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { goBack } from 'lib/woozie';

import AddressChip from '../AddressChip';
import HashChip from '../HashChip';
import { BridgeClaimSection } from './BridgeClaimSection';
import { DetailCard, DetailRow, ExternalLinkValue, StatusPill } from './DetailCard';
import { IHistoryEntry } from './IHistoryEntry';
import TransactionIcon from './TransactionIcon';
import {
  BRIDGE_STATUS_LABEL_KEY,
  bridgeInRowDisplay,
  bridgeRowDisplay,
  bridgeStatusOf,
  EARN_WITHDRAW_STATUS_LABEL_KEY,
  earnWithdrawToneOf,
  formatDate,
  formatEarnWithdrawAmount,
  isBridgeInEntry
} from './transactionUtils';

const SEPOLIA_ADDRESS_URL = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;
const SEPOLIA_TX_URL = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

const isHexEvmAddress = (value: string | undefined): value is `0x${string}` =>
  value !== undefined && /^0x[0-9a-fA-F]{40}$/.test(value);

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

  return `≈ $${fiatAmount.toFixed(2)} USD`;
}

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
  const [entry, setEntry] = useState<IHistoryEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Swap order tracking: the orderId is persisted on the swap tx's extraInputs
  // by `completeSwapTransaction`; the live lineage is fetched via `trackOrderId`.
  const [orderId, setOrderId] = useState<string | bigint | null>(null);
  const [requestedToken, setRequestedToken] = useState<RequestedTokenInfo | null>(null);
  const [swapTracking, setSwapTracking] = useState<SwapOrderTracking | null>(null);
  const [trackingLoading, setTrackingLoading] = useState(false);
  // Smart Withdraw metadata (market, position owner, intent nonce, phase) for the details card.
  const [earnWithdraw, setEarnWithdraw] = useState<IEarnWithdrawExtraInputs | null>(null);
  // Guards the earn-withdraw delivery poller so it is (re)started at most once per
  // intent nonce, even though the reload loop re-runs the effect as the row advances.
  const withdrawPollNonceRef = useRef<string | null>(null);
  const loadTransaction = useCallback(async () => {
    try {
      setLoadError(null);
      const tx = await getTransactionById(transactionId);
      const tokenMetadata = tx.faucetId ? await getTokenMetadata(tx.faucetId) : undefined;
      console.log('Loaded transaction for HistoryDetails:', tx, tokenMetadata);
      // Bridge metadata (route/provider, EVM destination, per-route status) lives
      // on `extraInputs`; without it the detail view can't tell Fast (Epoch) from
      // Slow (Agglayer) and defaults every bridge to the Slow route.
      const bridge: IBridgedSendExtraInputs | undefined = tx.type === 'bridged-send' ? tx.extraInputs : undefined;
      const bridgeReceive: IBridgedReceiveExtraInputs | undefined =
        tx.type === 'bridged-receive' ? tx.extraInputs : undefined;
      const earnWithdrawExtra = tx.type === 'earn-withdraw' ? (tx.extraInputs as IEarnWithdrawExtraInputs) : undefined;
      const historyEntry = {
        address: tx.accountId,
        key: `completed-${tx.id}`,
        timestamp: tx.completedAt ?? tx.initiatedAt,
        message: tx.displayMessage,
        status: tx.status,
        transactionIcon: tx.displayIcon,
        // Earn withdraw: show the human source amount (USDC), not the atomic row
        // amount (whose faucetId is the native asset — wrong decimals).
        amount: earnWithdrawExtra
          ? formatEarnWithdrawAmount(earnWithdrawExtra.sourceAmount)
          : tx.amount
            ? formatAmount(tx.amount, tokenMetadata?.decimals)
            : undefined,
        token: earnWithdrawExtra ? earnWithdrawExtra.sourceSymbol : tokenMetadata?.symbol,
        secondaryAddress: tx.secondaryAccountId,
        txId: tx.id,
        noteType: tx.noteType,
        noteId: tx.outputNoteIds?.[0],
        externalTxId: tx.transactionId,
        faucetId: tx.faucetId,
        outputNoteIds: tx.outputNoteIds,
        txType: tx.type,
        errorMessage: tx.error,
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
            !swapToken && extra.requestedFaucetId ? await getTokenMetadata(extra.requestedFaucetId) : undefined;
          setRequestedToken({
            amount: extra.requestedAmount ?? 0n,
            decimals: swapToken?.decimals ?? requestedMeta?.decimals,
            symbol: swapToken?.symbol ?? requestedMeta?.symbol
          });
          setOrderId(extra.orderId);
        }
      }

      setEarnWithdraw(tx.type === 'earn-withdraw' ? (tx.extraInputs as IEarnWithdrawExtraInputs) : null);

      setEntry(historyEntry);
    } catch (error) {
      console.error('[HistoryDetails] Failed to load transaction:', error);
      setLoadError(error instanceof Error ? error.message : 'Failed to load transaction');
    }
  }, [transactionId, setEntry]);

  useEffect(() => {
    if (!entry && !loadError) loadTransaction();
  }, [loadTransaction, entry, loadError]);

  // A non-bridge detail page can be opened while proving/submission is still in
  // progress. Bridge refresh/poll ownership belongs to its home PromptCard.
  useEffect(() => {
    if (entry?.txType === 'bridged-send' || entry?.txType === 'bridged-receive') return;
    if (entry?.status !== ITransactionStatus.Queued && entry?.status !== ITransactionStatus.GeneratingTransaction) {
      return;
    }

    const timer = setInterval(() => void loadTransaction(), 3000);
    return () => clearInterval(timer);
  }, [entry?.status, entry?.txType, loadTransaction]);

  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    setCancelError(null);

    try {
      await cancelTransactionById(transactionId, USER_CANCELLED_TRANSACTION_REASON);
      await loadTransaction();
    } catch (error) {
      console.error('[HistoryDetails] Failed to cancel transaction:', error);
      setCancelError(error instanceof Error ? error.message : t('smthWentWrong'));
    } finally {
      setIsCancelling(false);
    }
  }, [loadTransaction, t, transactionId]);

  // Poll the swap order lineage every 3s until it reaches a terminal state
  // (filled or reclaimed). The orderId is persisted on the swap tx; the live
  // lineage is fetched via `trackOrderId`.
  useEffect(() => {
    if (orderId == null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const POLL_INTERVAL_MS = 3000;

    const poll = async () => {
      try {
        const result = await trackOrderId(orderId);
        if (cancelled) return;
        setSwapTracking(result);
        // Keep polling while the order is still active (or not yet trackable).
        if (result === null || result.state === 'active') {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (error) {
        console.error('[HistoryDetails] Failed to track swap order:', error);
        if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
      } finally {
        if (!cancelled) setTrackingLoading(false);
      }
    };

    setTrackingLoading(true);
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderId]);

  // Drive a live phase on a Smart Withdraw's detail page. The row advances through
  // Redeeming → Delivering (Epoch intent settles) → Received (bridged note consumed).
  // The initiating context's background poller may be gone (extension popup closed),
  // so this page (re)starts the delivery poller AND reloads the row on an interval —
  // the `received` flip lands via auto-consume tagging, not the poller, so a reload
  // loop is what surfaces it. Runs only while the phase is non-terminal.
  const withdrawPhase = earnWithdraw?.phase;
  const withdrawNonce = earnWithdraw?.withdrawIntentNonce;
  const withdrawOwner = earnWithdraw?.evmOwner;
  useEffect(() => {
    if (entry?.txType !== 'earn-withdraw') return;
    if (withdrawPhase === 'received' || withdrawPhase === 'failed' || withdrawPhase === undefined) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const POLL_INTERVAL_MS = 3000;

    // Kick a delivery poller at most once per nonce — it advances the Dexie row
    // even if no other context is running one. Idempotent if one already is.
    if (withdrawNonce && isHexEvmAddress(withdrawOwner) && withdrawPollNonceRef.current !== withdrawNonce) {
      const sponsorAddress = withdrawOwner;
      const nonce = withdrawNonce;
      withdrawPollNonceRef.current = nonce;
      import('lib/epoch')
        .then(({ pollEarnWithdrawDelivery }) =>
          pollEarnWithdrawDelivery({ sponsorAddress, nonce, txId: transactionId })
        )
        .catch(err => console.warn('[earn-withdraw] detail-page poll start failed', err));
    }

    const tick = async () => {
      await loadTransaction();
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [entry?.txType, withdrawPhase, withdrawNonce, withdrawOwner, transactionId, loadTransaction]);

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
  const hasNoteData = entry?.noteId || (entry?.outputNoteIds && entry.outputNoteIds.length > 0);
  const createdCount = entry?.outputNoteIds?.length ?? (entry?.noteId ? 1 : 0);
  const approximateUsdAmount =
    entry?.amount !== undefined && entry.token
      ? formatFiatDisplayAmount(entry.amount, entry.token, tokenPrices)
      : undefined;
  const isPending =
    entry?.status === ITransactionStatus.Queued || entry?.status === ITransactionStatus.GeneratingTransaction;

  return (
    <PageLayout hideToolbar>
      <div className="flex flex-1 flex-col min-h-0 px-4">
        <ScreenHeader title={t('transaction')} backLabel={t('back')} onBack={goBack} />

        {loadError ? (
          <div className="flex-1 flex flex-col items-center justify-center p-4">
            <p className="text-red-500 text-center mb-2">{t('smthWentWrong')}</p>
            <p className="text-text-muted text-sm text-center select-text">{loadError}</p>
            <p className="text-text-muted text-xs text-center mt-2 select-text">ID: {transactionId}</p>
          </div>
        ) : entry === null ? (
          <ActivitySpinner />
        ) : (
          <div className="flex-1 flex flex-col overflow-y-auto">
            {/* Top Section — a bridge reads "IN → OUT" across the two chains. */}
            <div className="flex flex-col items-center justify-center pt-6 pb-5">
              <TransactionIcon entry={entry} size="lg" />
              {isBridge ? (
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
                ) : (
                  <StatusPill status={entry.status} isCancelled={entry.isCancelled} />
                )}
              </div>
            </div>

            {/* Transfer Details */}
            <div className="mt-4">
              <DetailCard title={t('transferDetails')}>
                <DetailRow label={t('date')}>
                  <span className="text-sm text-heading-gray font-medium">{formatDate(entry.timestamp)}</span>
                </DetailRow>

                {entry.externalTxId && (
                  <DetailRow label={t('txIdLabel')}>
                    <ExternalLinkValue
                      displayValue={
                        <HashChip hash={entry.externalTxId} trimHash fill="#9E9E9E" className="ml-2" copyIcon={false} />
                      }
                      href={`https://testnet.midenscan.com/tx/${entry.externalTxId}`}
                    />
                  </DetailRow>
                )}

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
                      displayValue={<AccountDisplay address={toAddress} account={account} allAccounts={allAccounts} />}
                      href={`https://testnet.midenscan.com/account/${toAddress}`}
                    />
                  </DetailRow>
                )}
              </DetailCard>
            </div>

            {/* Smart Withdraw details (market, position owner, intent, note) */}
            {isEarnWithdraw && earnWithdraw && (
              <div className="mt-6">
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
                  <DetailRow label="Note" isLast={earnWithdraw.phase !== 'failed'}>
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
            )}

            {/* Failure reason (persisted on `tx.error` by cancelTransaction) */}
            {(entry.status === ITransactionStatus.Failed || (isBridgeIn && entry.bridgeInPhase === 'failed')) &&
              entry.errorMessage && (
                <div className="mt-6">
                  <DetailCard title={entry.isCancelled ? t('cancelled') : t('error')}>
                    <p
                      className={clsx(
                        'px-4 py-3 text-sm font-medium wrap-break-word select-text',
                        entry.isCancelled ? 'text-gray-500' : 'text-status-negative'
                      )}
                    >
                      {entry.errorMessage}
                    </p>
                  </DetailCard>
                </div>
              )}

            {/* Bridge route + EVM-side claim (bridged-send only) */}
            {isBridgeOut && <BridgeClaimSection entry={entry} onUpdated={loadTransaction} />}

            {isBridgeIn && (
              <div className="mt-6 mb-4">
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
                  <DetailRow label="Note" isLast>
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
            )}

            {/* Swap order tracking */}
            {entry.txType === 'swap' && orderId != null && (
              <div className="mt-6">
                <DetailCard title={t('orderTracking')}>
                  <DetailRow label={t('orderStatus')} isLast={!swapTracking}>
                    {swapTracking ? (
                      <span className="text-sm text-heading-gray font-medium">
                        {orderStatusLabel(swapTracking.state)}
                      </span>
                    ) : (
                      <span className="text-sm text-text-muted font-medium">
                        {trackingLoading ? t('loading') : t('trackingUnavailable')}
                      </span>
                    )}
                  </DetailRow>
                  {swapTracking && (
                    <DetailRow label={t('fillRounds')} isLast={!requestedToken}>
                      <span className="text-sm text-heading-gray font-medium">{swapTracking.currentDepth}</span>
                    </DetailRow>
                  )}
                  {swapTracking && requestedToken && (
                    <DetailRow label={t('amountFilled')} isLast>
                      <span className="text-sm text-heading-gray font-medium">
                        {formatAmount(filledRequested ?? 0n, requestedToken.decimals)} /{' '}
                        {formatAmount(requestedToken.amount, requestedToken.decimals)}
                        {requestedToken.symbol ? ` ${requestedToken.symbol}` : ''}
                      </span>
                    </DetailRow>
                  )}
                </DetailCard>
              </div>
            )}

            {/* Notes */}
            {hasNoteData && (
              <div className="mt-6 mb-4">
                <DetailCard title={t('notesSection')}>
                  <DetailRow label={t('created')}>
                    <span className="text-sm text-heading-gray font-medium">{createdCount}</span>
                  </DetailRow>
                  <DetailRow label="Note" isLast>
                    <span className={`text-sm font-medium ${entry.noteType ? 'text-[#E8913A]' : 'text-text-muted'}`}>
                      {entry.noteType ? t('on') : t('off')}
                    </span>
                  </DetailRow>
                </DetailCard>
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
      </div>
    </PageLayout>
  );
};
