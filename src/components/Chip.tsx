import React from 'react';

import classNames from 'clsx';

import { hapticLight } from 'lib/mobile/haptics';

export interface ChipProps extends React.ComponentProps<'label'> {
  label: string | React.ReactNode;
  selected?: boolean;
  className?: string;
}

const defaultClassName = 'bg-white border border-grey-100 text-black hover:border-grey-200 hover:bg-grey-50';
const selectedClassName = 'bg-black border border-black text-white hover:bg-grey-800';

export const Chip: React.FC<ChipProps> = ({ label, selected, className, onClick, ...props }) => {
  const stateClassName = selected ? selectedClassName : defaultClassName;

  const handleClick = (e: React.MouseEvent<HTMLLabelElement>) => {
    if (onClick) {
      hapticLight();
      onClick(e);
    }
  };

  return (
    <label
      {...props}
      className={classNames(
        'flex items-center justify-center',
        'px-3 py-2 min-h-8 rounded-[10px]',
        'transition duration-300 ease-in-out',
        'font-base text-sm',
        stateClassName,
        className
      )}
      onClick={handleClick}
    >
      {label}
    </label>
  );
};
