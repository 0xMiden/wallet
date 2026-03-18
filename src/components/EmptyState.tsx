import React from 'react';

import classNames from 'clsx';

import { Icon, IconName } from 'app/icons/v2';

export interface EmptyStateProps extends React.ButtonHTMLAttributes<HTMLDivElement> {
  icon: IconName;
  title: string;
  description: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  className,
  icon = IconName.Apps,
  title,
  description,
  ...props
}) => {
  return (
    <div {...props} className={classNames('flex flex-col items-center justify-center gap-y-1', className)}>
      <Icon name={icon} fill="currentColor" size="xl" />
      <div className="flex flex-col items-center gap-y-2">
        <h1 className="font-semibold text-lg">{title}</h1>
        <p className="text-sm">{description}</p>
      </div>
    </div>
  );
};
