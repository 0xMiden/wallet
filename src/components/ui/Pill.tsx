import React from 'react';

import { cva } from 'class-variance-authority';

import { hapticLight, hapticSelection } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

/**
 * Height and type scale. `xs` (20px) is the compact status badge in dense rows; `sm` (24px) is the
 * status pill in detail headers; `md` (32px) is every other chip, badge and action.
 */
export type PillSize = 'xs' | 'sm' | 'md';

/**
 * What the pill says about its content:
 * - `neutral` — the default quiet chip, `fill` with `ink`.
 * - `selected` — chosen, `accent-tint` with `accent-tint-ink`.
 * - `word` — a seed word: same quiet fill as `neutral`, named for where it's used.
 * - `positive` / `warning` / `negative` — status, on an opaque tint with its ink.
 * - `inactive`: a status that is neither good nor bad (cancelled, reclaimed, unavailable),
 *   `fill-pressed` with `ink`, so it still shows on a `fill` card.
 * - `plain` — no colors, for a caller that brings its own (e.g. a network's chip).
 *
 * A status is usually rendered through `StatusBadge`, which picks the tone and label for you.
 */
export type PillTone = 'neutral' | 'selected' | 'word' | 'positive' | 'warning' | 'negative' | 'inactive' | 'plain';

export interface PillProps {
  children: React.ReactNode;
  /** Leading glyph, sized by the pill. */
  icon?: React.ReactNode;
  size?: PillSize;
  tone?: PillTone;
  /** Makes the pill a button, with a tap haptic. */
  onClick?: () => void;
  /**
   * Which haptic the tap fires: `'light'` (default) for an ordinary action, `'selection'` for a
   * segmented choice — fired only when the tap actually changes the selection (skipped while
   * `selected` is already true, so re-tapping the active choice in a group is silent) — or
   * `false` to fire none and let the caller manage it.
   */
  haptic?: 'light' | 'selection' | false;
  /** Reflected as `aria-pressed` on a tappable pill. */
  selected?: boolean;
  disabled?: boolean;
  className?: string;
  /**
   * The pill's content changes while it is on screen (a live status), so it becomes a polite live
   * region: `role="status"` plus an explicit `aria-live`, for readers that ignore the implicit one.
   */
  live?: boolean;
  'aria-label'?: string;
  'data-testid'?: string;
}

// Literal class strings, so Tailwind generates them.
const pillVariants = cva(
  'relative inline-flex max-w-full items-center rounded-full border font-heading font-bold leading-none',
  {
    variants: {
      size: {
        // Semibold: at 20px the bold face reads heavier than the row title beside it.
        xs: 'h-5 gap-1 px-2 text-xs font-semibold',
        sm: 'h-6 gap-1 px-2 text-xs',
        md: 'h-8 gap-1.5 px-3 text-sm'
      } satisfies Record<PillSize, string>,
      tone: {
        neutral: 'border-transparent bg-fill text-ink',
        word: 'border-transparent bg-fill text-ink',
        selected: 'border-transparent bg-accent-tint text-accent-tint-ink',
        // Opaque tints from the activity icon family (sage, sand, clay), each with its own ink: a
        // translucent wash took the surface's color with it and fell under 4.5:1 on `fill`. On
        // their own tint the inks measure 5.41 / 5.33 / 5.17 light and 7.36 / 6.91 / 6.55 dark,
        // on any surface (`lib/ui/design-tokens.test.ts`).
        positive: 'border-transparent bg-positive-tint text-positive-tint-ink',
        warning: 'border-transparent bg-pending-tint text-pending-tint-ink',
        negative: 'border-transparent bg-negative-tint text-negative-tint-ink',
        inactive: 'border-transparent bg-fill-pressed text-ink',
        plain: 'border-transparent'
      } satisfies Record<PillTone, string>
    },
    defaultVariants: { size: 'md', tone: 'neutral' }
  }
);

/**
 * The leading glyph's box, so every icon in a pill is the same size.
 *
 * The child is sized too: the build strips `width`/`height` off the raw `.svg` icons, so one
 * passed straight in renders 0x0 unless something gives it a size (the `Icon` component brings
 * its own, a bare SVG does not).
 */
const pillIconVariants = cva('flex shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full', {
  variants: {
    size: {
      xs: '-ml-0.5 h-3 w-3',
      sm: '-ml-0.5 h-3.5 w-3.5',
      md: '-ml-1 h-4 w-4'
    } satisfies Record<PillSize, string>
  },
  defaultVariants: { size: 'md' }
});

/**
 * The app's pill: one height, padding and type scale for every chip, badge, label and small
 * action. Every tone reserves the same 1px border box (`border-transparent` unless the tone or
 * the caller gives it a color), so a selected pill is exactly the size of an unselected one and
 * nothing shifts when it is picked. Always positioned (`relative`), so a caller that overlays an
 * absolutely-positioned sibling behind it (e.g. a shared selection indicator) paints under the
 * pill's own content instead of over it — plain in-flow siblings ignore this.
 */
export const Pill: React.FC<PillProps> = ({
  children,
  icon,
  size = 'md',
  tone = 'neutral',
  onClick,
  haptic = 'light',
  selected,
  disabled,
  className,
  live,
  'aria-label': ariaLabel,
  'data-testid': dataTestId
}) => {
  // `cn` (tailwind-merge), not `clsx`: a caller's own border/background/text utility in
  // `className` has to REPLACE the tone default it conflicts with, not just coexist with it —
  // plain `clsx` leaves both classes in the string, and Tailwind v4's compiled order (alphabetical
  // by utility name) can then pick the tone default over the caller's class regardless of
  // argument order, e.g. `border-network-miden-border` losing to `border-transparent`.
  const classes = cn(
    pillVariants({ size, tone }),
    onClick && !disabled && 'cursor-pointer',
    disabled && 'opacity-50',
    className
  );

  const content = (
    <>
      {icon && <span className={pillIconVariants({ size })}>{icon}</span>}
      <span className="min-w-0 truncate">{children}</span>
    </>
  );

  if (!onClick) {
    return (
      <span
        className={classes}
        role={live ? 'status' : undefined}
        aria-live={live ? 'polite' : undefined}
        aria-label={ariaLabel}
        data-testid={dataTestId}
      >
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (haptic === 'light') {
          hapticLight();
        } else if (haptic === 'selection' && !selected) {
          hapticSelection();
        }
        onClick();
      }}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={ariaLabel}
      data-testid={dataTestId}
      className={classes}
    >
      {content}
    </button>
  );
};
