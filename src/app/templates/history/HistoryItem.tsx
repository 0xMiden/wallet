import React, { FC, memo, useCallback } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import AddressShortView from 'app/atoms/AddressShortView';
import { useAppEnv } from 'app/env';
import { ExploreSelectors } from 'app/pages/Explore.selectors';
import { Button, ButtonVariant } from 'components/Button';
import { StatusBadge } from 'components/ui/StatusBadge';
import { isMobile } from 'lib/platform';
import { Link } from 'lib/woozie';

import { IHistoryEntry } from './IHistoryEntry';
import TransactionIcon from './TransactionIcon';
import {
  bridgeInRowDisplay,
  bridgeRowDisplay,
  earnDepositSettlementOf,
  isBridgeInEntry,
  isEarnWithdrawEntry,
  isFaucetRequest
} from './transactionUtils';

type HistoryItemProps = {
  entry: IHistoryEntry;
  fullHistory?: boolean;
  className?: string;
  lastEntry?: boolean;
};

const HistoryContent: FC<HistoryItemProps> = ({ fullHistory, entry, lastEntry }) => {
  const { t } = useTranslation();
  const { compact } = useAppEnv();
  const isReceive = entry.transactionIcon === 'RECEIVE' || entry.message === 'Consuming';
  const isFaucet = isFaucetRequest(entry);

  const handleCancelClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
      e.preventDefault();
      e.stopPropagation();
      entry.cancel?.();
    },
    [entry]
  );

  if (entry.txType === 'bridged-send' || isBridgeInEntry(entry)) {
    return <BridgeRowContent entry={entry} fullHistory={fullHistory} lastEntry={lastEntry} />;
  }

  if (isEarnWithdrawEntry(entry)) {
    return <EarnWithdrawRowContent entry={entry} fullHistory={fullHistory} lastEntry={lastEntry} />;
  }

  // A Smart Deposit row is Completed once the Miden collateral note lands, but
  // the position only exists once the Sepolia lending leg settles — surface that
  // leg while it is still pending or has failed (settled reads as the plain row).
  // Never on a cancelled or Miden-failed row: that failure is the real story.
  const settlement =
    entry.txType === 'earn-deposit' && !entry.isCancelled && entry.transactionIcon !== 'FAILED'
      ? earnDepositSettlementOf(entry)
      : 'confirmed';
  const depositSettlement = settlement === 'confirmed' ? undefined : settlement;

  const title = isFaucet ? t('faucetRequest') : entry.message;
  return (
    <div
      className={classNames(
        'w-full flex items-center gap-3 py-4 cursor-pointer transition-colors duration-200 hover:bg-fill-pressed',
        !lastEntry && 'border-b',
        fullHistory && !lastEntry ? 'border-b-border-card border-b-[0.27px]' : ''
      )}
    >
      {/* Icon */}
      <div
        className="flex items-center justify-center shrink-0 rounded-[10px]  bg-transparent text-primary-500"
        style={{ width: 40, height: 40 }}
      >
        <TransactionIcon entry={entry} size="sm" />
      </div>

      {/* Content */}
      <div className="flex flex-col grow min-w-0">
        <span className="text-ink font-medium truncate text-sm leading-none">{title}</span>

        {entry.secondaryAddress && (
          <span className="text-xs text-text-muted truncate flex gap-0.5">
            <p className="font-medium">{`${isReceive ? t('from') : t('to')}: `}</p>
            <AddressShortView address={entry.secondaryAddress} trim={isMobile() || compact} />
          </span>
        )}
      </div>

      {/* Amount */}
      {entry.amount !== undefined && (
        <div className="flex flex-col items-end shrink-0">
          <span
            className={classNames(
              'font-heading text-sm font-medium leading-none',
              isReceive ? 'text-positive-tint-ink' : 'text-negative-tint-ink'
            )}
          >
            {/* eslint-disable-next-line i18next/no-literal-string -- numeric amount sign prefix, not translatable copy */}
            {isReceive ? '+' : '-'}
            {entry.amount.toString()}
          </span>
          {entry.token && (
            <span className="font-heading text-sm text-ink opacity-64 font-medium leading-none">{entry.token}</span>
          )}
        </div>
      )}

      {/* Sepolia lending-leg status (Smart Deposit, while unsettled) */}
      {depositSettlement && (
        <StatusBadge status={depositSettlement} className="shrink-0" data-testid="earn-deposit-status" />
      )}

      {/* Cancel button for pending */}
      {entry.cancel && (
        <Button
          variant={ButtonVariant.Ghost}
          className="h-auto w-auto max-w-none p-1 border-0 rounded-md shrink-0"
          onClick={handleCancelClick}
          data-testid={ExploreSelectors.CancelTransaction}
        >
          <span className="text-xs text-red-500">{t('cancel')}</span>
        </Button>
      )}
    </div>
  );
};

