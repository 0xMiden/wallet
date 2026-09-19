import React, { FC, memo } from 'react';

import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { DetailRow } from 'components/ui/DetailCard';
import { Status, StatusBadge } from 'components/ui/StatusBadge';
import { springs, useMotion } from 'lib/animation';
import { SwapOrderState, SwapSettlementTransaction } from 'lib/miden/activity';
import { ITransactionStatus } from 'lib/miden/db/types';
import { getExplorerTxUrl } from 'lib/miden-chain/constants';
import { formatAmount } from 'lib/shared/format';

import HashChip from '../HashChip';
import { DetailSection } from './DetailSection';
import { IHistoryEntry } from './IHistoryEntry';
import { deliveredRequestedToken } from './swapReceipt';
import { TransactionFailureCard } from './TransactionFailureCard';
import TransactionIcon from './TransactionIcon';
import { ExternalLinkValue, StatusPill } from './TransactionStatus';
import { formatDate } from './transactionUtils';

interface SwapDetailProps {
  entry: IHistoryEntry;
  /** Undefined = unknown, which is not the same statement as zero. */
  requestedAmount?: bigint;
  requestedDecimals?: number;
  /**
   * False when the requested faucet never resolved, so `requestedDecimals` is
   * the unknown-token placeholder's guess.
   *
   * Every quantity on this screen - the order's requested size, how much of it
   * filled, and each settlement note's payout - is scaled by those same
   * decimals, so one unresolved faucet makes the entire fill history wrong
   * together. The token is still named throughout; only the numbers are
   * withheld.
   */
  requestedScaleIsKnown: boolean;
  requestedSymbol?: string;
  requestedFaucetId?: string;
  /** Undefined = unknown, which is not the same statement as zero. */
  filledAmount?: bigint;
  orderState: SwapOrderState | null;
  trackingLoading: boolean;
  /**
   * The consumes that claimed this order's notes. `getSwapSettlementNotes`
   * fills these in the same pass that collects the note ids, so a note is never
   * known without its owning consume - the receipt has no id-only fallback to
   * render and needs none.
   */
  settledTransactions: SwapSettlementTransaction[];
  reclaimedTransactions: SwapSettlementTransaction[];
  approximateUsdAmount?: string;
  fromAccount: React.ReactNode;
  showActions: boolean;
  /**
   * Route to the unclaimed notes, shown only when supplied. Presence *is* the
   * flag: a separate `showPendingNotesAction` boolean alongside a mandatory
   * callback let a caller ask for a button with nothing behind it, or hand over
   * a navigation the receipt would never call.
   */
  onOpenPendingNotes?: () => void;
}

interface SwapNoteRowProps {
  number?: number;
  kind: 'settled' | 'reclaimed' | 'pending';
  transaction?: SwapSettlementTransaction;
  requestedDecimals?: number;
  /** Only the `settled` row quotes a payout; the others pass neither. */
  requestedScaleIsKnown?: boolean;
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
  // Falsy, not just undefined: a zero stamp is an unwritten one, and formatting
  // it dates the fill to 1970.
  if (!completedAt) return undefined;

  timeFormatter ??= new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  return timeFormatter.format(new Date(completedAt * 1000));
};

const SwapNoteRow = memo(function SwapNoteRow({
  number,
  kind,
  transaction,
  requestedDecimals,
  requestedScaleIsKnown,
  requestedSymbol,
  requestedFaucetId
}: SwapNoteRowProps) {
  const { t } = useTranslation();
  const displayNoteIds = transaction?.noteIds ?? [];
  const consumedAt = settlementTime(transaction?.completedAt);
  // A consume's `amount` covers only the assets sharing its first input note's
  // faucet, and an expiry settlement bundles the requested-token paybacks with
  // the offered-token tip. Labelling that sum with the requested token's symbol
  // and decimals would misreport the offered remainder as funds received, so
  // show it only once the consume's own faucet confirms which side it is. An
  // unrecorded faucet is not a mismatch, but it is not a confirmation either.
  const deliveredRequested = transaction ? deliveredRequestedToken(transaction, requestedFaucetId) : false;
  const receivedAmount =
    transaction?.amount === undefined || deliveredRequested !== true || !requestedScaleIsKnown
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
              <p className="font-heading text-lg font-semibold text-positive-tint-ink">
                {t('swapReceivedAmount', {
                  amount: receivedAmount,
                  symbol: requestedSymbol ? ` ${requestedSymbol}` : ''
                })}
              </p>
            )}
            {displayNoteIds.map(displayNoteId => (
              <HashChip key={displayNoteId} hash={displayNoteId} trimHash className="mt-1 max-w-full text-muted" />
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
              <HashChip key={displayNoteId} hash={displayNoteId} trimHash className="max-w-full text-muted" />
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
          <StatusBadge status="pending" className="shrink-0" />
        </div>
      );
  }
});

