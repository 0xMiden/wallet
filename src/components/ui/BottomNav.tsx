import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';

import { hapticSelection } from 'lib/mobile/haptics';

export interface BottomNavItem {
  id: string;
  label: string;
  icon: ReactNode;
  iconActive?: ReactNode;
  /** Renders a small red notification dot on the icon (e.g. unclaimed notes). */
  showDot?: boolean;
}

export interface BottomNavProps {
  items: BottomNavItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
}

export const BottomNav: FC<BottomNavProps> = ({ items, activeId, onChange, className }) => {
  const handleSelect = (id: string) => {
    if (id === activeId) return;
    hapticSelection();
    onChange(id);
  };

  return (
    <nav
      className={classNames(
        'flex items-center gap-8 justify-center',
        'bg-white rounded-3xl px-13.5 py-2',
        'shadow-[0_1px_2px_rgba(0,0,0,0.03),0_4px_8px_rgba(0,0,0,0.04),0_10px_20px_rgba(0,0,0,0.04),0_20px_40px_rgba(0,0,0,0.04)]',
        className
      )}
    >
      {items.map(item => {
        const isActive = item.id === activeId;
        const iconNode = isActive && item.iconActive ? item.iconActive : item.icon;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            onClick={() => handleSelect(item.id)}
            className={classNames(
              'flex flex-col items-center justify-center gap-0.5 py-1.5 px-3',
              'transition-colors',
              isActive ? 'text-accent-primary' : 'text-text-primary-token'
            )}
          >
            <span className="relative flex items-center justify-center w-6 h-6">
              {iconNode}
              {item.showDot && (
                <span aria-hidden className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
              )}
            </span>
            <span className={classNames('text-xs leading-none', isActive ? 'font-bold' : 'font-semibold')}>
              {item.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
};

export default BottomNav;
