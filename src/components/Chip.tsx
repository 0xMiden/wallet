import React from 'react';

import classNames from 'clsx';

import { hapticLight } from 'lib/mobile/haptics';

export interface ChipProps extends React.ComponentProps<'label'> {
  label: string | React.ReactNode;
  selected?: boolean;
  className?: string;
}

// hover:bg-gray-50 maps to --color-surface-tertiary → #f3f3f3 / #333333 so the
// hover state stays readable when text-black auto-flips to white in dark mode.
// The previous hover:bg-grey-50 was a literal #F3F3F3 → invisible white-on-light.
const defaultClassName = 'bg-white border border-grey-100 text-black hover:border-grey-200 hover:bg-gray-50';
const selectedClassName = 'bg-pure-black border border-pure-black text-pure-white hover:bg-grey-800';

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
