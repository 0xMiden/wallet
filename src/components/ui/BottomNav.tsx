import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';

import { hapticSelection } from 'lib/mobile/haptics';

export interface BottomNavItem {
  id: string;
  label: string;
  icon: ReactNode;
  iconActive?: ReactNode;
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
        'flex items-center justify-around',
        'bg-white rounded-full px-2 py-2',
        'shadow-[0_8px_24px_rgba(0,0,0,0.08)]',
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
              'flex flex-col items-center justify-center gap-0.5 flex-1 py-1.5',
              'transition-colors',
              isActive ? 'text-accent-primary' : 'text-text-primary-token'
            )}
          >
            <span className="flex items-center justify-center w-6 h-6">{iconNode}</span>
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
