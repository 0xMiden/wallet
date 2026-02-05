import React, { HTMLAttributes } from 'react';

import classNames from 'clsx';

import { IconName } from 'app/icons/v2';
import { isMobile } from 'lib/platform';

import { CircleButton } from './CircleButton';

export interface NavigationHeaderProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  mode?: 'back' | 'close';
  onBack?: () => void;
  onClose?: () => void;
  showBorder?: boolean;
  innerDivClassName?: string;
}

export const NavigationHeader: React.FC<NavigationHeaderProps> = ({
  className,
  onBack,
  onClose,
  showBorder = false,
  innerDivClassName,
  ...props
}) => {
  return (
    <div
      className={classNames(
        'flex flex-row px-4 items-center justify-between',
        showBorder && 'border-b border-grey-100',
        className
      )}
      style={{ paddingTop: isMobile() ? '24px' : '14px', paddingBottom: '14px' }}
    >
      <div className={classNames('flex flex-row items-center gap-x-4', innerDivClassName)}>
        {onBack ? <CircleButton icon={IconName.ArrowLeft} onClick={onBack} /> : null}
        <h1 className="text-lg font-semibold">{props.title}</h1>
      </div>
      {onClose ? <CircleButton icon={IconName.Close} onClick={onClose} /> : null}
    </div>
  );
};
