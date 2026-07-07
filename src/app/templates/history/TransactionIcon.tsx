import React, { FC } from 'react';

import { ReactComponent as FaucetIcon } from 'app/icons/faucet-new.svg';
import { ReactComponent as PendingIcon } from 'app/icons/rotate.svg';
import { ReactComponent as ReceiveIcon } from 'app/icons/v2/receive-new.svg';
import { ReactComponent as SendIcon } from 'app/icons/v2/send-new.svg';

import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import { isFaucetRequest, TRANSACTION_COLORS } from './transactionUtils';

type TransactionIconSize = 'sm' | 'lg';

interface TransactionIconProps {
  entry: IHistoryEntry;
  size?: TransactionIconSize;
}

const sizeConfig = {
  sm: { container: 'w-8.5 h-8.5', icon: 'w-4.5 h-4.5', sendIcon: 'w-3.5 h-3.5', pending: 'w-6 h-6' },
  lg: { container: 'w-18 h-18', icon: 'w-8 h-8', sendIcon: 'w-8 h-8', pending: 'w-8 h-8' }
};

const whiteIconClass = 'text-pure-white [&_path]:fill-pure-white';

const TransactionIcon: FC<TransactionIconProps> = ({ entry, size = 'sm' }) => {
  const config = sizeConfig[size];
  const isPending =
    entry.type === HistoryEntryType.PendingTransaction || entry.type === HistoryEntryType.ProcessingTransaction;

  if (isPending) {
    return <PendingIcon className={`${config.pending} animate-spin ${whiteIconClass}`} />;
  }

  if (isFaucetRequest(entry)) {
    return (
      <div
        className={`${config.container} flex items-center justify-center rounded-full`}
        style={{ backgroundColor: TRANSACTION_COLORS.faucet }}
      >
        <FaucetIcon className={`${config.icon} ${whiteIconClass}`} />
      </div>
    );
  }

  switch (entry.transactionIcon) {
    case 'SEND':
      return (
        <div
          className={`${config.container} flex items-center justify-center rounded-full`}
          style={{ backgroundColor: TRANSACTION_COLORS.send }}
        >
          <SendIcon className={`${config.sendIcon} ${whiteIconClass}`} />
        </div>
      );
    case 'RECEIVE':
    default:
      return (
        <div
          className={`${config.container} flex items-center justify-center rounded-full`}
          style={{ backgroundColor: TRANSACTION_COLORS.receive }}
        >
          <ReceiveIcon className={`${config.icon} ${whiteIconClass}`} />
        </div>
      );
  }
};

export default TransactionIcon;
