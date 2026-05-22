import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';

import { hapticLight } from 'lib/mobile/haptics';

export type ActivityAmountDirection = 'positive' | 'negative' | 'neutral';
export type ActivityStatusTone = 'confirmed' | 'pending' | 'failed';

export interface ActivityRowProps {
  /** Glyph rendered inside the colored square. Pass a white-stroked SVG. */
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
    direction?: ActivityAmountDirection;
  };
  status: {
    label: string;
    tone: ActivityStatusTone;
  };
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

export const ActivityRow: FC<ActivityRowProps> = ({
  icon,
  iconBg = 'bg-gray-50',
  title,
  subtitle,
  amount,
  status,
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
        'w-full flex items-center gap-3 py-3 justify-between',
        onClick && 'cursor-pointer active:opacity-90 transition-opacity',
        className
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={classNames('shrink-0 flex items-center justify-center w-10 h-10 rounded-10 text-white', iconBg)}
        >
          {icon}
        </div>

        <div className="flex flex-col text-heading-gray leading-tight dark:text-white">
          <span className="text-base font-bold">{title}</span>
          {subtitle && <span className="text-xs opacity-50 font-medium">{subtitle}</span>}
        </div>
      </div>

      <div className="flex flex-col items-end gap-0.5">
        {amount && (
          <span
            className={classNames(
              'text-sm font-semibold leading-tight font-tnum',
              AMOUNT_COLOR[amount.direction ?? 'neutral']
            )}
          >
            {amount.value}
          </span>
        )}
        <span
          className={classNames(
            'flex items-center gap-1 text-[10px] font-normal leading-none',
            STATUS_TEXT[status.tone]
          )}
        >
          <span className={classNames('w-1.5 h-1.5 rounded-full', STATUS_DOT[status.tone])} />
          {status.label}
        </span>
      </div>
    </div>
  );
};

export default ActivityRow;
