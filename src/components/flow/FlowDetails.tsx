import React from 'react';

import clsx from 'clsx';

import { hapticLight } from 'lib/mobile/haptics';

import { ACCENT_CLASSES, FlowAccent } from './accent';

export interface FlowDetailRowProps {
  label: string;
  /** The value. A long value (an address) wraps instead of truncating. */
  children: React.ReactNode;
  /** Secondary line under the value, e.g. a fee note. */
  sub?: React.ReactNode;
  /** Inline action after the value, e.g. "Edit". */
  action?: { label: string; onClick: () => void };
  /** Stack the value under the label, for values too long to sit beside it. */
  stacked?: boolean;
  accent?: FlowAccent;
  'data-testid'?: string;
}

/** One label/value row of a FlowDetails card. */
export const FlowDetailRow: React.FC<FlowDetailRowProps> = ({
  label,
  children,
  sub,
  action,
  stacked = false,
  accent = 'brand',
  'data-testid': dataTestId
}) => (
  <div
    data-testid={dataTestId}
    className={clsx('flex gap-x-4 gap-y-1 px-4 py-3', stacked ? 'flex-col' : 'items-start')}
  >
    <span className={clsx('shrink-0 text-sm leading-6 text-text-muted', !stacked && 'min-w-20')}>{label}</span>
    <div className={clsx('flex min-w-0 flex-1 flex-col gap-1', stacked ? 'items-start' : 'items-end text-right')}>
      <div className="flex max-w-full items-center gap-2 font-heading text-base leading-6 font-bold text-heading-gray break-all">
        {children}
        {action && (
          <button
            type="button"
            onClick={() => {
              hapticLight();
              action.onClick();
            }}
            className={clsx('shrink-0 font-heading text-sm font-bold', ACCENT_CLASSES[accent].text)}
          >
            {action.label}
          </button>
        )}
      </div>
      {sub && <span className="text-xs leading-4 text-text-muted">{sub}</span>}
    </div>
  </div>
);

/** A compact card of label/value rows with hairline dividers. */
export const FlowDetails: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={clsx('divide-y divide-rule-default rounded-2xl bg-surface-interactive', className)}>{children}</div>
);
