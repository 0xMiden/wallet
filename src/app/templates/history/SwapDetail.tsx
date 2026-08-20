import React, { FC, memo } from 'react';

import clsx from 'clsx';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { springs, useMotion } from 'lib/animation';
import { SwapOrderState, SwapSettlementTransaction } from 'lib/miden/activity';
import { compareAccountIds } from 'lib/miden/activity/utils';
import { ITransactionStatus } from 'lib/miden/db/types';
import { getExplorerTxUrl } from 'lib/miden-chain/constants';
import { formatAmount } from 'lib/shared/format';

import HashChip from '../HashChip';
import { DetailCard, DetailRow, ExternalLinkValue, StatusPill } from './DetailCard';
import { IHistoryEntry } from './IHistoryEntry';
import { TransactionFailureCard } from './TransactionFailureCard';
import TransactionIcon from './TransactionIcon';
import { formatDate } from './transactionUtils';

interface SwapDetailProps {
  entry: IHistoryEntry;
  requestedAmount: bigint;
  requestedDecimals?: number;
  requestedSymbol?: string;
  requestedFaucetId?: string;
  /** Undefined = unknown, which is not the same statement as zero. */
  filledAmount?: bigint;
  isPartialFill?: boolean;
  orderState: SwapOrderState | null;
  trackingLoading: boolean;
  settledNoteIds: string[];
  reclaimedNoteIds: string[];
  settledTransactions: SwapSettlementTransaction[];
  reclaimedTransactions: SwapSettlementTransaction[];
  approximateUsdAmount?: string;
  fromAccount: React.ReactNode;
  showActions: boolean;
  showPendingNotesAction: boolean;
  onOpenPendingNotes: () => void;
  /** Leaves the receipt. Nothing about the order is cancelled. */
  onDismiss: () => void;
}

interface SwapNoteRowProps {
  noteId?: string;
  number?: number;
  kind: 'settled' | 'reclaimed' | 'pending';
  transaction?: SwapSettlementTransaction;
  requestedDecimals?: number;
  requestedSymbol?: string;
  requestedFaucetId?: string;
}

const progressPercentage = (filledAmount: bigint, requestedAmount: bigint): number => {
  if (requestedAmount <= 0n || filledAmount <= 0n) return 0;
  if (filledAmount >= requestedAmount) return 100;

  // Truncating division would report any fill below a tenth of a percent as a
  // flat 0 next to a non-zero filled amount, so keep the bar visibly non-empty.
  return Number((filledAmount * 1000n) / requestedAmount) / 10 || 0.1;
};

// Constructing an Intl formatter is the expensive part; a receipt with many
// fills was building one per row per render.
let timeFormatter: Intl.DateTimeFormat | undefined;

const settlementTime = (completedAt: number | undefined): string | undefined => {
  if (completedAt === undefined) return undefined;

  timeFormatter ??= new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  return timeFormatter.format(new Date(completedAt * 1000));
};

