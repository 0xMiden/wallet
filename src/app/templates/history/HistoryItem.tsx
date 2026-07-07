import React, { FC, memo, useCallback } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import AddressShortView from 'app/atoms/AddressShortView';
import { useAppEnv } from 'app/env';
import { ExploreSelectors } from 'app/pages/Explore.selectors';
import { Button, ButtonVariant } from 'components/Button';
import { isMobile } from 'lib/platform';
import { Link } from 'lib/woozie';

import { IHistoryEntry } from './IHistoryEntry';
import TransactionIcon from './TransactionIcon';
import { isFaucetRequest } from './transactionUtils';

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
