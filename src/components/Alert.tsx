import React, { HTMLAttributes } from 'react';

import classNames from 'clsx';

import { Icon, IconName } from 'app/icons/v2';
import colors from 'utils/tailwind-colors';

export enum AlertVariant {
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
  Success = 'success'
}

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  variant: AlertVariant;
  title?: string | React.ReactNode;
  canDismiss?: boolean;
  className?: string;
}

const propsPerVariant = {
  [AlertVariant.Info]: {
    icon: IconName.InformationFill,
    color: 'var(--color-primary)',
    backgroundColor: 'bg-primary-50'
  },
  [AlertVariant.Warning]: {
    icon: IconName.WarningFill,
    color: colors.yellow[500],
    backgroundColor: 'bg-yellow-50'
  },
  [AlertVariant.Error]: {
    icon: IconName.CloseCircleFill,
    color: colors.yellow[500],
    backgroundColor: 'bg-red-50'
  },
  [AlertVariant.Success]: {
    icon: IconName.CheckboxCircleFill,
    color: colors.green[500],
    backgroundColor: 'bg-green-50'
  }
};

export const Alert: React.FC<AlertProps> = ({
  className,
  variant = AlertVariant.Info,
  title = 'Alert Title',
  canDismiss = false
}) => {
  const iconName = propsPerVariant[variant].icon;
  const iconColor = propsPerVariant[variant].color;
  const Title = title || 'Alert Title';

  return (
    <div className={classNames(propsPerVariant[variant].backgroundColor, 'rounded-lg relative', className)}>
      <div className="flex flex-row items-center gap-2 p-4">
        <Icon name={iconName} fill={iconColor} size="sm" />
        <span className="flex-1 text-xs">{Title}</span>
      </div>

      {canDismiss && (
        <button type="button" className="absolute -top-1 -right-3 bg-grey-300 rounded-full shadow">
          <Icon name={IconName.Close} fill={colors.grey[800]} size="sm" />
        </button>
      )}
    </div>
  );
};
