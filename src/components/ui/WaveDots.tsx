import React from 'react';

import { motion, useReducedMotion } from 'framer-motion';

import { springs } from 'lib/animation';
import { cn } from 'lib/ui/util';

const DOTS = [0, 1, 2];
/** Each dot starts a beat after the one before it, so the row reads as a wave, not a blink. */
const STAGGER_S = 0.14;

export interface WaveDotsProps {
  /** Announced in place of the dots, e.g. "Calculating". */
  label: string;
  /** Layout and colour; the dots take `currentColor`. */
  className?: string;
}

/**
 * Three dots riding a wave, for a control that is waiting on a number rather than on a whole page —
 * a quote being computed under a CTA. A Spinner says "loading"; this says "still you, one moment".
 * Under reduced motion the dots hold still.
 */
export const WaveDots: React.FC<WaveDotsProps> = ({ label, className }) => {
  const reduce = useReducedMotion();

  return (
    <span role="status" aria-label={label} className={cn('flex items-center gap-1.5', className)}>
      {DOTS.map(index => (
        <motion.span
          key={index}
          aria-hidden="true"
          className="size-1.5 rounded-full bg-current"
          initial={false}
          animate={reduce ? { y: 0 } : { y: [0, -4, 0] }}
          transition={
            reduce
              ? { duration: 0 }
              : { ...springs.snappy, repeat: Infinity, repeatDelay: 0.18, delay: index * STAGGER_S }
          }
        />
      ))}
    </span>
  );
};
