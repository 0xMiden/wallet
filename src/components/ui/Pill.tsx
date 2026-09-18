import React from 'react';

import clsx from 'clsx';

import { ACCENT_CLASSES, FlowAccent } from 'components/flow/accent';
import { hapticLight } from 'lib/mobile/haptics';

/** Height and type scale. `sm` labels and badges; `md` chips and tappable actions. */
export type PillSize = 'sm' | 'md';

/**
 * What the pill says about its content:
 * - `neutral` — the default quiet chip.
 * - `selected` — chosen, in the flow's accent.
 * - `accent` — a solid accent fill for a standing badge.
 * - `positive` / `warning` / `negative` — status.
 */
export type PillTone = 'neutral' | 'selected' | 'accent' | 'positive' | 'warning' | 'negative';

export interface PillProps {
  children: React.ReactNode;
  /** Leading glyph, sized by the pill. */
  icon?: React.ReactNode;
  size?: PillSize;
  tone?: PillTone;
  /** The flow accent used by the `selected` and `accent` tones. */
  accent?: FlowAccent;
  /** Makes the pill a button, with the tap haptic. */
  onClick?: () => void;
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

/** The leading glyph's box, so every icon in a pill is the same size. */
const ICON_CLASSES: Record<PillSize, string> = {
  sm: '-ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center',
  md: '-ml-1 flex h-4 w-4 shrink-0 items-center justify-center'
};

const STATUS_CLASSES: Record<'positive' | 'warning' | 'negative', string> = {
  positive: 'border-transparent bg-status-positive/15 text-status-positive',
  warning: 'border-transparent bg-status-pending/15 text-status-pending',
  negative: 'border-transparent bg-status-negative/15 text-status-negative'
};

/**
 * The app's pill: one height, padding and type scale for every chip, badge, label and small
 * action. Every tone carries a 1px border, so a selected pill is exactly the size of an
 * unselected one and nothing shifts when it is picked.
 */
export const Pill: React.FC<PillProps> = ({
  children,
  icon,
  size = 'md',
  tone = 'neutral',
  accent = 'brand',
  onClick,
  selected,
  disabled,
  className,
  'aria-label': ariaLabel,
  'data-testid': dataTestId
}) => {
  const toneClasses =
    tone === 'selected'
      ? clsx(ACCENT_CLASSES[accent].border, ACCENT_CLASSES[accent].tint, 'text-heading-gray')
      : tone === 'accent'
        ? clsx('border-transparent text-pure-white', ACCENT_CLASSES[accent].bg)
        : tone === 'neutral'
          ? 'border-transparent bg-surface-interactive text-heading-gray'
          : STATUS_CLASSES[tone];

  const classes = clsx(
    'inline-flex max-w-full items-center rounded-full border font-heading font-bold leading-none',
    SIZE_CLASSES[size],
    toneClasses,
    onClick && !disabled && 'cursor-pointer',
    disabled && 'opacity-50',
    className
  );

  const content = (
    <>
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
        hapticLight();
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
