import React from 'react';

import clsx from 'clsx';

import { hapticLight, hapticSelection } from 'lib/mobile/haptics';

/** Height and type scale. `sm` is the 24px status pill; `md` (32px) is every other chip, badge and action. */
export type PillSize = 'sm' | 'md';

/**
 * What the pill says about its content:
 * - `neutral` — the default quiet chip, `fill` with `ink`.
 * - `selected` — chosen, `accent-tint` with `accent-tint-ink`.
 * - `word` — a seed word: same quiet fill as `neutral`, named for where it's used.
 * - `positive` / `warning` / `negative` — status, meant for `size="sm"` with `dot`.
 * - `plain` — no colors, for a caller that brings its own (e.g. a network's chip).
 */
export type PillTone = 'neutral' | 'selected' | 'word' | 'positive' | 'warning' | 'negative' | 'plain';

export interface PillProps {
  children: React.ReactNode;
  /** Leading glyph, sized by the pill. Mutually exclusive with `dot` in practice. */
  icon?: React.ReactNode;
  size?: PillSize;
  tone?: PillTone;
  /** A small leading status dot in the pill's own ink color (`currentColor`). */
  dot?: boolean;
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
  'aria-label'?: string;
  'data-testid'?: string;
}

// Literal class strings, so Tailwind generates them.
const SIZE_CLASSES: Record<PillSize, string> = {
  sm: 'h-6 gap-1 px-2 text-xs',
  md: 'h-8 gap-1.5 px-3 text-sm'
};

/**
 * The leading glyph's box, so every icon in a pill is the same size.
 *
 * The child is sized too: the build strips `width`/`height` off the raw `.svg` icons, so one
 * passed straight in renders 0x0 unless something gives it a size (the `Icon` component brings
 * its own, a bare SVG does not).
 */
const ICON_CLASSES: Record<PillSize, string> = {
  sm: '-ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full',
  md: '-ml-1 flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full'
};

const TONE_CLASSES: Record<Exclude<PillTone, 'plain'>, string> = {
  neutral: 'border-transparent bg-fill text-ink',
  word: 'border-transparent bg-fill text-ink',
  selected: 'border-transparent bg-accent-tint text-accent-tint-ink',
  // 10%, not 15%: at 15% the ink dropped under 4.5:1 on `page` in light mode (measured
  // 4.39/4.52/4.69 for negative/pending/positive) — 10% clears AA on both `page` and `fill`
  // (4.65/4.79/4.85 measured on `page`) in both themes.
  positive: 'border-transparent bg-status-positive/10 text-positive-ink',
  warning: 'border-transparent bg-status-pending/10 text-pending-ink',
  negative: 'border-transparent bg-status-negative/10 text-negative-ink'
};

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
  dot,
  onClick,
  haptic = 'light',
  selected,
  disabled,
  className,
  'aria-label': ariaLabel,
  'data-testid': dataTestId
}) => {
  const toneClasses = tone === 'plain' ? 'border-transparent' : TONE_CLASSES[tone];

  const classes = clsx(
    'relative inline-flex max-w-full items-center rounded-full border font-heading font-bold leading-none',
    SIZE_CLASSES[size],
    toneClasses,
    onClick && !disabled && 'cursor-pointer',
    disabled && 'opacity-50',
    className
  );

  const content = (
    <>
      {dot && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />}
      {icon && <span className={ICON_CLASSES[size]}>{icon}</span>}
      <span className="min-w-0 truncate">{children}</span>
    </>
  );

  if (!onClick) {
    return (
      <span className={classes} aria-label={ariaLabel} data-testid={dataTestId}>
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
