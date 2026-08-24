import React, { HTMLAttributes } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';

import { CircleButton } from './CircleButton';

export interface NavigationHeaderProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  mode?: 'back' | 'close';
  onBack?: () => void;
  onClose?: () => void;
  showBorder?: boolean;
  innerDivClassName?: string;
  /** 'prominent' uses the tab-header title weight and a rounded divider bar below. */
  variant?: 'default' | 'prominent';
  /** Title placement; 'left' sits the title next to the back button. */
  titleAlign?: 'center' | 'left';
}

export const NavigationHeader: React.FC<NavigationHeaderProps> = ({
  className,
  onBack,
  onClose,
  showBorder = false,
  innerDivClassName,
  variant = 'default',
  titleAlign = 'center',
  ...props
}) => {
  const { t } = useTranslation();
  const prominent = variant === 'prominent';
  const centered = titleAlign === 'center';
  return (
    <>
      <div
        className={classNames(
          'flex flex-row px-4 items-center w-full bg-app-bg',
          showBorder && 'border-b-[0.5px] border-border-card',
          'py-4',
          className
        )}
      >
        <div className={classNames('flex flex-row items-center gap-x-4 w-full text-xl text-black', innerDivClassName)}>
          {onBack ? (
            // text-black auto-flips to white in dark mode; currentColor carries it
            // into the SVG fill so the arrow stays visible on the dark circle.
            <CircleButton
              aria-label={t('back')}
              icon={prominent ? IconName.ArrowLeft : IconName.ChevronLeft}
              onClick={onBack}
              className={classNames('shrink-0', prominent && 'w-10 h-10 bg-gray-25 text-black')}
              size="sm"
              color={prominent ? 'currentColor' : undefined}
            />
          ) : null}
          <h1
            className={classNames(
              'font-heading flex-1',
              centered ? 'text-center' : 'text-left',
              prominent ? 'text-[28px] font-bold text-heading-gray' : 'font-medium',
              onBack && centered ? 'pr-10' : ''
            )}
          >
            {props.title}
          </h1>
        </div>
        {onClose ? (
          // CircleButton defaults its icon fill to a literal `black`, which is
          // invisible against the dark app background; currentColor hands the
          // glyph to text-black instead, which auto-flips with the theme.
          <CircleButton
            aria-label={t('close')}
            icon={IconName.Close}
            onClick={onClose}
            className={classNames('shrink-0 text-black', prominent && 'w-10 h-10 bg-gray-25')}
            size={prominent ? 'sm' : undefined}
            color="currentColor"
          />
        ) : null}
      </div>
      {prominent && <div aria-hidden="true" className="shrink-0 mx-4 mb-4 h-1 rounded-full bg-gray-50" />}
    </>
  );
};
