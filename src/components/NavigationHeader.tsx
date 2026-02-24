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
        'flex flex-row px-4 items-center w-full bg-gray-25',
        showBorder && 'border-b-[0.5px] border-[#48484833]',
        isMobile() ? 'py-6' : 'py-4',
        className
      )}
    >
      <div
        className={classNames('flex flex-row items-center gap-x-4 w-full text-xl text-heading-gray', innerDivClassName)}
      >
        {onBack ? <CircleButton icon={IconName.ChevronLeft} onClick={onBack} className="shrink-0" size="sm" /> : null}
        <h1 className={classNames('flex-1 font-medium text-center', onBack ? 'pr-10' : '')}>{props.title}</h1>
      </div>
      {onClose ? <CircleButton icon={IconName.Close} onClick={onClose} /> : null}
    </div>
  );
};