/**
 * Transaction hash, linked to the explorer for the network this build actually
 * targets. `getExplorerTxUrl` returns undefined where no explorer exists
 * (localnet, mainnet), so those builds show the hash without a dead link.
 */
/**
 * `onChain` says whether this id is a chain transaction id at all. A consume
 * that the reaper marked Completed never received one, and falling back to the
 * local row's UUID published a Dexie id under "Consume tx ID" with a live
 * explorer link behind it - an on-chain identity the receipt does not have, and
 * a dead link. Degrade to a plain hash, the way an unknown network already does.
 */
const ExplorerTxValue: FC<{ txId: string; onChain?: boolean }> = ({ txId, onChain = true }) => {
  const explorerUrl = onChain ? getExplorerTxUrl(txId) : undefined;
  const hash = <HashChip hash={txId} trimHash />;

  return explorerUrl ? <ExternalLinkValue displayValue={hash} href={explorerUrl} /> : hash;
};

// `isPartialFill` qualifies every state: an order can be open with some of the
// request already matched, and a terminal one can have delivered part of the
// request and returned the rest. Announcing either as a flat "Filled" overstates
// what the user got.
const orderStatusOf = (state: SwapOrderState | null, trackingLoading: boolean, isPartialFill: boolean): Status => {
  switch (state) {
    case 'filled':
      return isPartialFill ? 'partiallyFilled' : 'filled';
    case 'reclaimed':
      return isPartialFill ? 'partiallyFilledReclaimed' : 'orderReclaimed';
    case 'active':
      return isPartialFill ? 'partiallyFilled' : 'open';
    case null:
      return trackingLoading ? 'loading' : 'unavailable';
  }
};

