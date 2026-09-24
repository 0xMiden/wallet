import React from 'react';

import { motion } from 'framer-motion';

import { springs, useMotion } from 'lib/animation';
import { cn } from 'lib/ui/util';

export interface ProgressIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {
  steps: number;
  currentStep: number;
}

const ACTIVE_WIDTH = 54;
const INACTIVE_WIDTH = 42;

/**
 * A flow's progress: one 6px segment per step, the steps done and the current one wider and in
 * `accent`, the rest on `fill-pressed`. The width moves on the standard spring (instant under reduced
 * motion); the colour swaps with the class.
 */
export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({ className, steps, currentStep, ...props }) => {
  const transition = useMotion(springs.standard);

  return (
    <div {...props} className={cn('flex items-center gap-0.5', className)}>
      {Array.from({ length: steps }).map((_, index) => {
        const isFilled = index <= currentStep - 1;
        return (
          <motion.div
            key={index}
            data-filled={isFilled}
            className={cn(
              'h-1.5 rounded-full transition-colors duration-200 motion-reduce:transition-none',
              isFilled ? 'bg-accent-primary' : 'bg-fill-pressed'
            )}
            initial={false}
            animate={{ width: isFilled ? ACTIVE_WIDTH : INACTIVE_WIDTH }}
            transition={transition}
          />
        );
      })}
    </div>
  );
};
