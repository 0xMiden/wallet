import React from 'react';

import classNames from 'clsx';

import { Icon, IconName, IconSize } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import colors from 'utils/tailwind-colors';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  size?: IconSize;
  color?: string;
  isLoading?: boolean;
}

export const CircleButton: React.FC<ButtonProps> = ({
  className,
  disabled,
  isLoading,
  icon,
  size,
  color,
  ...props
}) => {
  const iconColor = disabled ? colors.grey[300] : color || 'black';
  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    hapticLight();
    e.currentTarget.blur();
    props.onClick?.(e);
  };

  return (
    <button
      className={classNames(
        isLoading ? 'pointer-events-none' : '',
        'flex justify-center items-center',
        'aspect-square rounded-full p-1',
        'transition-colors duration-150 ease-hover focus:outline-none shadow-none',
        // `focus:bg-gray-100` was the only focus affordance, and gray-100 is
        // #e1dbdb on white — a 1.37:1 tint, identical to hover, and 5% white in
        // dark mode. Keyboard users had no way to see where focus was, which this
        // PR made load-bearing: the converted settings pages are no longer
        // focus-trapping dialogs dismissable with Escape, so this chevron is the
        // only way back. `focus-visible` so a mouse click still shows nothing.
        'focus-visible:ring-2 focus-visible:ring-primary-500/60',
        'hover:bg-gray-100 focus:bg-gray-100 disabled:bg-gray-50',
        disabled ? 'cursor-default' : 'cursor-pointer',
        className
      )}
      disabled={disabled}
      type="button"
      {...props}
      onClick={onClick}
    >
      {isLoading ? (
        <Icon name={IconName.Loader} fill={iconColor} size={size || 'md'} className="animate-spin" />
      ) : (
        <Icon name={icon} fill={iconColor} size={size || 'md'} />
      )}
    </button>
  );
};
