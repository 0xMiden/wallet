import React from 'react';

import { cva } from 'class-variance-authority';

import { Icon, IconName } from 'app/icons/v2';
import { colorTransitionClass } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

/** `bare`: a 24px glyph alone in a 44px hit area, `ink` - tab-root actions.
 *  `circle`: a 32px (or 36px) circle on `fill`, `muted` small glyph - sheets and overlays.
 *  `filled`: a 44px circle on `fill` with an `ink` 24px glyph - a pushed page's back button. */
export type IconButtonAppearance = 'bare' | 'circle' | 'filled';

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
        circle: 'bg-fill text-muted hover:bg-fill-pressed',
        filled: 'h-11 w-11 bg-fill text-ink hover:bg-fill-pressed'
      },
      circleSize: {
        '32': '',
        '36': ''
      },
      active: {
        true: '',
        false: ''
      }
    },
    compoundVariants: [
      { appearance: 'circle', circleSize: '32', class: 'h-8 w-8' },
      { appearance: 'circle', circleSize: '36', class: 'h-9 w-9' },
      // `bare` only: the accent-colored selected state (e.g. TabHeader's active search action).
      { appearance: 'bare', active: true, class: 'text-accent-primary' }
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
  /** `circle` only. 32px by default; 36px where the surrounding row needs a larger target. */
  circleSize?: '32' | '36';
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
      <Icon name={icon} size={appearance === 'circle' ? 'sm' : 'md'} fill="currentColor" />
    </button>
  );
});