const SwapNoteRow = memo(function SwapNoteRow({
  noteId,
  number,
  kind,
  transaction,
  requestedDecimals,
  requestedSymbol,
  requestedFaucetId
}: SwapNoteRowProps) {
  const { t } = useTranslation();
  const displayNoteIds = transaction?.noteIds ?? (noteId ? [noteId] : []);
  const consumedAt = settlementTime(transaction?.completedAt);
  // A consume's `amount` covers only the assets sharing its first input note's
  // faucet, and an expiry settlement bundles the requested-token paybacks with
  // the offered-token tip. Labelling that sum with the requested token's symbol
  // and decimals would misreport the offered remainder as funds received, so
  // show it only once the consume's own faucet confirms which side it is.
  const isRequestedToken =
    transaction?.faucetId !== undefined &&
    requestedFaucetId !== undefined &&
    compareAccountIds(transaction.faucetId, requestedFaucetId);
  const receivedAmount =
    transaction?.amount === undefined || !isRequestedToken
      ? undefined
      : formatAmount(transaction.amount, requestedDecimals);

  switch (kind) {
    case 'settled':
      return (
        <div className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-rule-default py-4 last:border-b-0">
          <div className="min-w-0">
            <p className="font-heading text-base font-semibold text-text-primary-token">
              {t('swapFillNote', { number })}
            </p>
            {consumedAt && (
              <p className="mt-1 text-sm font-semibold text-text-tertiary-token">
                {t('swapConsumedAt', { time: consumedAt })}
              </p>
            )}
          </div>
          <div className="flex min-w-0 flex-col items-end text-right">
            {receivedAmount && (
              <p className="font-heading text-lg font-semibold text-status-positive">
                {t('swapReceivedAmount', {
                  amount: receivedAmount,
                  symbol: requestedSymbol ? ` ${requestedSymbol}` : ''
                })}
              </p>
            )}
            {displayNoteIds.map(displayNoteId => (
              <HashChip
                key={displayNoteId}
                hash={displayNoteId}
                trimHash
                fill="currentColor"
                copyIcon={false}
                className="mt-1 max-w-full font-heading text-base font-semibold text-text-secondary-token"
              />
            ))}
          </div>
        </div>
      );
    case 'reclaimed':
      return (
        <div className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-rule-default py-4 last:border-b-0">
          <div className="min-w-0">
            <p className="font-heading text-base font-semibold text-text-primary-token">{t('reclaimed')}</p>
            {consumedAt && (
              <p className="mt-1 text-sm font-semibold text-text-tertiary-token">
                {t('swapConsumedAt', { time: consumedAt })}
              </p>
            )}
          </div>
          <div className="min-w-0 text-right">
            {displayNoteIds.map(displayNoteId => (
              <HashChip
                key={displayNoteId}
                hash={displayNoteId}
                trimHash
                fill="currentColor"
                copyIcon={false}
                className="max-w-full font-heading text-base font-semibold text-text-secondary-token"
              />
            ))}
          </div>
        </div>
      );
    case 'pending':
      return (
        <div className="flex min-h-20 items-center justify-between gap-4 py-4" role="status">
          <div className="min-w-0">
            <p className="font-heading text-base font-semibold text-text-secondary-token">{t('swapOpenFill')}</p>
            <p className="text-sm font-medium text-text-tertiary-token">{t('swapMatchingDex')}</p>
          </div>
          <span className="shrink-0 text-sm font-semibold text-status-pending">{t('pending')}</span>
        </div>
      );
  }
});

/**
 * Transaction hash, linked to the explorer for the network this build actually
 * targets. `getExplorerTxUrl` returns undefined where no explorer exists
 * (localnet, mainnet), so those builds show the hash without a dead link.
 */
const ExplorerTxValue: FC<{ txId: string }> = ({ txId }) => {
  const explorerUrl = getExplorerTxUrl(txId);
  const hash = <HashChip hash={txId} trimHash fill="currentColor" copyIcon={false} />;

  return explorerUrl ? <ExternalLinkValue displayValue={hash} href={explorerUrl} /> : hash;
};

// `isPartialFill` qualifies every state: an order can be open with some of the
// request already matched, and a terminal one can have delivered part of the
// request and returned the rest. Announcing either as a flat "Filled" overstates
// what the user got.
const orderStatusLabel = (state: SwapOrderState | null, trackingLoading: boolean, isPartialFill: boolean): string => {
  switch (state) {
    case 'filled':
      return isPartialFill ? 'orderStatusPartiallyFilled' : 'orderStatusFilled';
    case 'reclaimed':
      return isPartialFill ? 'orderStatusPartiallyFilledReclaimed' : 'orderStatusReclaimed';
    case 'active':
      return isPartialFill ? 'orderStatusPartiallyFilled' : 'orderStatusActive';
    case null:
      return trackingLoading ? 'loading' : 'trackingUnavailable';
  }
};

const orderStatusTone = (state: SwapOrderState | null, isPartialFill: boolean): string => {
  switch (state) {
    case 'filled':
      return isPartialFill ? 'text-status-pending' : 'text-status-positive';
    case 'reclaimed':
      return 'text-text-secondary-token';
    case 'active':
      return 'text-status-pending';
    case null:
      return 'text-text-tertiary-token';
  }
};

