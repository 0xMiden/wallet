import React from 'react';

import { motion } from 'framer-motion';

import { springs, useMotion } from 'lib/animation';
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
 * A determinate progress meter: an 8px `fill` track with an `accent` bar from the start. The bar
 * is the track's full width and slides in from the left, so its end stays round at every value; it
 * travels to a new value on the `standard` spring and is simply in place on mount.
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
  const transition = useMotion(springs.standard);
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
      <motion.div
        data-slot="bar"
        data-percent={percent}
        className="h-full w-full rounded-full bg-accent-primary"
        initial={false}
        animate={{ x: `${percent - 100}%` }}
        transition={transition}
      />
    </div>
  );
};
