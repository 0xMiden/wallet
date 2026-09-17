import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';

export interface BottomNavItem {
  id: string;
  label: string;
  icon: ReactNode;
  iconActive?: ReactNode;
  /** Renders a small red notification dot on the icon (e.g. unclaimed notes). */
  showDot?: boolean;
}

export interface BottomNavProps {
  items: BottomNavItem[];
  activeId: string;
  onChange: (id: string) => void;
  /** Dock the bar to the bottom edge — full width, hairline top rule, no pill
   *  rounding or shadow — instead of floating it as a pill. The bottom padding
   *  reaches 12px into the device's bottom safe-area inset (8px floor), so the
   *  bar's background runs under the home indicator and the labels hug it. */
  docked?: boolean;
  className?: string;
}

export const BottomNav: FC<BottomNavProps> = ({ items, activeId, onChange, docked = false, className }) => {
  // Re-taps on the active tab are forwarded too: the owner decides whether
  // they navigate (e.g. Home tap on /send returns to Overview) and owns the
  // haptic so no-op taps don't buzz.
  const handleSelect = (id: string) => {
    onChange(id);
  };

  return (
    <nav
      // Gutter and gap are sized so four destinations fit a 375px viewport
      // without overflowing the pill; the previous `px-13.5 gap-8` was tuned
      // for three and put min-content at ~470px once Settings joined. Purely a
      // fit constraint — the visual treatment is owned by #803.
      className={classNames(
        'flex items-center gap-2 bg-white',
        docked
          ? 'w-full justify-around px-4 pt-2 pb-[max(0.5rem,calc(env(safe-area-inset-bottom)-12px))] border-t border-border-subtle'
          : [
              'justify-center rounded-3xl px-4 py-2',
              'shadow-[0_4px_12px_rgba(0,0,0,0.08),0_12px_40px_rgba(0,0,0,0.15)]'
            ],
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
              'flex flex-col items-center justify-center gap-0.5 py-1.5 px-3',
              'transition-colors',
              isActive ? 'text-accent-primary' : 'text-text-primary-token'
            )}
          >
            <span className="relative flex items-center justify-center w-6 h-6">
              {iconNode}
              {item.showDot && (
                <span aria-hidden className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
              )}
            </span>
            <span className="text-xs leading-none font-heading font-bold">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default BottomNav;
