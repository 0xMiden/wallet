import React from 'react';

import classNames from 'clsx';

export interface ProgressIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {
  steps: number;
  currentStep: number;
}
export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({ className, steps, currentStep, ...props }) => {
  return (
    <div {...props} className={classNames('flex justify-center items-center gap-2 w-10', className)}>
      {Array.from({ length: steps }).map((_, index) => (
        <div
          key={index}
          className={classNames('w-2 h-2 rounded-full', index < currentStep ? 'bg-primary-500' : 'bg-grey-200')}
        />
      ))}
    </div>
  );
};
