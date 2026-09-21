import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';
import { motion } from 'framer-motion';

import { springs, useMotion } from 'lib/animation';
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
  // One spring drives the pill AND the segment widths (Framer `layout`), so
  // the active segment growing and the pill sliding into it move as one; a
  // CSS width transition could not tween `flex-1` to a fixed width, so the
  // segments used to snap while the pill tweened — the lag people felt.
  const barTransition = useMotion(springs.pill);
  const handleSelect = (id: string) => {
    if (id === activeId) return;
    hapticSelection();
    onChange(id);
  };

  return (
    <div role="tablist" className={classNames('flex h-16 items-center gap-1 overflow-hidden bg-fill px-3', className)}>
      {items.map(item => {
        const isActive = item.id === activeId;
        return (
          <motion.button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={item.label}
            onClick={() => handleSelect(item.id)}
            layout
            transition={barTransition}
            // Framer can only undo the corner distortion of a layout projection for a radius it can
            // read from `style` or a motion value; one that exists only in a CSS class is invisible
            // to the scale corrector. This button's width really does change between states, so its
            // `overflow-hidden` clip is what visibly squashes. `9999px` rather than a literal half
            // the height, so the value is not silently coupled to `h-12`.
            style={{ borderRadius: '9999px' }}
            className={classNames(
              'relative flex h-12 min-w-0 items-center justify-center overflow-hidden rounded-full',
              'text-text-primary-token transition-colors duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/30',
              isActive
                ? 'w-28 flex-none gap-1.5 px-2.5 max-[359px]:w-24 max-[359px]:gap-1 max-[359px]:px-2'
                : 'flex-1 px-0'
            )}
          >
            {isActive && (
              <motion.span
                layoutId={layoutId}
                // Defensive, not load-bearing: this pill renders only on the active segment, which
                // is always `w-28`, so its box is identical at both ends of a move and its net
                // scale is ~1. The shadow is deliberately left as a class for the same reason.
                style={{ borderRadius: '9999px' }}
                className="absolute inset-0 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                transition={barTransition}
              />
            )}
            <motion.span
              layout="position"
              transition={barTransition}
              className="relative flex h-5 w-5 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
            >
              {item.icon}
            </motion.span>
            {isActive && (
              <motion.span
                key={`${item.id}-label`}
                layout="position"
                className="relative whitespace-nowrap font-heading text-sm font-bold leading-none max-[359px]:text-xs"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={labelTransition}
              >
                {item.label}
              </motion.span>
            )}
          </motion.button>
        );
      })}
    </div>
  );
};

export default SegmentedActionBar;
