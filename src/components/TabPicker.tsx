import React, { useMemo } from 'react';

import classNames from 'clsx';
import { motion, MotionConfig } from 'framer-motion';
import { v4 as uuid } from 'uuid';

import { Icon, IconName } from 'app/icons/v2';
import { isExtension } from 'lib/platform';
import colors from 'utils/tailwind-colors';

export interface TabPickerItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  id: string;
  title: string;
  icon?: IconName;
  activeIcon?: IconName;
  active?: boolean;
  disabled?: boolean;
  animationId?: string;
  onIconClick?: () => void;
}

const TabPickerItem: React.FC<TabPickerItemProps> = ({
  id,
  className,
  title,
  icon,
  active,
  activeIcon,
  disabled,
  animationId,
  onClick,
  onIconClick,
  ...props
}) => {
  // Icon fill is a literal CSS color (SVG fill prop), so Tailwind dark:
  // variants don't reach it — resolve against the current theme at render
  // time. `text-black` / `text-white` Tailwind tokens map to CSS variables
  // that already flip with .dark, but this `fill=` is a direct string.
  const isDarkMode =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const iconColor = useMemo(
    () => (disabled ? colors.grey[400] : isDarkMode ? 'white' : 'black'),
    [disabled, isDarkMode]
  );
  return (
    <button
      type="button"
      {...props}
      onClick={onClick}
      className={classNames(
        'flex-1 flex py-2 px-4 group  relative',
        'items-center justify-center',
        'gap-x-1',
        className
      )}
    >
      {active ? (
        <motion.div
          key={animationId}
          // bg-white maps to --color-surface (translucent dark in dark mode),
          // which is too low-contrast against the dark container. In dark mode
          // use a literal white at 15% for the pill so it actually reads.
          className="absolute w-full h-full bg-white dark:bg-pure-white/15 rounded-full"
          layoutId={animationId}
        />
      ) : null}
      <p
        className={classNames('text-sm font-medium z-10', {
          // text-black maps to --color-text-primary (white in dark mode) via
          // the Tailwind config — no explicit dark: variant needed.
          'text-black': !disabled,
          'text-grey-400': disabled
        })}
      >
        {title}
      </p>
      {icon ? (
        <Icon className="cursor-pointer z-10" name={icon} size="xs" fill={iconColor} onClick={onIconClick} />
      ) : null}
    </button>
  );
};

export interface TabPickerProps extends React.HTMLAttributes<HTMLDivElement> {
  tabs: TabPickerItemProps[];
  onTabChange?: (index: number) => void;
}

export const TabPicker: React.FC<TabPickerProps> = ({ tabs, className, onTabChange, ...props }) => {
  const handleTabChange = (index: number) => {
    if (onTabChange) {
      onTabChange(index);
    }
  };

  const animationId = useMemo(() => uuid(), []);
  const skipAnimations = isExtension();

  return (
    <div
      // bg-gray-50 → var(--color-surface-tertiary): #f3f3f3 in light (matches
      // the previous fixed bg-grey-50), #333333 in dark.
      className={classNames('flex rounded-full overflow-hidden p-1', 'bg-gray-50', className)}
      {...props}
    >
      <MotionConfig transition={skipAnimations ? { duration: 0 } : undefined}>
        {tabs.map((tab, index) => (
          <TabPickerItem key={tab.id} {...tab} onClick={() => handleTabChange(index)} animationId={animationId} />
        ))}
      </MotionConfig>
    </div>
  );
};
