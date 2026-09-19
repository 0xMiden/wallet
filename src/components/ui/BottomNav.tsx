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
   *  rounding or shadow — instead of floating it as a pill. Its bottom padding is
   *  exactly the device's bottom inset (8px where there is none), so the bar's
   *  background runs under the home indicator and nothing else sits below the tabs. */
  docked?: boolean;
  /** Drawn over the bar's lower-right corner, taking no layout space (the test-network ribbon). It
   *  sits in a box clipped to the bar's own shape that lets taps through; whatever it renders
   *  decides which of its parts take taps (`pointer-events-auto`). */
  corner?: ReactNode;
  className?: string;
}

// The bar is 56px of content, the height of every tab, like UIKit's tab bar (49pt) plus the
// highlight's margins. Docked, only the bottom inset sits below it — the home indicator's 34px on an
// iPhone, an 8px floor where there is none — so an iPhone 17 Pro bar is 1 + 56 + 34 = 91px. The body
// pads itself by --app-safe-bottom and TabLayout sinks the footer by the same amount, so the two
// cancel and this padding is the only space counted below the tabs.
const bar = cva('relative flex items-center bg-page', {
  variants: {
    docked: {
      true: 'w-full px-4 pb-[max(8px,env(safe-area-inset-bottom))] border-t border-hairline',
      false: 'rounded-3xl px-2 shadow-[0_4px_12px_rgba(0,0,0,0.08),0_12px_40px_rgba(0,0,0,0.15)]'
    }
  }
});

// Docked, the tabs share the full width; floating, they sit side by side.
const tabRow = cva('flex items-center', {
  variants: {
    docked: {
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
 * One tab: a 60 x 56 hit area around the 56 x 48 highlight, with a 24px icon that pops when the tab
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
          'flex h-14 w-15 shrink-0 items-center justify-center rounded-full transition-colors',
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
          className="inset-x-0.5 inset-y-1 rounded-full bg-fill"
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
