import React from 'react';

import classNames from 'clsx';

import { Icon, IconName, IconSize } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { IconOrComponent } from 'utils/icon-or-component';

/**
 * CardItemProps interface for CardItem component
 */
export interface CardItemProps extends React.ComponentProps<'div'> {
  className?: string;
  iconLeft?: React.ReactNode | IconName;
  iconRight?: React.ReactNode | IconName;
  title?: string;
  subtitle?: string;
  titleRight?: string;
  subtitleRight?: string;
  hoverable?: boolean;
  titleClassName?: string;
  subtitleClassName?: string;
  titleRightClassName?: string;
  subtitleRightClassName?: string;
}

export const LeftIconOrComponent = ({
  icon,
  color,
  size = 'md'
}: {
  icon: React.ReactNode | IconName;
  color: string;
  size?: IconSize;
}) => {
  if (Object.values(IconName).includes(icon as IconName)) {
    return (
      <div className="bg-grey-50 p-2 rounded-full">
        <Icon name={icon as IconName} fill={color} className="w-4 h-4" size={size} />
      </div>
    );
  }

  return <>{icon}</>;
};

/**
 * CardItem functional component
 * @param {CardItemProps} props - properties that define the CardItem component
 * @returns {JSX.Element} - rendered CardItem component
 */
export const CardItem: React.FC<CardItemProps> = ({
  className,
  title,
  subtitle,
  iconLeft,
  iconRight,
  titleRight,
  subtitleRight,
  hoverable = false,
  onClick,
  titleClassName,
  subtitleClassName,
  titleRightClassName,
  subtitleRightClassName,
  ...props
}) => {
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (hoverable && onClick) {
      hapticLight();
      onClick(e);
    }
  };
  const cardItemClasses = classNames(
    'flex items-center justify-evenly', // Layout classes
    'p-2', // Size and padding classes
    'gap-x-2 bg-app-bg', // Gap and background classes
    'rounded-lg transition', // Shape and transition classes
    'duration-300 ease-in-out cursor-pointer', // Transition duration and timing function classes
    'overflow-hidden w-full',
    className // User-defined classes
  );

  return (
    <div {...props} className={cardItemClasses} onClick={handleClick}>
      <div className="shrink-0">{iconLeft && <LeftIconOrComponent icon={iconLeft} color="black" />}</div>
      <div className="flex overflow-hidden w-full justify-between">
        <div className="flex-col flex justify-center overflow-hidden gap-1">
          {title && (
            <p
              className={classNames(
                'text-base font-semidbold text-black truncate text-ellipsis text-left leading-[100%]',
                titleClassName
              )}
            >
              {title}
            </p>
          )}
          {subtitle && (
            <p
              className={classNames(
                'text-sm text-black truncate text-ellipsis leading-[100%] opacity-50 font-medium',
                subtitleClassName
              )}
            >
              {subtitle}
            </p>
          )}
        </div>
        {(titleRight || subtitleRight) && (
          <div className="text-sm text-grey-600 flex flex-col justify-center items-end gap-1">
            {titleRight && (
              <div className={classNames('text-base leading-[100%] font-medium text-black', titleRightClassName)}>
                {titleRight}
              </div>
            )}
            {subtitleRight && (
              <div className={classNames('text-sm leading-[100%] text-black opacity-50', subtitleRightClassName)}>
                {subtitleRight}
              </div>
            )}
          </div>
        )}
      </div>
      {iconRight && (
        <div className="shrink-0">
          <IconOrComponent icon={iconRight} color="black" />
        </div>
      )}
    </div>
  );
};
