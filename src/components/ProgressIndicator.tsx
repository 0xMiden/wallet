import React from 'react';

import classNames from 'clsx';

export interface ProgressIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {
  steps: number;
  currentStep: number;
}
export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({ className, steps, currentStep, ...props }) => {
  return (
    <div {...props} className={classNames('flex items-center gap-1 w-full', className)}>
      {Array.from({ length: steps }).map((_, index) => (
        <div
          key={index}
          className={classNames(
            'h-1.5 flex-1',
            index <= currentStep - 1 ? 'bg-primary-500' : 'bg-grey-200',
            index === 0 ? 'rounded-l-10' : '',
            index === steps - 1 ? 'rounded-r-10' : ''
          )}
        />
      ))}
    </div>
  );
};
