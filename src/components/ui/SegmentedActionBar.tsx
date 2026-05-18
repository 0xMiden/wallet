import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';
import { motion } from 'framer-motion';

import { springs } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';

export interface SegmentedActionBarItem {
  id: string;
  label: string;
  icon: ReactNode;
}

export interface SegmentedActionBarProps {
  items: SegmentedActionBarItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
  /** Shared layoutId namespace. Override if multiple bars mount simultaneously. */
  layoutId?: string;
}

export const SegmentedActionBar: FC<SegmentedActionBarProps> = ({
  items,
  activeId,
  onChange,
  className,
  layoutId = 'segmented-action-pill'
}) => {
  const handleSelect = (id: string) => {
    if (id === activeId) return;
    hapticSelection();
    onChange(id);
  };

  return (
    <div
      role="tablist"
      className={classNames(
        'flex items-center justify-evenly gap-1 px-3 py-2 mt-5 bg-gray-25 rounded-md-token',
        className
      )}
    >
      {items.map(item => {
        const isActive = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => handleSelect(item.id)}
            className={classNames(
              'relative flex items-center justify-center gap-1.5 h-12 rounded-10 px-6',
              'text-text-primary-token'
            )}
          >
            {isActive && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-10 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                transition={springs.pill}
              />
            )}
            <span className="relative flex items-center justify-center w-5 h-5">{item.icon}</span>
            {isActive && <span className="relative text-base font-semibold leading-none">{item.label}</span>}
          </button>
        );
      })}
    </div>
  );
};

export default SegmentedActionBar;
