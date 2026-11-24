import React, { FC, ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { motion, useReducedMotion } from 'framer-motion';

import { raisedBubbleClassName } from 'components/ui/animate/raised-bubble';
import { UnreadDot } from 'components/ui/UnreadDot';
import {
  cancelSpring,
  isPrimaryPress,
  playSpring,
  tabBarMotion,
  useCompositorPress,
  useCompositorTabIconPop,
  usePreset
} from 'lib/animation';
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

/** The bubble sits this far inside its tab: 56 x 40 in a 64 x 48 tab. */
const BUBBLE_INSET_PX = 4;
/** On-screen and layout sizes differ by rounding; a smaller difference is no resize. */
const SIZE_TOLERANCE_PX = 1;

/** The bubble's press handlers, which the active tab drives: the bubble lives outside every tab. */
interface BubblePress {
  press: () => void;
  release: () => void;
}

interface BottomNavTabProps {
  item: BottomNavItem;
  active: boolean;
  onSelect: (id: string) => void;
  bubble: BubblePress;
  registerTab: (id: string, el: HTMLButtonElement | null) => void;
}

/**
 * One tab: a 64 x 48 hit area over the bubble, with a 24px icon that pops when the tab becomes
 * active. A pressed tab dips, and the bubble dips with it while the tab is the active one.
 */
const BottomNavTab: FC<BottomNavTabProps> = ({ item, active, onSelect, bubble, registerTab }) => {
  const reduceMotion = useReducedMotion();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const press = useCompositorPress(buttonRef, {
    scale: tabBarMotion.pressScale,
    transition: tabBarMotion.press,
    enabled: !reduceMotion
  });
  useCompositorTabIconPop(iconRef, active);
  const pulse = usePreset('pulse');
  const icon = active && item.iconActive ? item.iconActive : item.icon;
  // The button's own `aria-label` wins over anything inside it, so the dot's text has to be
  // composed in here rather than left to sit in the content.
  const label = item.unread ? `${item.label}, ${item.unread.label}` : item.label;

  const ref = useCallback(
    (el: HTMLButtonElement | null) => {
      buttonRef.current = el;
      registerTab(item.id, el);
    },
    [item.id, registerTab]
  );
  const handlers = useMemo(() => {
    const down = () => {
      press.onPointerDown();
      if (active) bubble.press();
    };
    // Released from every tab, not only the active one: the tab can stop being active mid-press.
    const release = (own: () => void) => () => {
      own();
      bubble.release();
    };
    const keyUp = release(press.onPointerUp);
    // Enter and Space press a button as a pointer does: framer's press gesture dipped on both keys.
    const isPressKey = (e: React.KeyboardEvent) => e.key === 'Enter' || e.key === ' ';
    return {
      onPointerDown: (e: React.PointerEvent) => {
        if (isPrimaryPress(e)) down();
      },
      onPointerUp: release(press.onPointerUp),
      onPointerCancel: release(press.onPointerCancel),
      onPointerLeave: release(press.onPointerLeave),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (isPressKey(e) && !e.repeat) down();
      },
      onKeyUp: (e: React.KeyboardEvent) => {
        if (isPressKey(e)) keyUp();
      },
      onBlur: keyUp
    };
  }, [active, bubble, press]);

  return (
    <button
      ref={ref}
      type="button"
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      onClick={() => onSelect(item.id)}
      {...handlers}
      className={cn(
        'relative flex h-12 w-16 items-center justify-center rounded-full p-1 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary/30',
        active ? 'text-accent-primary' : 'text-muted'
      )}
    >
      <span ref={iconRef} className="relative flex size-6 items-center justify-center [&>svg]:size-6">
        {/* The icon itself breathes while the tab is unread, the pulse Brian asked for, at a
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
      </span>
    </button>
  );
};

/**
 * The bubble's slide from `first` (where it was drawn) to its new place `last`: the distance to solve
 * the spring over, and the frame for a value of that distance still to go (0 at rest, below 0 past it).
 */
function slideFrame(first: DOMRect, last: { x: number; y: number; width: number; height: number }) {
  const dx = first.left + first.width / 2 - (last.x + last.width / 2);
  const dy = first.top + first.height / 2 - (last.y + last.height / 2);
  const resized =
    Math.abs(first.width - last.width) > SIZE_TOLERANCE_PX || Math.abs(first.height - last.height) > SIZE_TOLERANCE_PX;
  const sx = first.width / last.width - 1;
  const sy = first.height / last.height - 1;
  // Solved over the farthest any edge travels, so the spring settles in pixels.
  const travel = Math.max(
    Math.hypot(dx, dy),
    resized ? Math.max(Math.abs(first.width - last.width), Math.abs(first.height - last.height)) : 0
  );
  const frame = (value: number): Keyframe => {
    if (value === 0) return { transform: 'none' };
    const r = value / travel;
    const scale = resized ? ` scale(${1 + sx * r}, ${1 + sy * r})` : '';
    return { transform: `translate(${dx * r}px, ${dy * r}px)${scale}` };
  };
  return { travel, frame };
}

export const BottomNav: FC<BottomNavProps> = ({ items, activeId, onChange, className }) => {
  const reduceMotion = useReducedMotion();
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  // The slot is placed at the active tab and dips with it; the bubble inside it slides. Two
  // elements, because a dip played on the sliding element would cancel the slide.
  const slotRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  // The tab the bubble is drawn at, null while hidden: only a move from one tab to another slides.
  const shownAt = useRef<string | null>(null);
  const itemsKey = items.map(item => item.id).join('\n');

  const registerTab = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) tabs.current.set(id, el);
    else tabs.current.delete(id);
  }, []);

  const slotPress = useCompositorPress(slotRef, {
    scale: tabBarMotion.pressScale,
    transition: tabBarMotion.press,
    enabled: !reduceMotion
  });
  const bubble = useMemo(
    (): BubblePress => ({
      // The pressed shadow: `raisedBubbleClassName`'s group-active needs the bubble inside the pressed tab.
      press: () => {
        slotPress.onPointerDown();
        bubbleRef.current?.setAttribute('data-pressed', '');
      },
      release: () => {
        slotPress.onPointerUp();
        bubbleRef.current?.removeAttribute('data-pressed');
      }
    }),
    [slotPress]
  );

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const el = bubbleRef.current;
    if (!slot || !el) return;
    const tab = tabs.current.get(activeId);
    if (!tab) {
      slot.hidden = true;
      shownAt.current = null;
      cancelSpring(el);
      return;
    }

    // Read before moving, so a slide still running is caught where it is drawn.
    const slides = shownAt.current !== null && shownAt.current !== activeId && !reduceMotion;
    const first = slides ? el.getBoundingClientRect() : null;
    // `first` holds any dip the slot is drawn at; left on the slot, the dip would scale the slide twice.
    if (first) {
      cancelSpring(slot);
      slot.style.removeProperty('transform');
    }
    const width = tab.offsetWidth - 2 * BUBBLE_INSET_PX;
    const height = tab.offsetHeight - 2 * BUBBLE_INSET_PX;
    slot.hidden = false;
    slot.style.left = `${tab.offsetLeft + BUBBLE_INSET_PX}px`;
    slot.style.top = `${tab.offsetTop + BUBBLE_INSET_PX}px`;
    slot.style.width = `${width}px`;
    slot.style.height = `${height}px`;
    shownAt.current = activeId;
    if (!first) {
      cancelSpring(el);
      return;
    }

    // The tab's centre, not its box: a tab just released is still scaling back from its dip.
    const target = tab.getBoundingClientRect();
    const last = {
      x: target.left + target.width / 2 - width / 2,
      y: target.top + target.height / 2 - height / 2,
      width,
      height
    };
    const { travel, frame } = slideFrame(first, last);
    playSpring(el, tabBarMotion.highlight, travel, 0, frame, 'px');
  }, [activeId, itemsKey, reduceMotion]);

  useEffect(() => {
    const el = bubbleRef.current;
    return () => {
      if (el) cancelSpring(el);
    };
  }, []);

  return (
    <nav className={cn(BAR_CLASS_NAME, className)}>
      <div className="relative flex items-center justify-center gap-1">
        {/* One bubble for every tab, placed at the active one and sliding over when `activeId`
            changes. Click-free: the owner decides whether a tap navigates (and buzzes). */}
        <span ref={slotRef} aria-hidden className="pointer-events-none absolute">
          <span
            ref={bubbleRef}
            data-slot="motion-highlight"
            className={cn('absolute inset-0', raisedBubbleClassName, 'data-[pressed]:shadow-raised-pressed')}
          />
        </span>
        {items.map(item => (
          // Re-taps on the active tab are forwarded too: the owner decides whether they navigate
          // (e.g. Home on /send returns to Overview) and owns the haptic, so no-op taps stay silent.
          <BottomNavTab
            key={item.id}
            item={item}
            active={item.id === activeId}
            onSelect={onChange}
            bubble={bubble}
            registerTab={registerTab}
          />
        ))}
      </div>
    </nav>
  );
};

export default BottomNav;
