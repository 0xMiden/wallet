import React, { FC, ReactNode } from 'react';

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
  className?: string;
}

// One shape on every platform: a floating capsule. The tabs are 64 x 48 (a 56 x 40 highlight plus
// 4px), 4px apart, with 4px of bar around them: 58px tall with its edge. The owner sets the position
// of the capsule and its distance from the screen edge (TabLayout).
//
// The surface is glass, in five parts:
// - the fill: white at 2% over a 6px blur of the content under the bar.
// - the edge: a 1px white border at 30%.
// - the shadow: a soft drop, a lit line inside the top edge, a faint line inside the bottom edge,
//   and a thin white glow from the edge inward. The glow stays thin (12px blur, 2px spread, 12%):
//   the bar is only 58px tall, and a larger glow fills it with white.
// - `before`: a 1px highlight along the top that fades out at the two ends.
// - `after`: a 1px highlight down the left side that fades out in the middle.
//
// Dark mode uses the same parts with much less white. At the light values the bar is a white slab
// on the dark page.
//
// The blur is written as plain values, not a Tailwind backdrop utility: Tailwind v4 composes those
// from @property variables read with an empty fallback, which an Android WebView at Chrome 113
// computes to none, and iOS before 18 reads only the -webkit- property.
const BAR_GLASS_CLASS_NAME = [
  'overflow-hidden border border-pure-white/30 bg-pure-white/2 dark:border-pure-white/10',
  '[backdrop-filter:blur(6px)] [-webkit-backdrop-filter:blur(6px)]',
  'shadow-[0_8px_32px_rgba(0,0,0,0.1),inset_0_1px_0_rgba(255,255,255,0.5),inset_0_-1px_0_rgba(255,255,255,0.1),inset_0_0_12px_2px_rgba(255,255,255,0.12)]',
  'dark:shadow-[0_8px_32px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(255,255,255,0.04),inset_0_0_12px_2px_rgba(255,255,255,0.02)]',
  "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:content-['']",
  'before:bg-linear-to-r before:from-transparent before:via-pure-white/80 before:to-transparent',
  'dark:before:via-pure-white/25',
  "after:pointer-events-none after:absolute after:top-0 after:left-0 after:h-full after:w-px after:content-['']",
  'after:bg-linear-to-b after:from-pure-white/80 after:via-transparent after:to-pure-white/30',
  'dark:after:from-pure-white/25 dark:after:to-pure-white/10'
].join(' ');

const BAR_CLASS_NAME = cn('relative flex items-center justify-center rounded-full p-1', BAR_GLASS_CLASS_NAME);

interface BottomNavTabProps {
  item: BottomNavItem;
  active: boolean;
  onSelect: (id: string) => void;
}

/**
 * One tab: a 64 x 48 hit area around the 56 x 40 highlight, with a 24px icon that pops when the tab
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
          'group flex h-12 w-16 items-center justify-center rounded-full p-1 transition-colors',
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

export const BottomNav: FC<BottomNavProps> = ({ items, activeId, onChange, className }) => {
  const motionTokens = useTabBarMotion();

  return (
    <nav className={cn(BAR_CLASS_NAME, className)}>
      <div className="flex items-center justify-center gap-1">
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
    </nav>
  );
};

export default BottomNav;
