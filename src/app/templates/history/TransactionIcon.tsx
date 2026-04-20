import React, { FC } from 'react';

import { ReactComponent as FaucetIcon } from 'app/icons/faucet-new.svg';
import { ReactComponent as ReceiveIcon } from 'app/icons/receive-new.svg';
import { ReactComponent as PendingIcon } from 'app/icons/rotate.svg';
import { ReactComponent as SendIcon } from 'app/icons/send-new.svg';

import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import { isFaucetRequest, TRANSACTION_COLORS } from './transactionUtils';

type TransactionIconSize = 'sm' | 'lg';

interface TransactionIconProps {
  entry: IHistoryEntry;
  size?: TransactionIconSize;
}

const sizeConfig = {
  sm: { container: 'w-8.5 h-8.5', icon: 'w-4.5 h-4.5', sendIcon: 'w-3.5 h-3.5', pending: 'w-6 h-6' },
  lg: { container: 'w-16 h-16', icon: 'w-7 h-7', sendIcon: 'w-6 h-6', pending: 'w-8 h-8' }
};

const TransactionIcon: FC<TransactionIconProps> = ({ entry, size = 'sm' }) => {
  const config = sizeConfig[size];
  const isPending =
    entry.type === HistoryEntryType.PendingTransaction || entry.type === HistoryEntryType.ProcessingTransaction;

  if (isPending) {
    return <PendingIcon className={`${config.pending} animate-spin`} />;
  }

  if (isFaucetRequest(entry)) {
    return (
      <div
        className={`${config.container} rounded-10 flex items-center justify-center`}
        style={{ backgroundColor: TRANSACTION_COLORS.faucet }}
      >
        <FaucetIcon className={config.icon} />
      </div>
    );
  }

  switch (entry.transactionIcon) {
    case 'SEND':
      return (
        <div
          className={`${config.container} flex items-center justify-center`}
          style={{ backgroundColor: TRANSACTION_COLORS.send }}
        >
          <SendIcon className={config.sendIcon} />
        </div>
      );
    case 'RECEIVE':
    default:
      return (
        <div
          className={`${config.container} flex items-center justify-center`}
          style={{ backgroundColor: TRANSACTION_COLORS.receive }}
        >
          <ReceiveIcon className={config.icon} />
        </div>
      );
  }
};

export default TransactionIcon;
