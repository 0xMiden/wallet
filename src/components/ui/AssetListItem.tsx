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
}

export const AssetListItem: FC<AssetListItemProps> = ({
  icon,
  name,
  amount,
  chart,
  price,
  delta,
  onClick,
  className
}) => {
  const handleClick = () => {
    if (!onClick) return;
    hapticLight();
    onClick();
  };

  const deltaColor =
    delta?.direction === 'negative'
      ? 'text-status-negative'
      : delta?.direction === 'neutral'
        ? 'text-text-tertiary-token'
        : 'text-status-positive';

  return (
    <div
      role={onClick ? 'button' : undefined}
      onClick={onClick ? handleClick : undefined}
      className={classNames(
        'w-full h-[72px] flex items-center gap-3',
        onClick && 'cursor-pointer active:opacity-90 transition-opacity',
        className
      )}
    >
      <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center overflow-hidden">
        {icon}
      </div>

      <div className="flex flex-col min-w-0 shrink-0 max-w-[40%]">
        <div className="text-base font-bold leading-tight text-text-primary-token truncate">{name}</div>
        <div className="text-sm font-normal leading-tight text-text-tertiary-token truncate">{amount}</div>
      </div>

      <div className="flex-1 min-w-0 flex items-center justify-center">
        {chart}
      </div>

      <div className="flex flex-col items-end shrink-0">
        {price && (
          <div className="text-base font-semibold leading-tight text-text-primary-token">{price}</div>
        )}
        {delta && (
          <div className={classNames('text-sm font-medium leading-tight', deltaColor)}>{delta.value}</div>
        )}
      </div>
    </div>
  );
};

export default AssetListItem;
