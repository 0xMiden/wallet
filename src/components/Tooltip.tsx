import React from 'react';

import classNames from 'clsx';

export interface TooltipProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
  title: string;
  arrowPosition: 'top' | 'bottom' | 'left' | 'right';
}

const arrowClassPerPosition = {
  top: '-top-[8px] left-1/2 -translate-x-1/2 border-b-[16px] border-x-[16px] border-b-grey-800 border-x-transparent',
  bottom:
    '-bottom-[8px] left-1/2 -translate-x-1/2 border-t-[16px] border-x-[16px] border-t-grey-800 border-x-transparent',
  left: '-left-[8px] top-1/2 -translate-y-1/2 border-r-[16px] border-y-[16px] border-r-grey-800 border-y-transparent',
  right: '-right-[8px] top-1/2 -translate-y-1/2 border-l-[16px] border-y-[16px] border-l-grey-800 border-y-transparent'
};

export const Tooltip: React.FC<TooltipProps> = ({ className, title, arrowPosition = 'bottom', ...props }) => {
  return (
    <div {...props} className={classNames('relative bg-grey-800 px-3 py-2 rounded max-w-[200px]', className)}>
      <p className="text-pure-white text-sm ">{title}</p>
      <div className={classNames('absolute', arrowClassPerPosition[arrowPosition], 'h-0 w-0   ')} />
    </div>
  );
};
