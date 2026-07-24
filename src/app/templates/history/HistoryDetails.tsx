import React, { FC, useCallback, useEffect, useState, memo } from 'react';

import BigNumber from 'bignumber.js';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { Icon, IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { ScreenHeader } from 'components/ScreenHeader';
import {
  getSwapSettlementNotes,
  getTransactionById,
  trackOrderId,
  SwapOrderState,
  SwapOrderTracking,
  SwapSettlementNotes
} from 'lib/miden/activity';
import { ITransaction } from 'lib/miden/db/types';
import { useAllAccounts, useAccount } from 'lib/miden/front';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';
import { formatAmount } from 'lib/shared/format';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { goBack } from 'lib/woozie';
import {
  TransactionSummaryBadge,
  useTransactionSummaryBadgeContent
} from 'screens/generating-transaction/TransactionSummaryBadge';

import AddressChip from '../AddressChip';
import HashChip from '../HashChip';
import { BridgeClaimSection } from './BridgeClaimSection';
import { DetailCard, DetailRow, ExternalLinkValue, StatusPill } from './DetailCard';
import { IHistoryEntry } from './IHistoryEntry';
import TransactionIcon, { getTransactionIconBackgroundColor } from './TransactionIcon';
import { BRIDGE_STATUS_LABEL_KEY, bridgeRowDisplay, bridgeStatusOf, formatDate } from './transactionUtils';

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
  const { inSymbol, outSymbol, outAmount } = bridgeRowDisplay(entry);
  const inAmount = entry.amount?.toString() ?? '—';
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
  const [entry, setEntry] = useState<IHistoryEntry | null>(null);
  const [transaction, setTransaction] = useState<ITransaction | undefined>();
  const transactionSummaryBadgeContent = useTransactionSummaryBadgeContent(transaction);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Swap order tracking: the orderId is persisted on the swap tx's extraInputs
  // by `completeSwapTransaction`; the live lineage is fetched via `trackOrderId`.
  const [orderId, setOrderId] = useState<string | bigint | null>(null);
  const [requestedToken, setRequestedToken] = useState<RequestedTokenInfo | null>(null);
  const [swapTracking, setSwapTracking] = useState<SwapOrderTracking | null>(null);
  const [trackingLoading, setTrackingLoading] = useState(false);
  // Notes claimed by this order's settlement consumes. Those consume rows are
  // suppressed in the history list (the swap row is the order's single trace),
  // so this page is where their notes stay visible.
  const [settlementNotes, setSettlementNotes] = useState<SwapSettlementNotes | null>(null);
  const loadTransaction = useCallback(async () => {
    try {
      setLoadError(null);
      const tx = await getTransactionById(transactionId);
      const tokenMetadata = tx.faucetId ? await getTokenMetadata(tx.faucetId) : undefined;
      console.log('Loaded transaction for HistoryDetails:', tx, tokenMetadata);
      const historyEntry = {
        address: tx.accountId,
        key: `completed-${tx.id}`,
        timestamp: tx.completedAt,
        message: tx.displayMessage,
        status: tx.status,
        transactionIcon: tx.displayIcon,
        amount: tx.amount ? formatAmount(tx.amount, tokenMetadata?.decimals) : undefined,
        token: tokenMetadata ? tokenMetadata.symbol : undefined,
        secondaryAddress: tx.secondaryAccountId,
        txId: tx.id,
        noteType: tx.noteType,
        noteId: tx.outputNoteIds?.[0],
        externalTxId: tx.transactionId,
        faucetId: tx.faucetId,
        outputNoteIds: tx.outputNoteIds,
        txType: tx.type
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

      if (tx.type === 'swap') {
        setSettlementNotes(await getSwapSettlementNotes(tx.id));
      }

      setTransaction(tx);
      setEntry(historyEntry);
    } catch (error) {
      console.error('[HistoryDetails] Failed to load transaction:', error);
      setLoadError(error instanceof Error ? error.message : 'Failed to load transaction');
    }
  }, [transactionId, setEntry]);

  useEffect(() => {
    if (!entry && !loadError) loadTransaction();
  }, [loadTransaction, entry, loadError]);

  // Poll the swap order lineage until it reaches a terminal state (filled or
  // reclaimed). The orderId is persisted on the swap tx; the live lineage is
  // fetched via `trackOrderId`. Each poll takes the WASM client lock, so a
  // `null`/error result (not-yet-trackable or an order this client can't
  // resolve) backs off exponentially and gives up after a cap, rather than
  // hammering the lock every 3s forever. A genuinely `active` order resets the
  // backoff and keeps a steady watch at the base interval.
  useEffect(() => {
    if (orderId == null) return;
    // Capture the non-null id in a const so the narrowing survives into the
    // hoisted `poll` declaration below (a function declaration wouldn't inherit
    // the `orderId != null` guard otherwise).
    const trackedOrderId = orderId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const BASE_INTERVAL_MS = 3000;
    const MAX_INTERVAL_MS = 30_000;
    const MAX_UNRESOLVED_POLLS = 20;
    let unresolved = 0;

    // Exponential backoff for unresolved polls, capped; give up after the cap.
    const scheduleUnresolvedRetry = () => {
      unresolved += 1;
      if (!cancelled && unresolved < MAX_UNRESOLVED_POLLS) {
        const delay = Math.min(BASE_INTERVAL_MS * 2 ** (unresolved - 1), MAX_INTERVAL_MS);
        timer = setTimeout(poll, delay);
      }
    };

    async function poll() {
      try {
        const result = await trackOrderId(trackedOrderId);
        if (cancelled) return;
        setSwapTracking(result);
        if (result === null) {
          // Not yet trackable / not found — back off and eventually give up.
          scheduleUnresolvedRetry();
        } else if (result.state === 'active') {
          // Live and resolving; steady watch until a terminal state.
          unresolved = 0;
          timer = setTimeout(poll, BASE_INTERVAL_MS);
        }
        // filled / reclaimed → terminal, stop polling.
      } catch (error) {
        console.error('[HistoryDetails] Failed to track swap order:', error);
        if (!cancelled) scheduleUnresolvedRetry();
      } finally {
        if (!cancelled) setTrackingLoading(false);
      }
    }

    setTrackingLoading(true);
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderId]);

  // Settlement can land while this page is open (auto-consume runs on its own
  // 3s cycle), and the lineage poll above stops at a terminal state — usually
  // just *before* the settlement consume completes. So watch for the notes
  // separately: cheap Dexie-only reads, stopping as soon as any arrive and
  // giving up after a cap so a manual-claim order doesn't poll forever.
  const settlementFound = Boolean(
    settlementNotes && (settlementNotes.settled.length || settlementNotes.reclaimed.length)
  );
  useEffect(() => {
    if (orderId == null || settlementFound || !transaction) return;
    const swapTxId = transaction.id;
    const POLL_INTERVAL_MS = 3000;
    const MAX_POLLS = 20;
    let polls = 0;
    let cancelled = false;

    const timer = setInterval(async () => {
      polls += 1;
      if (polls > MAX_POLLS) {
        clearInterval(timer);
        return;
      }
      try {
        const notes = await getSwapSettlementNotes(swapTxId);
        if (!cancelled && (notes.settled.length > 0 || notes.reclaimed.length > 0)) {
          setSettlementNotes(notes);
        }
      } catch (error) {
        console.error('[HistoryDetails] Failed to read swap settlement notes:', error);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [orderId, settlementFound, transaction]);

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
  const isBridge = entry?.txType === 'bridged-send';
  const fromAddress = isBridge ? entry?.address : entry?.message === 'Sent' ? entry?.address : entry?.secondaryAddress;
  const toAddress = isBridge ? undefined : entry?.message === 'Sent' ? entry?.secondaryAddress : entry?.address;
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
      ? formatFiatDisplayAmount(entry.amount, entry.token, tokenPrices)
      : undefined;
  // The shared badge resolves its own amounts from the raw tx; for the types
  // whose hero already reads as "amount token → recipient" we override the left
  // side with the formatted history amount so both views agree.
  const historySummaryBadgeContent =
    transactionSummaryBadgeContent &&
    entry?.amount !== undefined &&
    entry.token &&
    (entry.txType === 'send' || entry.txType === 'bridged-send')
      ? {
          ...transactionSummaryBadgeContent,
          lhs: `${formatDisplayAmount(entry.amount)} ${entry.token}`
        }
      : transactionSummaryBadgeContent;
  const sectionDividerColor = entry ? getTransactionIconBackgroundColor(entry) : 'transparent';

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
                {isBridge ? <BridgeStatusPill entry={entry} /> : <StatusPill status={entry.status} />}
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

            {/* Bridge route + EVM-side claim (bridged-send only) */}
            {isBridge && (
              <>
                <div className="mt-6">
                  <SectionDivider color={sectionDividerColor} />
                </div>
                <BridgeClaimSection entry={entry} onUpdated={loadTransaction} />
              </>
            )}

            {/* Swap order tracking */}
            {entry.txType === 'swap' && orderId != null && (
              <div className="mt-6" data-testid="swap-order-card">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('orderTracking')}>
                    <DetailRow label={t('orderStatus')} isLast={!swapTracking}>
                      {swapTracking ? (
                        <span data-testid="swap-order-status" className="text-sm text-heading-gray font-medium">
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
                        <span data-testid="swap-order-fill-rounds" className="text-sm text-heading-gray font-medium">
                          {swapTracking.currentDepth}
                        </span>
                      </DetailRow>
                    )}
                    {swapTracking && requestedToken && (
                      <DetailRow label={t('amountFilled')} isLast>
                        <span data-testid="swap-order-amount-filled" className="text-sm text-heading-gray font-medium">
                          {formatAmount(filledRequested ?? 0n, requestedToken.decimals)} /{' '}
                          {formatAmount(requestedToken.amount, requestedToken.decimals)}
                          {requestedToken.symbol ? ` ${requestedToken.symbol}` : ''}
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
      </div>
    </PageLayout>
  );
};