export const SwapDetail: FC<SwapDetailProps> = ({
  entry,
  requestedAmount,
  requestedDecimals,
  requestedScaleIsKnown,
  requestedSymbol,
  requestedFaucetId,
  filledAmount,
  orderState,
  trackingLoading,
  settledTransactions,
  reclaimedTransactions,
  approximateUsdAmount,
  fromAccount,
  showActions,
  onOpenPendingNotes
}) => {
  const { t } = useTranslation();
  const progressTransition = useMotion(springs.standard);
  // An unknown fill (no lineage and no settlement consume in the requested
  // token) is not a zero fill, and neither is an unknown requested total.
  // Printing "0 of 1000" - or drawing an empty bar and "0%" beside a "-" -
  // asserts that nothing arrived, which is a different and possibly false
  // statement about a restored wallet whose order may long since have settled.
  // Unknown progress is therefore rendered with no bar, no percentage and no
  // `aria-valuenow`, which is what the ARIA indeterminate state is for.
  const percentage =
    filledAmount !== undefined && requestedAmount !== undefined
      ? progressPercentage(filledAmount, requestedAmount)
      : undefined;
  const progressKnown = percentage !== undefined;
  // Derived here rather than passed in: it is a statement about these two props,
  // and as a third prop a caller could contradict them - asserting a partial
  // fill on a receipt whose progress line reads "- of 1000".
  const isPartialFill =
    filledAmount !== undefined && requestedAmount !== undefined && filledAmount > 0n && filledAmount < requestedAmount;
  const formattedOffered = entry.amount === undefined ? '-' : entry.amount.toString();
  const formattedRequested =
    requestedAmount === undefined || !requestedScaleIsKnown ? '-' : formatAmount(requestedAmount, requestedDecimals);
  const formattedFilled =
    filledAmount === undefined || !requestedScaleIsKnown ? '-' : formatAmount(filledAmount, requestedDecimals);
  const requestedSuffix = requestedSymbol ? ` ${requestedSymbol}` : '';
  const showPendingRow = orderState === 'active' || (orderState === null && trackingLoading);
  const consumeTransactions = [...settledTransactions, ...reclaimedTransactions];
  const hasSettlementRows = settledTransactions.length > 0 || reclaimedTransactions.length > 0;

  return (
    <div data-testid="swap-order-card" className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto pb-4">
        <section className="flex flex-col items-center pt-4">
          <div className="[&>div]:rounded-full">
            <TransactionIcon entry={entry} size="lg" />
          </div>

          <div
            data-testid="swap-order-hero"
            className="mt-2 flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-fill px-4 font-heading text-2xl font-extrabold text-text-primary-token"
          >
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
            {percentage !== undefined && (
              <motion.div
                data-testid="swap-amount-progress-fill"
                className="h-full origin-left rounded-full bg-tx-swap"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: percentage / 100 }}
                transition={progressTransition}
              />
            )}
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
            {percentage !== undefined && (
              <span className="shrink-0 text-sm font-semibold text-text-secondary-token">
                {t('swapProgressPercent', { percentage })}
              </span>
            )}
          </div>

          <StatusBadge
            status={orderStatusOf(orderState, trackingLoading, isPartialFill)}
            live
            className="mt-1"
            data-testid="swap-order-status"
          />
        </section>

        <section className="mt-6" aria-labelledby="swap-notes-label">
          <div
            id="swap-notes-label"
            className="inline-flex rounded-full bg-fill px-2.5 py-1 font-heading text-sm font-bold leading-4 text-text-secondary-token"
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
                    requestedScaleIsKnown={requestedScaleIsKnown}
                    requestedSymbol={requestedSymbol}
                    requestedFaucetId={requestedFaucetId}
                  />
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
            {showPendingRow && <SwapNoteRow kind="pending" />}
            {/* Only claimable while the fill is actually known. With no lineage
                and no settlement rows - a restored wallet, or consumes that
                predate settlement tagging - "nothing has been bundled yet" is
                an assertion the receipt cannot support, and is plainly false
                for an order that settled before the wallet was restored. The
                status line above already reads "Not available"; adding a
                confident denial underneath it is worse than saying nothing. */}
            {!showPendingRow && !hasSettlementRows && progressKnown && (
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
          <DetailSection title={t('transferDetails')}>
            <DetailRow label={t('date')}>{formatDate(entry.timestamp)}</DetailRow>
            {entry.externalTxId && (
              <DetailRow label={t('txIdLabel')}>
                <ExplorerTxValue txId={entry.externalTxId} />
              </DetailRow>
            )}
            {/* The generic detail card renders this for every other type; swap took a
                specialised branch and so was the one history view that dropped it.
                `entry.fee` is already resolved by the caller. */}
            {entry.fee && <DetailRow label={t('networkFee')}>{entry.fee}</DetailRow>}
            <DetailRow label={t('from')}>{fromAccount}</DetailRow>
            {consumeTransactions.map((transaction, index) => {
              const label =
                consumeTransactions.length === 1 ? t('consumeTxId') : t('consumeTxIdNumber', { number: index + 1 });

              return (
                <DetailRow key={transaction.id} label={label}>
                  <ExplorerTxValue
                    txId={transaction.transactionId ?? transaction.id}
                    onChain={transaction.transactionId !== undefined}
                  />
                </DetailRow>
              );
            })}
          </DetailSection>
        </section>
      </div>

      {/* The receipt is left via the page's own back button, not a dismiss
          control here - there is no other action once an order has reached
          the DEX, so the only thing this bar ever offers is the claim route. */}
      {showActions && onOpenPendingNotes && (
        <div className="shrink-0 space-y-3 pb-4 pt-3">
          <Button
            variant={ButtonVariant.Primary}
            title={t('swapOpenPendingNotes')}
            onClick={onOpenPendingNotes}
            className="max-w-none"
          />
        </div>
      )}
    </div>
  );
};
