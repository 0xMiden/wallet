import React from 'react';

import { cva } from 'class-variance-authority';

import { Icon, IconName } from 'app/icons/v2';
import { colorTransitionClass } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

/** `bare`: a 24px glyph alone in a 44px hit area, `ink` — the last few rows that have not moved.
 *  `circle`: a circle on `fill` with the glyph on it — 32px (or 36px) with a `muted` glyph on
 *  sheets and overlays, 44px with a 24px `ink` glyph in a page or tab-root header. `active` fills
 *  it with `accent` and turns the glyph white, the same pair the segmented selection uses. */
export type IconButtonAppearance = 'bare' | 'circle';

const iconButtonVariants = cva(
  [
    'flex shrink-0 items-center justify-center rounded-full outline-none',
    colorTransitionClass,
    'focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-page',
    'disabled:pointer-events-none disabled:opacity-50'
  ],
  {
    variants: {
      appearance: {
        // -mx-2.5 pulls the larger hit area back in so the 24px glyph stays flush with the
        // page's own edge, the way the row it sits in expects.
        bare: '-mx-2.5 h-11 w-11 text-ink',
        circle: 'bg-fill text-muted hover:bg-fill-pressed'
      },
      circleSize: {
        '32': '',
        '36': '',
        '44': ''
      },
      active: {
        true: '',
        false: ''
      }
    },
    compoundVariants: [
      { appearance: 'circle', circleSize: '32', class: 'h-8 w-8' },
      { appearance: 'circle', circleSize: '36', class: 'h-9 w-9' },
      // A page or tab-root header's button: a full 44px target with the header's `ink` glyph.
      { appearance: 'circle', circleSize: '44', class: 'h-11 w-11 text-ink' },
      // `bare`: the accent-colored selected state, for the rows still on the bare glyph.
      { appearance: 'bare', active: true, class: 'text-accent-primary' },
      // `circle`: a held toggle fills the circle instead (a tab root's open search). White on
      // `accent` is 3.0:1, which rule 6 allows for a glyph, and it matches the selected pill.
      {
        appearance: 'circle',
        active: true,
        class: 'bg-accent-primary text-pure-white hover:bg-accent-primary'
      }
    ],
    defaultVariants: { appearance: 'bare', circleSize: '32', active: false }
  }
);

export interface IconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'type' | 'aria-label'
> {
  icon: IconName;
  /** Accessible name. Required: an icon alone has no text for assistive tech to read. */
  label: string;
  appearance?: IconButtonAppearance;
  /** `circle` only. 32px by default; 36px where the surrounding row needs a larger target; 44px for a page header's back button. */
  circleSize?: '32' | '36' | '44';
  /** `bare` only: renders the accent-colored selected state and `aria-pressed`, for a toggle
   *  action (e.g. TabHeader's search icon). Omit for a plain action button — no toggle
   *  semantics, no `aria-pressed`. */
  active?: boolean;
  className?: string;
  'data-testid'?: string;
}

/**
 * The design system's icon button (`skills/miden-wallet-frontend/references/design-system.md`,
 * "Icon button"): one component for every round, icon-only control. `className` is for layout
 * (margins), not for restyling — pick `appearance`/`circleSize` instead.
 */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    label,
    appearance = 'bare',
    circleSize = '32',
    active,
    className,
    'data-testid': dataTestId,
    onClick,
    ...props
  },
  ref
) {
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    hapticLight();
    onClick?.(e);
  };

  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      data-testid={dataTestId}
      className={cn(iconButtonVariants({ appearance, circleSize, active: active ?? false }), className)}
      onClick={handleClick}
      {...props}
    >
      <Icon name={icon} size={appearance === 'circle' && circleSize !== '44' ? 'sm' : 'md'} fill="currentColor" />
    </button>
  );
});
