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
    'h-[56px] p-2', // Size and padding classes
    'gap-x-2 bg-white', // Gap and background classes
    'rounded-lg transition', // Shape and transition classes
    'duration-300 ease-in-out', // Transition duration and timing function classes
    hoverable && 'hover:bg-grey-50 cursor-pointer', // Hover and cursor classes
    'overflow-hidden w-full',
    className // User-defined classes
  );

  return (
    <div {...props} className={cardItemClasses} onClick={handleClick}>
      <div className="shrink-0">{iconLeft && <LeftIconOrComponent icon={iconLeft} color="black" />}</div>
      <div className="flex overflow-hidden w-full justify-between">
        <div className="flex-col flex justify-center overflow-hidden">
          {title && (
            <p
              className={classNames('text-sm font-medium text-black truncate text-ellipsis text-left', titleClassName)}
            >
              {title}
            </p>
          )}
          {subtitle && (
            <p className={classNames('text-xs text-grey-600 truncate text-ellipsis', subtitleClassName)}>{subtitle}</p>
          )}
        </div>
        {(titleRight || subtitleRight) && (
          <div className="text-sm text-grey-600 flex flex-col justify-center items-end">
            {titleRight && <div className="text-[17px] font-medium text-black">{titleRight}</div>}
            {subtitleRight && <div className="text-xs text-grey-600">{subtitleRight}</div>}
          </div>
        )}
      </div>
      <div className="shrink-0">{iconRight && <IconOrComponent icon={iconRight} color="black" />}</div>
    </div>
  );
};
