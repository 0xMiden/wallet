import React from 'react';

import clsx from 'clsx';
import { useReducedMotion } from 'framer-motion';

import { ACCENT_CLASSES, FlowAccent } from './accent';

export interface FlowSpinnerProps {
  accent: FlowAccent;
  /** Pixel size of the ring. */
  size: number;
  /** Ring thickness as a fraction of the size. */
  thickness?: number;
  className?: string;
}

/**
 * A round-capped ring spinner in the flow's accent.
 *
 * The rotation is a CSS transform on the HTML wrapper, not a JS-driven rotate on an SVG child:
 * WebKit composites a transform animation on an HTML element on the GPU at the display's refresh
 * rate, while a Framer Motion rotate on an SVG node repaints on the main thread and drops frames
 * whenever the page is busy (the transaction pipeline runs on the same thread).
 */
export const FlowSpinner: React.FC<FlowSpinnerProps> = ({ accent, size, thickness = 0.12, className }) => {
  const reduceMotion = useReducedMotion();
  const stroke = Math.max(2, size * thickness);
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;

  return (
    <div
      role="presentation"
      aria-hidden="true"
      data-testid="flow-spinner"
      className={clsx(
        'shrink-0 will-change-transform',
        ACCENT_CLASSES[accent].text,
        !reduceMotion && 'animate-[spin_0.9s_linear_infinite]',
        className
      )}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="currentColor" strokeOpacity={0.18} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * 0.28} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
    </div>
  );
};
