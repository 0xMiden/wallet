import React, { FC } from 'react';

import { ReactComponent as FaucetIcon } from 'app/icons/faucet-new.svg';
import { ReactComponent as PendingIcon } from 'app/icons/rotate.svg';
import { Icon, IconName } from 'app/icons/v2';
import { ReactComponent as FailedCrossIcon } from 'app/icons/v2/failed-cross.svg';
import { ReactComponent as ReceiveIcon } from 'app/icons/v2/receive-new.svg';
import { ReactComponent as SendIcon } from 'app/icons/v2/send-new.svg';
import { ReactComponent as SwapIcon } from 'app/icons/v2/swap.svg';

import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import { bridgeStatusOf, isFaucetRequest, TRANSACTION_COLORS } from './transactionUtils';

/** Slate square behind the white swap glyph for bridge rows (matches the design). */
const BRIDGE_ICON_BG = '#777487';

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

/** Shared accent used by both the transaction glyph and detail-section dividers. */
export const getTransactionIconBackgroundColor = (entry: IHistoryEntry): string => {
  if (entry.isCancelled) return '#9CA3AF';

  if (
    (entry.txType === 'bridged-send' || entry.txType === 'bridged-receive' || entry.bridgeInProvider) &&
    bridgeStatusOf(entry) === 'failed'
  ) {
    return '#CC5D5D';
  }

  if (entry.txType === 'bridged-send' || entry.txType === 'bridged-receive' || entry.bridgeInProvider) {
    return BRIDGE_ICON_BG;
  }

  if (entry.txType === 'earn-withdraw' || entry.txType === 'earn-deposit') {
    return entry.earnWithdrawPhase === 'failed' ? '#CC5D5D' : 'var(--tx-earn)';
  }

  if (isFaucetRequest(entry)) return TRANSACTION_COLORS.faucet;

  switch (entry.transactionIcon) {
    case 'FAILED':
      return '#CC5D5D';
    case 'SEND':
      return TRANSACTION_COLORS.send;
    case 'SWAP':
      return 'var(--tx-swap)';
    case 'RECEIVE':
    default:
      return TRANSACTION_COLORS.receive;
  }
};

const TransactionIcon: FC<TransactionIconProps> = ({ entry, size = 'sm' }) => {
  const config = sizeConfig[size];
  const isPending =
    entry.type === HistoryEntryType.PendingTransaction || entry.type === HistoryEntryType.ProcessingTransaction;

  if (entry.isCancelled) {
    return (
      <div className={`${config.container} rounded-10 flex items-center justify-center bg-gray-400`}>
        <FailedCrossIcon className={config.sendIcon} />
      </div>
    );
  }

  // A terminal bridge failure takes precedence over the route glyph. This also
  // covers the detail page, where `transactionIcon` retains the original SEND
  // icon and failure is represented by the raw transaction status.
  if (entry.txType === 'bridged-send' || entry.txType === 'bridged-receive' || entry.bridgeInProvider) {
    if (bridgeStatusOf(entry) === 'failed') {
      return (
        <div className={`${config.container} rounded-10 flex items-center justify-center bg-[#CC5D5D]`}>
          <FailedCrossIcon className={config.sendIcon} />
        </div>
      );
    }

    return (
      <div
        className={`${config.container} rounded-10 flex items-center justify-center`}
        style={{ backgroundColor: BRIDGE_ICON_BG }}
      >
        <SwapIcon className={config.icon} />
      </div>
    );
  }

  // Smart Withdraw rows are born Completed but carry an in-flight phase — keep the
  // Earn glyph across states (status shown in text), and the failed cross on failure.
  if (entry.txType === 'earn-withdraw') {
    if (entry.earnWithdrawPhase === 'failed') {
      return (
        <div className={`${config.container} rounded-10 flex items-center justify-center bg-[#CC5D5D]`}>
          <FailedCrossIcon className={config.sendIcon} />
        </div>
      );
    }
    return (
      <div className={`${config.container} rounded-10 flex items-center justify-center bg-tx-earn`}>
        <Icon
          name={IconName.Earn}
          size={size === 'lg' ? 'lg' : 'sm'}
          className="[&_path]:fill-pure-white [&_path]:stroke-pure-white"
        />
      </div>
    );
  }

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
    case 'FAILED':
      return (
        <div className={`${config.container} rounded-10 flex items-center justify-center bg-[#CC5D5D]`}>
          <FailedCrossIcon className={config.sendIcon} />
        </div>
      );
    case 'SEND':
      return (
        <div
          className={`${config.container} flex items-center justify-center rounded-full`}
          style={{ backgroundColor: TRANSACTION_COLORS.send }}
        >
          <SendIcon className={`${config.sendIcon} ${whiteIconClass}`} />
        </div>
      );
    case 'SWAP':
      // Purple square + white swap arrows, matching the ActivityRow treatment.
      return (
        <div className={`${config.container} rounded-10 flex items-center justify-center bg-tx-swap`}>
          <Icon name={IconName.Convert} size={size === 'lg' ? 'lg' : 'sm'} className="[&_path]:stroke-pure-white" />
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
