import React, { FC, memo, useCallback, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import AddressShortView from 'app/atoms/AddressShortView';
import { Button } from 'app/atoms/Button';
import HashShortView from 'app/atoms/HashShortView';
import { useAppEnv } from 'app/env';
import { ReactComponent as FaucetIcon } from 'app/icons/faucet-new.svg';
import { ReactComponent as ReceiveIcon } from 'app/icons/receive-new.svg';
import { ReactComponent as PendingIcon } from 'app/icons/rotate.svg';
import { ReactComponent as SendIcon } from 'app/icons/send-new.svg';
import { ExploreSelectors } from 'app/pages/Explore.selectors';
import { MidenTokens, TOKEN_MAPPING } from 'lib/miden-chain/constants';
import { ITransactionIcon } from 'lib/miden/db/types';
import { isMobile } from 'lib/platform';
import { Link } from 'lib/woozie';

import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';

type HistoryItemProps = {
  entry: IHistoryEntry;
  fullHistory?: boolean;
  className?: string;
  lastEntry?: boolean;
};

// Check if this is a faucet request (sender is the Miden faucet)
const isFaucetRequest = (entry: IHistoryEntry): boolean => {
  const midenFaucetId = TOKEN_MAPPING[MidenTokens.Miden]?.faucetId;
  return (
    entry.transactionIcon === 'RECEIVE' && entry.faucetId === midenFaucetId && entry.secondaryAddress === midenFaucetId
  );
};

const getTransactionIcon = (entry: IHistoryEntry) => {
  const isPending =
    entry.type === HistoryEntryType.PendingTransaction || entry.type === HistoryEntryType.ProcessingTransaction;

  if (isPending) {
    return <PendingIcon className="w-6 h-6 animate-spin" />;
  }

  if (isFaucetRequest(entry)) {
    return <FaucetIcon className="w-6 h-6" />;
  }

  switch (entry.transactionIcon) {
    case 'SEND':
      return <SendIcon className="w-6 h-6" />;
    case 'RECEIVE':
      return <ReceiveIcon className="w-6 h-6" />;
    default:
      return <ReceiveIcon className="w-6 h-6" />;
  }
};

const HistoryContent: FC<HistoryItemProps> = ({ fullHistory, entry, lastEntry }) => {
  const { t } = useTranslation();
  const { popup } = useAppEnv();
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

  // For faucet requests, extract block number from txId (last 6 digits)
  const blockNumber = useMemo(() => {
    if (isFaucet && entry.txId) {
      // Use last 6 characters of txId as block number display
      return entry.txId.slice(-6);
    }
    return null;
  }, [isFaucet, entry.txId]);

  const title = isFaucet ? t('faucetRequest') : entry.message;
  const subtitle = isFaucet && blockNumber ? `#${blockNumber}` : null;

  return (
    <div
      className={classNames(
        'w-full flex items-center gap-3 py-5 cursor-pointer transition-colors duration-200 hover:bg-grey-50',
        !lastEntry && 'border-b',
        fullHistory && !lastEntry ? 'border-b-[#00000033] border-b-[0.27px]' : ''
      )}
    >
      {/* Icon */}
      <div
        className="flex items-center justify-center flex-shrink-0 rounded-[10px]  bg-transparent text-primary-500"
        style={{ width: 40, height: 40 }}
      >
        {getTransactionIcon(entry)}
      </div>

      {/* Content */}
      <div className="flex flex-col flex-grow min-w-0">
        <span className="text-heading-gray font-medium truncate text-[15.11px]">{title}</span>
        {subtitle ? (
          <span className="text-xs text-heading-gray opacity-50">{subtitle}</span>
        ) : (
          entry.secondaryAddress && (
            <span className="text-xs text-grey-500 truncate">
              {`${isReceive ? t('from') : t('to')}: `}
              <AddressShortView address={entry.secondaryAddress} trim={isMobile() || popup} />
            </span>
          )
        )}
      </div>

      {/* Amount */}
      {entry.amount && (
        <div className="flex flex-col items-end flex-shrink-0">
          <span className={classNames('text-sm font-medium', isReceive ? 'text-[#24D845]' : 'text-[#D83C24]')}>
            {isReceive ? '+' : '-'}
            {entry.amount.replace(/^[+-]/, '')}
          </span>
          {entry.token && <span className="text-xs text-[#000000A3] font-medium">{entry.token}</span>}
        </div>
      )}

      {/* Cancel button for pending */}
      {entry.cancel && (
        <Button
          className="hover:bg-grey-100 rounded-md p-1 flex-shrink-0"
          onClick={handleCancelClick}
          testID={ExploreSelectors.CancelTransaction}
        >
          <span className="text-xs text-red-500">{t('cancel')}</span>
        </Button>
      )}
    </div>
  );
};

const HistoryItem = memo<HistoryItemProps>(({ className, fullHistory, entry, lastEntry }) => {
  console.log('Rendering HistoryItem with entry:', entry, 'and fullHistory:', fullHistory, 'and lastEntry:', lastEntry);
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
