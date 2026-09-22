import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';

import { hapticLight } from 'lib/mobile/haptics';

export type AssetDeltaDirection = 'positive' | 'negative' | 'neutral';

export interface AssetListItemProps {
  icon: ReactNode;
  name: string;
  amount: string;
  chart?: ReactNode;
  price?: string;
  delta?: {
    value: string;
    direction?: AssetDeltaDirection;
  };
  onClick?: () => void;
  className?: string;
  'data-testid'?: string;
}

export const AssetListItem: FC<AssetListItemProps> = ({
  icon,
  name,
  amount,
  chart,
  price,
  delta,
  onClick,
  className,
  'data-testid': dataTestId
}) => {
  const handleClick = () => {
    if (!onClick) return;
    hapticLight();
    onClick();
  };

  // The status badge's sage and clay inks, the same pair ActivityRow uses: the raw status fills are
  // 2.2-3.5:1 and never carry text (design-system Rule 3). Neutral keeps its muted token, which is
  // not a fill.
  const deltaColor =
    delta?.direction === 'negative'
      ? 'text-negative-tint-ink'
      : delta?.direction === 'neutral'
        ? 'text-text-tertiary-token'
        : 'text-positive-tint-ink';

  return (
    <div
      data-testid={dataTestId}
      role={onClick ? 'button' : undefined}
      onClick={onClick ? handleClick : undefined}
      className={classNames(
        'w-full h-18 flex items-center justify-between',
        onClick && 'cursor-pointer active:opacity-90 transition-opacity',
        className
      )}
    >
      <div className="flex items-center gap-2">
        <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center overflow-hidden">{icon}</div>

        <div className="flex flex-col min-w-0 shrink-0">
          <div className="text-row-title text-ink truncate">{name}</div>
          <div className="text-caption text-muted">{amount}</div>
        </div>
      </div>

      <div className="flex items-center justify-center">{chart}</div>

      <div className="flex flex-col items-end">
        {price && <div className="text-row-title text-ink">{price}</div>}
        {delta && <div className={classNames('text-caption', deltaColor)}>{delta.value}</div>}
      </div>
    </div>
  );
};

export default AssetListItem;
