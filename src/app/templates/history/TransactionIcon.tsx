import React, { FC } from 'react';

import { ReactComponent as FaucetIcon } from 'app/icons/faucet-new.svg';
import { ReactComponent as PendingIcon } from 'app/icons/rotate.svg';
import { Icon, IconName } from 'app/icons/v2';
import { ReactComponent as FailedCrossIcon } from 'app/icons/v2/failed-cross.svg';
import { ReactComponent as ReceiveIcon } from 'app/icons/v2/receive-new.svg';
import { ReactComponent as SendIcon } from 'app/icons/v2/send-new.svg';
import { ReactComponent as SwapIcon } from 'app/icons/v2/swap.svg';

import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import { bridgeStatusOf, earnDepositSettlementOf, isFaucetRequest, TRANSACTION_COLORS } from './transactionUtils';

/** Slate square behind the white swap glyph for bridge rows (matches the design). */
const BRIDGE_ICON_BG = '#777487';

/**
 * An earn row renders as failed (red cross + red accent) when the tx hard-failed, a
 * withdraw phase failed, or a deposit's lending leg settled `failed`. Routing the
 * deposit case through `earnDepositSettlementOf` keeps the glyph/accent in lockstep
 * with the red "Failed" status chip the activity list and details page already render
 * for that same state.
 */
const isEarnRowFailed = (entry: IHistoryEntry): boolean =>
  entry.transactionIcon === 'FAILED' ||
  entry.earnWithdrawPhase === 'failed' ||
  (entry.txType === 'earn-deposit' && earnDepositSettlementOf(entry) === 'failed');

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
  if (entry.isCancelled) return '#9E9E9E';
  if (entry.transactionIcon === 'FAILED') return '#CC5D5D';

  if (!entry.recoveryDetailsPartial && (entry.txType === 'bridged-send' || entry.bridgeInProvider)) {
    return bridgeStatusOf(entry) === 'failed' ? '#CC5D5D' : BRIDGE_ICON_BG;
  }

  // Earn rows keep the Earn accent across states; any failed earn leg goes red.
  if (entry.txType === 'earn-deposit' || entry.txType === 'earn-withdraw') {
    return isEarnRowFailed(entry) ? '#CC5D5D' : 'var(--tx-earn)';
  }

  if (isFaucetRequest(entry)) return TRANSACTION_COLORS.faucet;

  switch (entry.transactionIcon) {
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

  if (
    !entry.recoveryDetailsPartial &&
    (entry.txType === 'bridged-send' || entry.txType === 'bridged-receive' || entry.bridgeInProvider)
  ) {
    if (bridgeStatusOf(entry) === 'failed') {
      return (
        <div className={`${config.container} rounded-10 flex items-center justify-center bg-status-negative`}>
          <Icon name={IconName.Close} size={size === 'lg' ? 'lg' : 'sm'} fill="currentColor" />
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

  // Earn transactions keep the Earn glyph across states even when their underlying
  // transaction icon is RECEIVE/SEND. A hard Miden-side failure, a failed withdraw
  // phase, or a failed deposit lending leg retains the failed cross, so the summary/
  // hero glyph agrees with the full Activity list, the divider accent, and the chip.
  if (entry.txType === 'earn-deposit' || entry.txType === 'earn-withdraw') {
    if (isEarnRowFailed(entry)) {
      return (
        <div className={`${config.container} rounded-10 flex items-center justify-center bg-status-negative`}>
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
