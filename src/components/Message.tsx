import React from 'react';

import classNames from 'clsx';

import { Icon, IconName, IconSize } from 'app/icons/v2';

export interface MessageProps extends React.ButtonHTMLAttributes<HTMLDivElement> {
  icon: IconName;
  title: string;
  description: string;
  secondDescription?: string;
  descriptionClasses?: string;
  iconBackgroundClassName?: string;
  iconClassName?: string;
  iconSize?: IconSize;
}

export const Message: React.FC<MessageProps> = ({
  className,
  iconBackgroundClassName,
  icon = IconName.Apps,
  title,
  description,
  secondDescription,
  iconClassName,
  descriptionClasses,
  iconSize = 'xxl',
  ...props
}) => {
  return (
    <div className="w-full h-full">
      <div {...props} className="flex flex-col justify-center items-center h-full text-heading-gray">
        <div className={classNames('w-40 aspect-square flex items-center justify-center', iconBackgroundClassName)}>
          <Icon name={icon} size={iconSize} className={iconClassName} />
        </div>
        <div className="flex flex-col items-center">
          <h1 className="font-semibold text-2xl lh-title">{title}</h1>
          {/* <p className="text-base text-center lh-title">{description}</p>
          {secondDescription && (
            <p className={`mt-2 text-base text-center ${descriptionClasses}`}>{secondDescription}</p>
          )} */}
        </div>
      </div>
    </div>
  );
};
