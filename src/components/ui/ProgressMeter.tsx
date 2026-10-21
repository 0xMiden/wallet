import React from 'react';

import { cn } from 'lib/ui/util';

export interface ProgressMeterProps {
  /** How much is done, from 0 to `max`; clamped into that range. */
  value: number;
  max: number;
  /** What the meter measures, for assistive technology. */
  'aria-label': string;
  /** Layout only (margins, width). */
  className?: string;
  'data-testid'?: string;
}

/**
 * A static, determinate progress meter: an 8px `fill` track with an `accent` bar from the start.
 * For a count toward a goal (badges earned), not for loading, which is `Spinner` or `Skeleton`.
 */
export const ProgressMeter: React.FC<ProgressMeterProps> = ({
  value,
  max,
  'aria-label': ariaLabel,
  className,
  'data-testid': dataTestId
}) => {
  const clamped = max > 0 ? Math.min(Math.max(value, 0), max) : 0;
  const percent = max > 0 ? (clamped / max) * 100 : 0;
  return (
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={clamped}
      data-testid={dataTestId}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-fill', className)}
    >
      <div data-slot="bar" className="h-full rounded-full bg-accent-primary" style={{ width: `${percent}%` }} />
    </div>
  );
};