export const SwapDetail: FC<SwapDetailProps> = ({
  entry,
  requestedAmount,
  requestedDecimals,
  requestedSymbol,
  requestedFaucetId,
  filledAmount,
  isPartialFill = false,
  orderState,
  trackingLoading,
  settledNoteIds,
  reclaimedNoteIds,
  settledTransactions,
  reclaimedTransactions,
  approximateUsdAmount,
  fromAccount,
  showActions,
  showPendingNotesAction,
  onOpenPendingNotes,
  onDismiss
}) => {
  const { t } = useTranslation();
  const progressTransition = useMotion(springs.standard);
  const percentage = filledAmount === undefined ? 0 : progressPercentage(filledAmount, requestedAmount);
  const formattedOffered = entry.amount === undefined ? '—' : entry.amount.toString();
  const formattedRequested = formatAmount(requestedAmount, requestedDecimals);
  // An unknown fill (no lineage and no settlement consume in the requested
  // token) is not a zero fill. Printing "0 of 1000" would assert that nothing
  // arrived, which is a different and possibly false statement.
  const formattedFilled = filledAmount === undefined ? '—' : formatAmount(filledAmount, requestedDecimals);
  const requestedSuffix = requestedSymbol ? ` ${requestedSymbol}` : '';
  const showPendingRow = orderState === 'active' || (orderState === null && trackingLoading);
  const consumeTransactions = [...settledTransactions, ...reclaimedTransactions];
  const hasSettlementRows =
    settledTransactions.length > 0 ||
    reclaimedTransactions.length > 0 ||
    settledNoteIds.length > 0 ||
    reclaimedNoteIds.length > 0;

  return (
    <div data-testid="swap-order-card" className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto pb-4">
        <section className="flex flex-col items-center pt-4">
          <div className="[&>div]:rounded-full">
            <TransactionIcon entry={entry} size="lg" />
          </div>

          <div className="mt-2 flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-surface-interactive px-4 font-heading text-2xl font-extrabold text-text-primary-token">
            <span className="truncate">{formattedOffered}</span>
            {entry.token && <span className="text-text-secondary-token">{entry.token}</span>}
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-tx-swap text-text-on-accent">
              <Icon name={IconName.ArrowRight} size="xs" fill="currentColor" />
            </span>
            <span className="truncate">{formattedRequested}</span>
            {requestedSymbol && <span className="text-text-secondary-token">{requestedSymbol}</span>}
          </div>

          {approximateUsdAmount && (
            <p className="mt-1 text-sm font-medium text-text-secondary-token">{approximateUsdAmount}</p>
          )}

          <div className="mt-2">
            <StatusPill
              status={entry.status}
              isCancelled={entry.isCancelled}
              swapSettlement={entry.swapSettlement}
              testId="history-status-pill"
            />
          </div>
        </section>

        <section className="mt-5" aria-labelledby="swap-amount-progress-label">
          <div
            className="h-3.5 overflow-hidden rounded-full bg-surface-inactive"
            role="progressbar"
            aria-labelledby="swap-amount-progress-label"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentage}
          >
            <motion.div
              data-testid="swap-amount-progress-fill"
              className="h-full origin-left rounded-full bg-tx-swap"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: percentage / 100 }}
              transition={progressTransition}
            />
          </div>

          <div className="mt-2 flex items-start justify-between gap-4 font-heading">
            <span
              id="swap-amount-progress-label"
              data-testid="swap-order-amount-filled"
              className="text-sm font-semibold text-text-primary-token"
            >
              {t('swapAmountProgress', {
                filled: formattedFilled,
                total: formattedRequested,
                symbol: requestedSuffix
              })}
            </span>
            <span className="shrink-0 text-sm font-semibold text-text-secondary-token">
              {t('swapProgressPercent', { percentage })}
            </span>
          </div>

          <p
            data-testid="swap-order-status"
            className={clsx('mt-1 text-xs font-semibold', orderStatusTone(orderState, isPartialFill))}
            role="status"
          >
            {t(orderStatusLabel(orderState, trackingLoading, isPartialFill))}
          </p>
        </section>

        <section className="mt-6" aria-labelledby="swap-notes-label">
          <div
            id="swap-notes-label"
            className="inline-flex rounded-full bg-surface-interactive px-2.5 py-1 font-heading text-sm font-bold leading-4 text-text-secondary-token"
          >
            {t('swapNotesBundled')}
          </div>

          <div className="mt-2 border-y border-rule-default">
            {settledTransactions.length > 0 && (
              <div data-testid="swap-settled-notes">
                {settledTransactions.map((transaction, index) => (
                  <SwapNoteRow
                    key={transaction.id}
                    number={index + 1}
                    kind="settled"
                    transaction={transaction}
                    requestedDecimals={requestedDecimals}
                    requestedSymbol={requestedSymbol}
                    requestedFaucetId={requestedFaucetId}
                  />
                ))}
              </div>
            )}
            {settledTransactions.length === 0 && settledNoteIds.length > 0 && (
              <div data-testid="swap-settled-notes">
                {settledNoteIds.map((noteId, index) => (
                  <SwapNoteRow key={noteId} noteId={noteId} number={index + 1} kind="settled" />
                ))}
              </div>
            )}
            {reclaimedTransactions.length > 0 && (
              <div data-testid="swap-reclaimed-notes">
                {reclaimedTransactions.map(transaction => (
                  <SwapNoteRow key={transaction.id} kind="reclaimed" transaction={transaction} />
                ))}
              </div>
            )}
            {reclaimedTransactions.length === 0 && reclaimedNoteIds.length > 0 && (
              <div data-testid="swap-reclaimed-notes">
                {reclaimedNoteIds.map(noteId => (
                  <SwapNoteRow key={noteId} noteId={noteId} kind="reclaimed" />
                ))}
              </div>
            )}
            {showPendingRow && <SwapNoteRow kind="pending" />}
            {!showPendingRow && !hasSettlementRows && (
              <p className="py-6 text-center text-sm font-medium text-text-tertiary-token">{t('swapNoBundledNotes')}</p>
            )}
          </div>
        </section>

        {entry.status === ITransactionStatus.Failed && entry.errorMessage && (
          <section className="mt-6">
            <div className="mb-5 h-1 w-full rounded-full bg-tx-swap" />
            <TransactionFailureCard
              errorMessage={entry.errorMessage}
              rawErrorMessage={entry.rawErrorMessage}
              isCancelled={entry.isCancelled}
            />
          </section>
        )}

        <section className="mt-6 pb-2">
          <div className="mb-5 h-1 w-full rounded-full bg-tx-swap" />
          <DetailCard title={t('transferDetails')}>
            <DetailRow label={t('date')}>
              <span className="text-sm font-medium text-text-primary-token">{formatDate(entry.timestamp)}</span>
            </DetailRow>
            {entry.externalTxId && (
              <DetailRow label={t('txIdLabel')}>
                <ExplorerTxValue txId={entry.externalTxId} />
              </DetailRow>
            )}
            <DetailRow label={t('from')} isLast={consumeTransactions.length === 0}>
              {fromAccount}
            </DetailRow>
            {consumeTransactions.map((transaction, index) => {
              const label =
                consumeTransactions.length === 1 ? t('consumeTxId') : t('consumeTxIdNumber', { number: index + 1 });

              return (
                <DetailRow key={transaction.id} label={label} isLast={index === consumeTransactions.length - 1}>
                  <ExplorerTxValue txId={transaction.transactionId ?? transaction.id} />
                </DetailRow>
              );
            })}
          </DetailCard>
        </section>
      </div>

      {showActions && (
        <div className="shrink-0 space-y-3 pb-4 pt-3">
          {showPendingNotesAction && (
            <Button
              variant={ButtonVariant.Primary}
              title={t('swapOpenPendingNotes')}
              onClick={onOpenPendingNotes}
              className="max-w-none"
            />
          )}
          {/* Always present. It dismisses the receipt — an order that already
              reached the DEX has no cancel path, so it must not borrow the
              destructive Cancel label, and there is no order state in which
              "leave this screen" stops being available. Deriving it from the
              order state instead left a filled receipt with no button at all,
              and promoted this one into the primary slot the instant a fill
              landed, under a finger already reaching for the other button. */}
          <Button variant={ButtonVariant.Secondary} title={t('close')} onClick={onDismiss} className="max-w-none" />
        </div>
      )}
    </div>
  );
};
