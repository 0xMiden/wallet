import React, { FC, ReactNode } from 'react';

import { cva } from 'class-variance-authority';
import { motion } from 'framer-motion';

import { Highlight, HighlightItem } from 'components/ui/animate/highlight';
import { raisedBubbleClassName } from 'components/ui/animate/raised-bubble';
import { UnreadDot } from 'components/ui/UnreadDot';
import { usePreset, useTabBarMotion, useTabIconPop } from 'lib/animation';
import { cn } from 'lib/ui/util';

export interface BottomNavItem {
  id: string;
  label: string;
  icon: ReactNode;
  iconActive?: ReactNode;
  /**
   * Marks the tab unread: the design system's `UnreadDot` on the icon's corner, and the icon
   * breathing under it. `label` is what assistive tech hears after the tab's own name, so the tab
   * is announced as unread rather than looking identical to a read one.
   */
  unread?: { label: string };
}

export interface BottomNavProps {
  items: BottomNavItem[];
  activeId: string;
  onChange: (id: string) => void;
  /** Dock the bar to the bottom edge — full width, hairline top rule, no pill
   *  rounding or shadow — instead of floating it as a pill. The bottom padding
   *  reaches the body's safe-area floor into the device's bottom inset, with an 8px
   *  floor of its own, so the bar's background runs under the home indicator. */
  docked?: boolean;
  /** Drawn over the bar's lower-right corner, taking no layout space (the test-network ribbon). It
   *  sits in a box clipped to the bar's own shape that lets taps through; whatever it renders
   *  decides which of its parts take taps (`pointer-events-auto`). */
  corner?: ReactNode;
  className?: string;
}

// The bar's own geometry, unchanged from before the design system: 80 x 56 tabs (a 72 x 48 pill
// plus 4px), 8px above them, and docked, a bottom padding that reaches the body's safe-area floor
// (--app-safe-bottom, declared in mobile.html) minus 16px, with an 8px floor of its own. On an
// iPhone 17 Pro that is 1 + 8 + 56 + 18 = 83px. Anything drawn over it (the corner ribbon) adapts to
// this, never the other way around.
const bar = cva('relative flex items-center bg-page', {
  variants: {
    docked: {
      true: 'w-full px-4 pt-2 pb-[max(0.5rem,calc(var(--app-safe-bottom,max(16px,env(safe-area-inset-bottom)))-16px))] border-t border-hairline',
      false: 'justify-center rounded-3xl px-4 py-2 shadow-[0_4px_12px_rgba(0,0,0,0.08),0_12px_40px_rgba(0,0,0,0.15)]'
    }
  }
});

// Docked, the tabs share the full width; floating, they sit side by side.
const tabRow = cva('flex items-center gap-2', {
  variants: {
    docked: {
      true: 'flex-1 justify-around',
      false: 'justify-center'
    }
  }
});

interface BottomNavTabProps {
  item: BottomNavItem;
  active: boolean;
  onSelect: (id: string) => void;
}

/**
 * One tab: an 80 x 56 hit area around the 72 x 48 highlight, with a 24px icon that pops when the tab
 * becomes active. `HighlightItem` (asChild) clones this button, adds the sliding highlight and wraps
 * the icon, so the whole tab — highlight included — dips when pressed.
 */
const BottomNavTab: FC<BottomNavTabProps> = ({ item, active, onSelect }) => {
  const motionTokens = useTabBarMotion();
  const pop = useTabIconPop(active);
  const pulse = usePreset('pulse');
  const icon = active && item.iconActive ? item.iconActive : item.icon;
  // The button's own `aria-label` wins over anything inside it, so the dot's text has to be
  // composed in here rather than left to sit in the content.
  const label = item.unread ? `${item.label}, ${item.unread.label}` : item.label;

  return (
    <HighlightItem value={item.id} asChild as="span" className="flex items-center justify-center">
      <motion.button
        type="button"
        aria-current={active ? 'page' : undefined}
        aria-label={label}
        onClick={() => onSelect(item.id)}
        {...motionTokens.press}
        transition={motionTokens.highlight}
        className={cn(
          'group flex h-14 w-20 items-center justify-center rounded-full p-1 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary/30',
          active ? 'text-accent-primary' : 'text-muted'
        )}
      >
        <motion.span
          data-pop={pop.phase}
          animate={pop.animate}
          transition={pop.transition}
          onAnimationComplete={pop.onAnimationComplete}
          className="relative flex size-6 items-center justify-center [&>svg]:size-6"
        >
          {/* The icon itself breathes while the tab is unread — the pulse Brian asked for, at a
              third of a pixel, and gone entirely under reduced motion (`presets.pulse`). It
              stops because the element stops being rendered with `unread`, not because a flag
              was flipped: nothing is left looping behind a hidden badge. */}
          <motion.span
            className="flex size-6 items-center justify-center [&>svg]:size-6"
            animate={item.unread ? pulse.animate : undefined}
            transition={item.unread ? pulse.transition : undefined}
          >
            {icon}
          </motion.span>
          <UnreadDot
            unread={Boolean(item.unread)}
            placement="badge"
            label={item.unread?.label ?? ''}
            data-testid="bottom-nav-unread"
          />
        </motion.span>
      </motion.button>
    </HighlightItem>
  );
};

export const BottomNav: FC<BottomNavProps> = ({ items, activeId, onChange, docked = false, corner, className }) => {
  const motionTokens = useTabBarMotion();

  return (
    <nav className={cn(bar({ docked }), className)}>
      <div className={tabRow({ docked })}>
        {/* One highlight shared by every tab slides to the active one. Controlled and click-free:
            the owner decides whether a tap navigates (and buzzes), and `activeId` follows. */}
        <Highlight
          controlledItems
          value={activeId}
          click={false}
          exitDelay={0}
          transition={motionTokens.highlight}
          className={cn('inset-1', raisedBubbleClassName)}
        >
          {items.map(item => (
            // Re-taps on the active tab are forwarded too: the owner decides whether they navigate
            // (e.g. Home on /send returns to Overview) and owns the haptic, so no-op taps stay silent.
            <BottomNavTab key={item.id} item={item} active={item.id === activeId} onSelect={onChange} />
          ))}
        </Highlight>
      </div>
      {/* Over the tabs, in the bar's own shape (`rounded-[inherit]` clips it to the floating pill's
          radius), and transparent to taps outside whatever the corner content opts in. */}
      {corner && (
        <div
          data-slot="bottom-nav-corner"
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
        >
          {corner}
        </div>
      )}
    </nav>
  );
};

export default BottomNav;
