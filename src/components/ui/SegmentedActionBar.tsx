import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';
import { motion } from 'framer-motion';

import { easings } from 'lib/animation/easings';
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

const segmentedTransition = {
  duration: 0.24,
  ease: easings.easeInOut
};

const labelTransition = {
  duration: 0.12,
  delay: 0.1,
  ease: easings.easeInOut
};

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
    <div role="tablist" className={classNames('flex h-16 items-center gap-1 bg-gray-25 px-3 py-3', className)}>
      {items.map(item => {
        const isActive = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={item.label}
            onClick={() => handleSelect(item.id)}
            className={classNames(
              'relative flex h-12 min-w-0 items-center justify-center overflow-hidden rounded-[22px]',
              'text-text-primary-token transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/30',
              isActive ? 'shrink-0 gap-1.5 px-2.5' : 'flex-1 px-0'
            )}
          >
            {isActive && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-[22px] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                transition={segmentedTransition}
              />
            )}
            <span className="relative flex h-5 w-5 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full">
              {item.icon}
            </span>
            {isActive && (
              <motion.span
                key={`${item.id}-label`}
                className="relative whitespace-nowrap text-base font-bold leading-none"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={labelTransition}
              >
                {item.label}
              </motion.span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default SegmentedActionBar;
