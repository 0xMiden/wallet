import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';

import CopyButton from 'app/atoms/CopyButton';
import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

export type BalanceDeltaDirection = 'positive' | 'negative' | 'neutral';

export interface BalanceCardProps {
  /** Truncated display label, e.g. `mtst1aqg...940z`. */
  accountNumber: string;
  /** Full account id used when copying to clipboard. Falls back to accountNumber. */
  accountId?: string;
  amount: ReactNode;
  currency?: string;
  delta?: {
    absolute: string;
    percentage: string;
    direction?: BalanceDeltaDirection;
  };
  onMore?: () => void;
  state?: 'default' | 'loading' | 'zero' | 'hidden';
  showDragHandle?: boolean;
  className?: string;
}

const SKELETON_BLOCK = 'animate-pulse rounded-md bg-white/15';

export const BalanceCard: FC<BalanceCardProps> = ({
  accountNumber,
  accountId,
  amount,
  currency = 'USD',
  delta,
  onMore,
  state = 'default',
  showDragHandle = true,
  className
}) => {
  const isLoading = state === 'loading';
  const isHidden = state === 'hidden';
  const isZero = state === 'zero';

  const deltaColor =
    delta?.direction === 'negative'
      ? 'text-status-negative'
      : delta?.direction === 'neutral'
        ? 'text-surface-balance-fg-muted'
        : 'text-surface-balance-positive';

  const handleMoreClick = () => {
    if (!onMore) return;
    hapticLight();
    onMore();
  };

  return (
    <div
      className={classNames('relative w-full bg-surface-balance text-surface-balance-fg rounded-lg-token ', className)}
    >
      <div className="flex items-center justify-between gap-2 py-2.5 border-b border-dotted px-3.5">
        <CopyButton
          text={accountId ?? accountNumber}
          className={classNames(
            'text-xs font-semibold leading-none tracking-tight truncate min-w-0 text-left',
            'text-surface-balance-fg hover:bg-transparent active:opacity-80 transition-opacity'
          )}
        >
          Account 1: {accountNumber}
        </CopyButton>
        {onMore && (
          <button
            type="button"
            onClick={handleMoreClick}
            aria-label="Account options"
            className={classNames('shrink-0 flex items-center justify-center', 'w-5 h-5 rounded-full bg-[#F6F4F261] ')}
          >
            <Icon name={IconName.More} className="w-3 h-3" fill="currentColor" />
          </button>
        )}
      </div>
      <div className="px-3.5 pt-2.5 pb-4">
        <div className="text-sm font-medium text-surface-balance-fg-muted leading-none">Total Balance</div>

        <div className="mt-2 flex items-end gap-1 leading-none">
          {isLoading ? (
            <div className={classNames(SKELETON_BLOCK, 'h-12 w-48')} />
          ) : (
            <div className="flex items-center gap-0.5">
              <span className="text-[56px] font-extrabold leading-none ">
                {isHidden ? '••••••' : isZero ? '$0.00' : amount}
              </span>
              <span className="text-base font-semibold text-surface-balance-fg-muted">{currency}</span>
            </div>
          )}
        </div>

        {delta && !isLoading && !isHidden && (
          <div className={classNames('mt-1 text-base font-semibold leading-none', deltaColor)}>
            {delta.absolute} ({delta.percentage})
          </div>
        )}
      </div>

      {showDragHandle && (
        <div className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="h-2 w-17.5 rounded-full bg-surface-balance-handle" />
        </div>
      )}
    </div>
  );
};

export default BalanceCard;
