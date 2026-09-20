import React, { FC, ReactNode } from 'react';

import { motion } from 'framer-motion';

import { Highlight, HighlightItem } from 'components/ui/animate/highlight';
import { raisedBubbleClassName } from 'components/ui/animate/raised-bubble';
import { useTabBarMotion, useTabIconPop } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

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
}

interface SegmentProps {
  item: SegmentedActionBarItem;
  active: boolean;
  onSelect: (id: string) => void;
}

const Segment: FC<SegmentProps> = ({ item, active, onSelect }) => {
  const motionTokens = useTabBarMotion();
  const pop = useTabIconPop(active);

  return (
    <HighlightItem
      value={item.id}
      asChild
      as="span"
      className={cn('flex items-center justify-center', active ? 'gap-1.5 max-[359px]:gap-1' : 'gap-0')}
    >
      <motion.button
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={item.label}
        onClick={() => onSelect(item.id)}
        // One spring drives the pill AND the segment widths (Framer `layout`), so the active
        // segment growing and the pill sliding into it move as one; a CSS width transition could
        // not tween `flex-1` to a fixed width, so the segments used to snap while the pill tweened.
        layout
        transition={motionTokens.highlight}
        {...motionTokens.press}
        className={cn(
          // `group` drives the raised pill's pressed shadow; no overflow clip, or it would cut the
          // pill's shadow off at the segment's edge.
          'group flex h-12 min-w-0 items-center justify-center rounded-full',
          'text-text-primary-token transition-colors duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/30',
          active ? 'w-28 flex-none px-2.5 max-[359px]:w-24 max-[359px]:px-2' : 'flex-1 px-0'
        )}
      >
        <motion.span
          layout="position"
          data-pop={pop.phase}
          animate={pop.animate}
          transition={pop.transition}
          onAnimationComplete={pop.onAnimationComplete}
          className="relative flex h-5 w-5 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
        >
          {item.icon}
        </motion.span>
        {active && (
          <motion.span
            key={`${item.id}-label`}
            layout="position"
            className="relative whitespace-nowrap text-pill max-[359px]:text-badge"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={motionTokens.label}
          >
            {item.label}
          </motion.span>
        )}
      </motion.button>
    </HighlightItem>
  );
};

export const SegmentedActionBar: FC<SegmentedActionBarProps> = ({ items, activeId, onChange, className }) => {
  const motionTokens = useTabBarMotion();

  // A tap on another segment buzzes once, here; a swipe between pages buzzes in HomeSwipeContainer,
  // which owns that gesture. A tap on the active segment is silent and changes nothing.
  const handleSelect = (id: string) => {
    if (id === activeId) return;
    hapticSelection();
    onChange(id);
  };

  return (
    // No band of its own: the row sits on the page. The 48px segments set the height; 4px above them
    // keeps it snug under the status bar, and 8px below them (room for the raised pill's shadow) and
    // a hairline rule, like the bottom nav's top rule, divide it from the content under it.
    <div
      role="tablist"
      className={cn(
        'flex items-center gap-1 overflow-hidden border-b border-hairline bg-action-bar px-3 pt-1 pb-2',
        className
      )}
    >
      {/* The white pill slides between segments on the shared Highlight primitive; its layoutId is
          scoped to this bar, so two mounted bars never trade pills. */}
      <Highlight
        controlledItems
        value={activeId}
        click={false}
        exitDelay={0}
        transition={motionTokens.highlight}
        className={cn('inset-0', raisedBubbleClassName)}
      >
        {items.map(item => (
          <Segment key={item.id} item={item} active={item.id === activeId} onSelect={handleSelect} />
        ))}
      </Highlight>
    </div>
  );
};

export default SegmentedActionBar;
