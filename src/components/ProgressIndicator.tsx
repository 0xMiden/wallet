import React from 'react';

import classNames from 'clsx';
import { motion } from 'framer-motion';

import { PRIMARY_500 } from 'utils/brand-colors';

export interface ProgressIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {
  steps: number;
  currentStep: number;
}

const ACTIVE_WIDTH = 54;
const INACTIVE_WIDTH = 42;
const FILLED_COLOR = PRIMARY_500;
const EMPTY_COLOR = '#D9D9D9';

export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({ className, steps, currentStep, ...props }) => {
  return (
    <div {...props} className={classNames('flex items-center gap-0.5', className)}>
      {Array.from({ length: steps }).map((_, index) => {
        const isFilled = index <= currentStep - 1;
        return (
          <motion.div
            key={index}
            className="h-1.5 rounded-full"
            initial={false}
            animate={{
              width: isFilled ? ACTIVE_WIDTH : INACTIVE_WIDTH,
              backgroundColor: isFilled ? FILLED_COLOR : EMPTY_COLOR
            }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          />
        );
      })}
    </div>
  );
};
