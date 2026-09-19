import React, { FC, ReactNode } from 'react';

import { cva } from 'class-variance-authority';
import { motion } from 'framer-motion';

import { Highlight, HighlightItem } from 'components/ui/animate/highlight';
import { useTabBarMotion, useTabIconPop } from 'lib/animation';
import { cn } from 'lib/ui/util';

export interface BottomNavItem {
  id: string;
  label: string;
  icon: ReactNode;
  iconActive?: ReactNode;
  /** Renders a small notification dot on the icon (e.g. unclaimed notes). */
  showDot?: boolean;
}

export interface BottomNavProps {
  items: BottomNavItem[];
  activeId: string;
  onChange: (id: string) => void;
  /** Dock the bar to the bottom edge — full width, hairline top rule, no pill
   *  rounding or shadow — instead of floating it as a pill. The bottom padding
   *  reaches the body's safe-area floor (--app-safe-bottom, declared in
   *  mobile.html) into the device's bottom inset, with an 8px floor of its own,
   *  so the bar's background runs under the home indicator and the items hug it. */
  docked?: boolean;
  /** Rendered at the bar's right edge, beside the last tab and outside every tab's hit area (the
   *  test-network strip). It gets whatever width the tabs leave and must truncate to fit it. */
  accessory?: ReactNode;
  className?: string;
}

// The bar is 64px of content, the height of every tab; docked, the safe-area padding sits below it.
const bar = cva('flex items-center bg-page', {
  variants: {
    docked: {
      true: 'w-full px-1 pb-[max(0.5rem,calc(var(--app-safe-bottom,max(16px,env(safe-area-inset-bottom)))-16px))] border-t border-hairline',
      false: 'rounded-3xl px-2 shadow-[0_4px_12px_rgba(0,0,0,0.08),0_12px_40px_rgba(0,0,0,0.15)]'
    }
  }
});

// Docked, the tabs share the width the accessory leaves; floating, they sit side by side.
const tabRow = cva('flex items-center', {
  variants: {
    docked: {
      // No `min-w-0`: the row keeps its tabs' full width and the accessory shrinks instead.
      true: 'flex-1 justify-around',
      false: 'gap-2'
    }
  }
});

interface BottomNavTabProps {
  item: BottomNavItem;
  active: boolean;
  onSelect: (id: string) => void;
}

/**
 * One tab: a 60 x 64 hit area around the 56 x 48 highlight, with a 24px icon that pops when the tab
 * becomes active. `HighlightItem` (asChild) clones this button, adds the sliding highlight and wraps
 * the icon, so the whole tab — highlight included — dips when pressed.
 */
const BottomNavTab: FC<BottomNavTabProps> = ({ item, active, onSelect }) => {
  const motionTokens = useTabBarMotion();
  const pop = useTabIconPop(active);
  const icon = active && item.iconActive ? item.iconActive : item.icon;

  return (
    <HighlightItem value={item.id} asChild as="span" className="flex items-center justify-center">
      <motion.button
        type="button"
        aria-current={active ? 'page' : undefined}
        aria-label={item.label}
        onClick={() => onSelect(item.id)}
        {...motionTokens.press}
        transition={motionTokens.highlight}
        className={cn(
          'flex h-16 w-15 shrink-0 items-center justify-center rounded-full transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary/30',
          active ? 'text-ink' : 'text-muted'
        )}
      >
        <motion.span
          data-pop={pop.phase}
          animate={pop.animate}
          transition={pop.transition}
          onAnimationComplete={pop.onAnimationComplete}
          className="relative flex size-6 items-center justify-center [&>svg]:size-6"
        >
          {icon}
          {item.showDot && (
            <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-status-negative" />
          )}
        </motion.span>
      </motion.button>
    </HighlightItem>
  );
};

export const BottomNav: FC<BottomNavProps> = ({ items, activeId, onChange, docked = false, accessory, className }) => {
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
          className="inset-x-0.5 inset-y-2 rounded-full bg-fill"
        >
          {items.map(item => (
            // Re-taps on the active tab are forwarded too: the owner decides whether they navigate
            // (e.g. Home on /send returns to Overview) and owns the haptic, so no-op taps stay silent.
            <BottomNavTab key={item.id} item={item} active={item.id === activeId} onSelect={onChange} />
          ))}
        </Highlight>
      </div>
      {/* The accessory gets the row's top 48px (pt-1 above a 44px target): docked on a device with
          a home indicator, the bar's bottom padding is the inset minus 16px, so the row's bottom
          16px lies inside the indicator's gesture zone and a target there would compete with it. */}
      {/* `empty:hidden`: an accessory that renders nothing (the strip on mainnet) leaves no gap. */}
      {accessory && (
        <div className="flex min-w-0 shrink items-start self-stretch pt-1 pl-1 empty:hidden">{accessory}</div>
      )}
    </nav>
  );
};

export default BottomNav;
