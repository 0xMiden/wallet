import React from 'react';

import clsx from 'clsx';

export type SpinnerSize = 'sm' | 'md' | 'lg';

const SIZE_PX: Record<SpinnerSize, number> = { sm: 16, md: 24, lg: 32 };

export interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
  'data-testid'?: string;
}

/**
 * The app's loading ring: `accent` on `fill`, 0.9s per turn.
 *
 * The rotation is a CSS transform on the HTML wrapper, not a JS-driven
 * rotate on an SVG child — same reasoning as `FlowSpinner`: a transform
 * animation on an HTML element composites on the GPU at the display's
 * refresh rate, while a per-frame rotate driven from JS repaints on the
 * main thread and drops frames whenever the page is busy.
 *
 * Reduced motion SLOWS the ring (0.9s → 1.8s) rather than stopping it: a
 * frozen spinner reads as a hung control, not as "no motion requested".
 */
export const Spinner: React.FC<SpinnerProps> = ({ size = 'md', className, 'data-testid': dataTestId }) => {
  const px = SIZE_PX[size];
  const stroke = Math.max(2, px * 0.12);
  const r = (px - stroke) / 2;
  const circumference = 2 * Math.PI * r;

  return (
    <div
      role="presentation"
      aria-hidden="true"
      data-testid={dataTestId}
      className={clsx(
        'inline-block shrink-0 will-change-transform text-accent-primary',
        'animate-[spin_0.9s_linear_infinite] motion-reduce:animate-[spin_1.8s_linear_infinite]',
        className
      )}
      style={{ width: px, height: px }}
    >
      <svg width={px} height={px} viewBox={`0 0 ${px} ${px}`} fill="none">
        <circle cx={px / 2} cy={px / 2} r={r} stroke="currentColor" strokeOpacity={0.18} strokeWidth={stroke} />
        <circle
          cx={px / 2}
          cy={px / 2}
          r={r}
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * 0.28} ${circumference}`}
          transform={`rotate(-90 ${px / 2} ${px / 2})`}
        />
      </svg>
    </div>
  );
};