/**
 * Bridge row: "Bridge IN → OUT" with a "Via <provider> → <network>" subtitle,
 * the destination amount, and a Pending/Confirmed `StatusBadge` — matching the
 * swap-style design. Covers `bridged-send` rows and bridge-in consumes (the
 * direction-flipped EVM→Miden deposit). Distinct from the generic send/receive
 * row, which shows a signed Miden amount + from/to address.
 */
const BridgeRowContent: FC<Pick<HistoryItemProps, 'entry' | 'fullHistory' | 'lastEntry'>> = ({
  entry,
  fullHistory,
  lastEntry
}) => {
  const { t } = useTranslation();
  const { inSymbol, outSymbol, outAmount, providerLabel, network, status } =
    entry.txType === 'bridged-send' ? bridgeRowDisplay(entry) : bridgeInRowDisplay(entry);

  return (
    <div
      className={classNames(
        'w-full flex items-center gap-3 py-4 cursor-pointer transition-colors duration-200 hover:bg-fill-pressed',
        !lastEntry && 'border-b',
        fullHistory && !lastEntry ? 'border-b-[#00000033] border-b-[0.27px]' : ''
      )}
    >
      <div
        className="flex items-center justify-center shrink-0 rounded-[10px] bg-transparent"
        style={{ width: 40, height: 40 }}
      >
        <TransactionIcon entry={entry} size="sm" />
      </div>

      <div className="flex flex-col grow min-w-0">
        <span className="text-ink font-medium truncate text-sm leading-none">
          {t('bridgeRowTitle', { from: inSymbol, to: outSymbol })}
        </span>
        <span className="text-xs text-grey-500 truncate mt-1">
          {t('bridgeRowVia', { provider: providerLabel, network })}
        </span>
      </div>

      <div className="flex flex-col items-end shrink-0 gap-1">
        {outAmount !== undefined && (
          <span className="text-sm font-medium leading-none text-ink">
            {outAmount} {outSymbol}
          </span>
        )}
        <StatusBadge status={status} />
      </div>
    </div>
  );
};

/**
 * Smart Withdraw row: "Withdraw from Earn" / "Via Epoch → Miden" with a positive
 * incoming amount and a phase-driven `StatusBadge` (Redeeming → Delivering → Received,
 * or Failed). Reuses the bridge status-dot palette.
 */
const EarnWithdrawRowContent: FC<Pick<HistoryItemProps, 'entry' | 'fullHistory' | 'lastEntry'>> = ({
  entry,
  fullHistory,
  lastEntry
}) => {
  const { t } = useTranslation();
  const phase = entry.earnWithdrawPhase ?? 'redeeming';
  const showAmount = phase !== 'failed' && entry.amount !== undefined;

  return (
    <div
      className={classNames(
        'w-full flex items-center gap-3 py-4 cursor-pointer transition-colors duration-200 hover:bg-fill-pressed',
        !lastEntry && 'border-b',
        fullHistory && !lastEntry ? 'border-b-border-card border-b-[0.27px]' : ''
      )}
    >
      <div
        className="flex items-center justify-center shrink-0 rounded-[10px] bg-transparent"
        style={{ width: 40, height: 40 }}
      >
        <TransactionIcon entry={entry} size="sm" />
      </div>

      <div className="flex flex-col grow min-w-0">
        <span className="text-ink font-medium truncate text-sm leading-none">{t('earnWithdrawRowTitle')}</span>
        <span className="text-xs text-text-muted truncate mt-1">{t('earnWithdrawRowVia')}</span>
      </div>

      <div className="flex flex-col items-end shrink-0 gap-1">
        {/* eslint-disable i18next/no-literal-string -- numeric amount sign prefix, not translatable copy */}
        {showAmount && (
          <span className="text-sm font-medium leading-none text-positive-tint-ink">
            +{entry.amount?.toString()} {entry.token}
          </span>
        )}
        {/* eslint-enable i18next/no-literal-string */}
        <StatusBadge status={phase} />
      </div>
    </div>
  );
};

const HistoryItem = memo<HistoryItemProps>(({ className, fullHistory, entry, lastEntry }) => {
  return (
    <div className={classNames('w-full text-ink', className)}>
      {entry.explorerLink ? (
        <a draggable={false} href={entry.explorerLink} target="_blank" rel="noreferrer">
          <HistoryContent fullHistory={fullHistory} entry={entry} lastEntry={lastEntry} />
        </a>
      ) : (
        <Link to={`/history-details/${entry.txId}`}>
          <HistoryContent fullHistory={fullHistory} entry={entry} lastEntry={lastEntry} />
        </Link>
      )}
    </div>
  );
});

export default HistoryItem;
