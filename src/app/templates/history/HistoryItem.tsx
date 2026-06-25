import React, { FC, memo, useCallback } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import AddressShortView from 'app/atoms/AddressShortView';
import { Button } from 'app/atoms/Button';
import { useAppEnv } from 'app/env';
import { ExploreSelectors } from 'app/pages/Explore.selectors';
import { isMobile } from 'lib/platform';
import { Link } from 'lib/woozie';

import { IHistoryEntry } from './IHistoryEntry';
import TransactionIcon from './TransactionIcon';
import {
  BRIDGE_STATUS_LABEL_KEY,
  BridgeStatus,
  bridgeInRowDisplay,
  bridgeRowDisplay,
  isBridgeInEntry,
  isFaucetRequest
} from './transactionUtils';

type HistoryItemProps = {
  entry: IHistoryEntry;
  fullHistory?: boolean;
  className?: string;
  lastEntry?: boolean;
};

// Semantic status colors, shared with the full Activity row (`ActivityRow`).
const BRIDGE_STATUS_COLOR: Record<BridgeStatus, string> = {
  pending: 'text-status-pending',
  confirmed: 'text-status-positive',
  failed: 'text-status-negative'
};
const BRIDGE_STATUS_DOT: Record<BridgeStatus, string> = {
  pending: 'bg-status-pending',
  confirmed: 'bg-status-positive',
  failed: 'bg-status-negative'
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

  const title = isFaucet ? t('faucetRequest') : entry.message;
  return (
    <div
      className={classNames(
        'w-full flex items-center gap-3 py-4 cursor-pointer transition-colors duration-200 hover:bg-gray-100',
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
        <span className="text-black font-medium truncate text-sm leading-none">{title}</span>

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
              isReceive ? 'text-receive-green' : 'text-[#DC2626]'
            )}
          >
            {isReceive ? '+' : '-'}
            {entry.amount.toString()}
          </span>
          {entry.token && (
            <span className="font-heading text-sm text-black opacity-64 font-medium leading-none">{entry.token}</span>
          )}
        </div>
      )}

      {/* Cancel button for pending */}
      {entry.cancel && (
        <Button
          className="hover:bg-gray-100 rounded-md p-1 shrink-0"
          onClick={handleCancelClick}
          testID={ExploreSelectors.CancelTransaction}
        >
          <span className="text-xs text-red-500">{t('cancel')}</span>
        </Button>
      )}
    </div>
  );
};

/**
 * Bridge row: "Bridge IN → OUT" with a "Via <provider> → <network>" subtitle,
 * the destination amount, and a Pending/Confirmed status dot — matching the
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
        'w-full flex items-center gap-3 py-4 cursor-pointer transition-colors duration-200 hover:bg-gray-100',
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
        <span className="text-black font-medium truncate text-sm leading-none">
          {t('bridgeRowTitle', { from: inSymbol, to: outSymbol })}
        </span>
        <span className="text-xs text-grey-500 truncate mt-1">
          {t('bridgeRowVia', { provider: providerLabel, network })}
        </span>
      </div>

      <div className="flex flex-col items-end shrink-0 gap-1">
        {outAmount !== undefined && (
          <span className="text-sm font-medium leading-none text-black">
            {outAmount} {outSymbol}
          </span>
        )}
        <span
          className={classNames('flex items-center gap-1 text-xs font-medium leading-none', BRIDGE_STATUS_COLOR[status])}
        >
          <span className={classNames('w-1.5 h-1.5 rounded-full', BRIDGE_STATUS_DOT[status])} />
          {t(BRIDGE_STATUS_LABEL_KEY[status])}
        </span>
      </div>
    </div>
  );
};

const HistoryItem = memo<HistoryItemProps>(({ className, fullHistory, entry, lastEntry }) => {
  return (
    <div className={classNames('w-full text-black', className)}>
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
