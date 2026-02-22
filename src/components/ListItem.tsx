import React from 'react';

import classNames from 'clsx';

import { IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { IconOrComponent } from 'utils/icon-or-component';

/**
 * ListItemProps interface for ListItem component
 */
export interface ListItemProps extends React.ComponentProps<'div'> {
  className?: string;
  iconLeft?: React.ReactNode | IconName;
  iconRight?: React.ReactNode | IconName;
  title?: string;
  subtitle?: string;
  titleClassName?: string;
}

/**
 * ListItem functional component
 * @param {ListItemProps} props - properties that define the ListItem component
 * @returns {JSX.Element} - rendered ListItem component
 */
export const ListItem: React.FC<ListItemProps> = ({
  className,
  title,
  subtitle,
  iconLeft,
  iconRight,
  onClick,
  titleClassName,
  ...props
}) => {
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (onClick) {
      hapticLight();
      onClick(e);
    }
  };
  const ListItemClasses = classNames(
    'flex items-center justify-evenly', // Layout classes
    'h-[48px] p-2', // Size and padding classes
    'gap-x-4 bg-white', // Gap and background classes
    'rounded-lg transition', // Shape and transition classes
    'duration-300 ease-in-out', // Transition duration and timing function classes
    'hover:bg-grey-50 cursor-pointer', // Hover and cursor classes
    'overflow-hidden',
    className // User-defined classes
  );

  return (
    <div {...props} className={ListItemClasses} onClick={handleClick}>
      {iconLeft && <IconOrComponent icon={iconLeft} color="black" />}
      <div className="flex flex-1 justify-between overflow-hidden">
        {title && (
          <div className={classNames('text-sm text-heading-gray truncate text-ellipsis ', titleClassName)}>{title}</div>
        )}
        {subtitle && <div className="text-sm text-grey-600 truncate text-ellipsis shrink-0">{subtitle}</div>}
      </div>
      {iconRight && <IconOrComponent icon={iconRight} color="black" />}
    </div>
  );
};
