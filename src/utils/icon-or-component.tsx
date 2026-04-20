import React from 'react';

import clsx from 'clsx';

import { Icon, IconName, IconSize } from 'app/icons/v2';

export const IconOrComponent = ({
  icon,
  size = 'md',
  color,
  className
}: {
  className?: string;
  color?: string;
  icon: React.ReactNode | IconName;
  size?: IconSize;
}) => {
  if (Object.values(IconName).includes(icon as IconName)) {
    return <Icon name={icon as IconName} className={clsx('w-6 h-6', className)} fill={color} size={size} />;
  }

  return <>{icon}</>;
};
