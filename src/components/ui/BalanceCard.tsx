import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';

import CopyButton from 'app/atoms/CopyButton';
import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { useCardColor } from 'lib/settings/card-color';
import { CardColor } from 'lib/settings/constants';

export type BalanceDeltaDirection = 'positive' | 'negative' | 'neutral';

/* Card background per picked color — the card-* tokens resolve light/dark
 * variants via CSS vars, so no dark: classes needed. Shared with the
 * AccountsDrawer swatches. */
export const CARD_COLOR_BG: Record<CardColor, string> = {
  slate: 'bg-card-slate',
  orange: 'bg-card-orange',
  blue: 'bg-card-blue',
  green: 'bg-card-green',
  purple: 'bg-card-purple'
};

/* Two-tone card: the top section is the primary tone — solid in light mode,
 * 50% opacity in dark mode; the bottom strip is the solid second tone. */
const CARD_COLOR_TOP: Record<CardColor, string> = {
  slate: 'bg-card-slate dark:bg-card-slate/50',
  orange: 'bg-card-orange dark:bg-card-orange/50',
  blue: 'bg-card-blue dark:bg-card-blue/50',
  green: 'bg-card-green dark:bg-card-green/50',
  purple: 'bg-card-purple dark:bg-card-purple/50'
};

const CARD_COLOR_BOTTOM: Record<CardColor, string> = {
  slate: 'bg-card-slate-deep',
  orange: 'bg-card-orange-deep',
  blue: 'bg-card-blue-deep',
  green: 'bg-card-green-deep',
  purple: 'bg-card-purple-deep'
};

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
  className
}) => {
  const isLoading = state === 'loading';
  const isHidden = state === 'hidden';
  const isZero = state === 'zero';
  const cardColor = useCardColor();

  const pillBg = delta?.direction === 'negative' ? 'bg-status-negative' : 'bg-[#A8BBA3]';

  const handleMoreClick = () => {
    if (!onMore) return;
    hapticLight();
    onMore();
  };

  return (
    <div className={classNames('relative w-full overflow-hidden text-surface-balance-fg rounded-lg-token', className)}>
      <div className={classNames('px-3.5 pt-4 pb-3.5', CARD_COLOR_TOP[cardColor])}>
        <div className="text-sm font-medium text-surface-balance-fg-muted leading-none">Total Balance</div>

        <div className="mt-2.5 flex items-end gap-1 leading-none">
          {isLoading ? (
            <div className={classNames(SKELETON_BLOCK, 'h-12 w-48')} />
          ) : (
            <div className="flex items-center gap-0.5">
              <span className="font-heading text-[56px] font-extrabold leading-none ">
                {isHidden ? '••••••' : isZero ? '$0.00' : amount}
              </span>
              <span className="font-heading text-base font-semibold text-surface-balance-fg-muted">{currency}</span>
            </div>
          )}
        </div>

        {delta && !isLoading && !isHidden && (
          <div className="mt-3">
            <span
              className={classNames(
                'inline-flex items-center rounded-full px-3 py-1',
                'font-heading text-sm font-semibold leading-none text-surface-balance-fg',
                pillBg
              )}
            >
              {delta.absolute} ({delta.percentage})
            </span>
          </div>
        )}
      </div>

      <div
        className={classNames(
          'flex items-center justify-between gap-2 py-3 border-t border-dashed px-3.5 border-t-[#FFFFFF4D]',
          CARD_COLOR_BOTTOM[cardColor]
        )}
      >
        <CopyButton
          text={accountId ?? accountNumber}
          className={classNames(
            'text-xs font-semibold leading-none tracking-tight truncate min-w-0 text-left',
            'text-surface-balance-fg hover:bg-transparent active:opacity-80 transition-opacity'
          )}
        >
          Account #: {accountNumber}
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
    </div>
  );
};

export default BalanceCard;
