import React from 'react';

import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

export interface DetailRowProps {
  label: string;
  /** The value. A long value (an address) wraps instead of truncating. */
  children: React.ReactNode;
  /** Secondary line under the value, e.g. a fee note. */
  sub?: React.ReactNode;
  /**
   * Rendered right after the label — an `InfoHint`, for a row whose explanation is a sentence.
   * A sentence belongs here rather than in `sub`: three wrapped lines under a value push the
   * rows apart and make the card read as prose.
   */
  info?: React.ReactNode;
  /** Inline text action after the value, e.g. "Edit" or "Copy". Always `accent-tint-ink` — the only accent that clears 4.5:1 on `fill` (Rule 6). */
  action?: { label: string; onClick: () => void };
  /** Stack the value under the label, for values too long to sit beside it (e.g. a full address). */
  stacked?: boolean;
  className?: string;
  'data-testid'?: string;
}

/** One label/value row of a `DetailCard`. */
export const DetailRow: React.FC<DetailRowProps> = ({
  label,
  children,
  sub,
  info,
  action,
  stacked = false,
  className,
  'data-testid': dataTestId
}) => (
  <div
    data-testid={dataTestId}
    className={cn('flex gap-x-4 gap-y-1 px-4 py-3', stacked ? 'flex-col' : 'items-start', className)}
  >
    <span className={cn('flex shrink-0 items-center gap-0.5 text-body-sm text-muted', !stacked && 'min-w-20')}>
      {label}
      {info}
    </span>
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1', stacked ? 'items-start' : 'items-end text-right')}>
      <div className={cn('flex max-w-full items-center gap-2 text-value text-ink', stacked && 'break-all')}>
        {children}
        {action && (
          <button
            type="button"
            onClick={() => {
              hapticLight();
              action.onClick();
            }}
            className="shrink-0 text-action text-accent-tint-ink"
          >
            {action.label}
          </button>
        )}
      </div>
      {sub && <span className="text-caption text-muted">{sub}</span>}
    </div>
  </div>
);

/** A `fill` card of label/value rows with hairline dividers between them, 16px radius. */
export const DetailCard: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={cn('divide-y divide-hairline rounded-2xl bg-fill', className)}>{children}</div>
);
