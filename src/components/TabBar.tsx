import React from 'react';

import classNames from 'clsx';

import { Icon, IconName } from 'app/icons/v2';
import { hapticSelection } from 'lib/mobile/haptics';
import colors from 'utils/tailwind-colors';

export interface TabProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  activeIcon?: IconName;
  active?: boolean;
}

const Tab: React.FC<TabProps> = ({ className, icon, active, activeIcon, ...props }) => {
  const iconColor = active ? colors.primary[500] : 'black';
  return (
    <button
      type="button"
      {...props}
      className={classNames('flex-1 flex items-stretch justify-center py-2 group', className)}
    >
      <span
        className={classNames(
          'aspect-square flex items-center justify-center rounded-full',
          'transition duration-300 ease-in-out',
          'group-hover:bg-grey-25',
          {
            'bg-grey-25': active,
            'bg-transparent': !active
          }
        )}
      >
        <Icon name={active && activeIcon ? activeIcon : icon} fill={iconColor} size="md" />
      </span>
    </button>
  );
};

export interface TabBarProps extends React.HTMLAttributes<HTMLDivElement> {
  tabs: TabProps[];
  onTabChange?: (index: number) => void;
}

export const TabBar: React.FC<TabBarProps> = ({ tabs, className, onTabChange, ...props }) => {
  const handleTabChange = (index: number) => {
    if (onTabChange) {
      hapticSelection();
      onTabChange(index);
    }
  };
  return (
    <div
      className={classNames(
        'flex-1 flex h-[72px]',
        'border-t border-grey-100',
        'backdrop-blur-lg bg-pure-white/[.70] dark:bg-pure-black/[.70]',
        className
      )}
      {...props}
    >
      {tabs.map((tab, index) => (
        <Tab key={index} {...tab} onClick={() => handleTabChange(index)} />
      ))}
    </div>
  );
};
