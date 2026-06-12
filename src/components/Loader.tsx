import React from 'react';

import classNames from 'clsx';

import { Icon, IconName, IconProps, IconSize } from 'app/icons/v2';

export interface LoaderProps extends Omit<IconProps, 'name'> {
  size?: IconSize;
  color?: string;
  className?: string;
}

export const Loader: React.FC<LoaderProps> = ({ className, color = 'currentColor', size = 'md', ...props }) => {
  return (
    <Icon
      {...props}
      name={IconName.Loader}
      fill={color}
      size={size}
      className={classNames('animate-spin', className)}
    />
  );
};
