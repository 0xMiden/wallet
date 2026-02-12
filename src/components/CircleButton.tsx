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
        'transition duration-300 ease-in-out focus:outline-none shadow-none',
        'hover:bg-grey-50 focus:bg-grey-100 disabled:bg-grey-200',
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
