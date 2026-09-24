import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';

import { ACCENT_CLASSES, type FlowAccent } from 'components/flow/accent';
import { hapticLight } from 'lib/mobile/haptics';

import { SelectionCheck } from './SelectionCheck';

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
  /**
   * A selectable row (a token picker): `true` draws the design system's round check after the
   * value, and the row reports `aria-pressed`. Leave undefined on a row that is not a choice.
   */
  selected?: boolean;
  /** Paints the check in a flow's colour; undefined leaves the brand accent. */
  accent?: FlowAccent;
  onClick?: () => void;
  className?: string;
  'data-testid'?: string;
  /**
   * Identifies the asset the row stands for, where the name and the test id cannot: two tokens can
   * share a symbol, so a caller that has to address one exactly passes its faucet id here.
   */
  'data-token-id'?: string;
}

export const AssetListItem: FC<AssetListItemProps> = ({
  icon,
  name,
  amount,
  chart,
  price,
  delta,
  selected,
  accent,
  onClick,
  className,
  'data-testid': dataTestId,
  'data-token-id': dataTokenId
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

  const classes = classNames(
    'w-full h-18 flex items-center justify-between text-left',
    onClick && [
      'cursor-pointer active:opacity-90 transition-opacity',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-inset'
    ],
    className
  );

  const content = (
    <>
      {/* The leading group gives way first: a long name or amount truncates rather than pushing the
          price and the check out of the row. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center overflow-hidden">{icon}</div>

        <div className="flex flex-col min-w-0">
          <div className="text-row-title text-ink truncate">{name}</div>
          <div className="text-caption text-muted truncate">{amount}</div>
        </div>
      </div>

      <div className="flex items-center justify-center">{chart}</div>

      <div data-slot="trailing" className="flex shrink-0 items-center gap-3">
        <div className="flex flex-col items-end">
          {price && <div className="text-row-title text-ink">{price}</div>}
          {delta && <div className={classNames('text-caption', deltaColor)}>{delta.value}</div>}
        </div>

        {selected && <SelectionCheck className={accent ? ACCENT_CLASSES[accent].bg : undefined} />}
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        data-testid={dataTestId}
        data-token-id={dataTokenId}
        onClick={handleClick}
        aria-pressed={selected}
        className={classes}
      >
        {content}
      </button>
    );
  }

  return (
    <div data-testid={dataTestId} data-token-id={dataTokenId} className={classes}>
      {content}
    </div>
  );
};

export default AssetListItem;
