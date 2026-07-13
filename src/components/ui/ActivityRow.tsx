import React, { FC, ReactNode } from 'react';

import BigNumber from 'bignumber.js';
import classNames from 'clsx';

import { hapticLight } from 'lib/mobile/haptics';

export type ActivityAmountDirection = 'positive' | 'negative' | 'neutral';
export type ActivityStatusTone = 'confirmed' | 'pending' | 'failed';

export interface ActivityRowProps {
  /** Glyph rendered inside the colored square. Pass a white-stroked SVG; it is forced to 16x16. */
  icon: ReactNode;
  /**
   * Tailwind classes for the icon square's background. Defaults to a neutral
   * gray; callers should pass the appropriate accent (e.g. `bg-receive-green`).
   */
  iconBg?: string;
  title: string;
  subtitle?: string;
  amount?: {
    value: string;
    /** Token symbol, rendered in the neutral heading color next to the value. */
    symbol?: string;
    direction?: ActivityAmountDirection;
  };
  status?: {
    label: string;
    tone: ActivityStatusTone;
  };
  /** Right-aligned relative time (e.g. "Just now") — alternative to `status`. */
  timestamp?: string;
  onClick?: () => void;
  className?: string;
}

const AMOUNT_COLOR: Record<ActivityAmountDirection, string> = {
  positive: 'text-status-positive',
  negative: 'text-status-negative',
  neutral: 'text-text-primary-token'
};

const STATUS_DOT: Record<ActivityStatusTone, string> = {
  confirmed: 'bg-status-positive',
  pending: 'bg-status-pending',
  failed: 'bg-status-negative'
};

const STATUS_TEXT: Record<ActivityStatusTone, string> = {
  confirmed: 'text-status-positive',
  pending: 'text-status-pending',
  failed: 'text-status-negative'
};

const DISPLAY_DECIMAL_PLACES = 3;

function formatDisplayAmount(value: string): string {
  const sign = value.startsWith('+') ? '+' : '';
  const amount = new BigNumber(sign ? value.slice(1) : value);

  if (!amount.isFinite()) {
    return value;
  }

  return `${sign}${amount.decimalPlaces(DISPLAY_DECIMAL_PLACES, BigNumber.ROUND_DOWN).toFixed()}`;
}

export const ActivityRow: FC<ActivityRowProps> = ({
  icon,
  iconBg = 'bg-gray-50',
  title,
  subtitle,
  amount,
  status,
  timestamp,
  onClick,
  className
}) => {
  const handleClick = () => {
    if (!onClick) return;
    hapticLight();
    onClick();
  };
  return (
    <div
      role={onClick ? 'button' : undefined}
      onClick={onClick ? handleClick : undefined}
      className={classNames(
        'w-full flex items-center py-4 justify-between',
        onClick && 'cursor-pointer active:opacity-90 transition-opacity',
        className
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={classNames(
            'shrink-0 flex items-center justify-center w-10 h-10 rounded-10 text-pure-white',
            '[&_svg]:w-4 [&_svg]:h-4',
            iconBg
          )}
        >
          {icon}
        </div>

        <div className="flex flex-col text-heading-gray leading-tight dark:text-pure-white">
          <span className="font-heading text-base font-bold">{title}</span>
          {subtitle && <span className="font-heading text-xs opacity-50 font-medium leading-[100%]">{subtitle}</span>}
        </div>
      </div>

      <div className="flex flex-col items-end gap-0.5">
        {amount && (
          <span className="font-heading text-sm font-bold leading-tight">
            <span className={AMOUNT_COLOR[amount.direction ?? 'neutral']}>{formatDisplayAmount(amount.value)}</span>
            {amount.symbol ? <span className="text-heading-gray">{` ${amount.symbol}`}</span> : null}
          </span>
        )}
        {status && (
          <span
            className={classNames(
              'flex items-center gap-1 text-[10px] font-normal leading-none',
              STATUS_TEXT[status.tone]
            )}
          >
            <span className={classNames('w-1.5 h-1.5 rounded-full', STATUS_DOT[status.tone])} />
            {status.label}
          </span>
        )}
        {timestamp && <span className="text-[10px] text-[#8E8E93] font-regular">{timestamp}</span>}
      </div>
    </div>
  );
};

export default ActivityRow;
