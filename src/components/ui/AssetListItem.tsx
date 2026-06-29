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

  const deltaColor =
    delta?.direction === 'negative'
      ? 'text-status-negative'
      : delta?.direction === 'neutral'
        ? 'text-text-tertiary-token'
        : 'text-status-positive';

  return (
    <div
      data-testid={dataTestId}
      role={onClick ? 'button' : undefined}
      onClick={onClick ? handleClick : undefined}
      className={classNames(
        'w-full h-18 flex items-center justify-between font-heading',
        onClick && 'cursor-pointer active:opacity-90 transition-opacity',
        className
      )}
    >
      <div className="flex items-center gap-2">
        <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center overflow-hidden">{icon}</div>

        <div className="flex flex-col min-w-0 shrink-0 font-bold">
          <div className="text-base  leading-tight text-heading-gray truncate">{name}</div>
          <div className="font-heading text-sm  leading-tight text-[#00000080]">{amount}</div>
        </div>
      </div>

      <div className="flex items-center justify-center">{chart}</div>

      <div className="flex flex-col items-end font-bold">
        {price && <div className="text-base font-semibold leading-tight text-heading-gray">{price}</div>}
        {delta && <div className={classNames('text-xs leading-tight', deltaColor)}>{delta.value}</div>}
      </div>
    </div>
  );
};

export default AssetListItem;
