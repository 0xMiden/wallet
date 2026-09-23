import React from 'react';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { motion } from 'framer-motion';

import { usePreset } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

/**
 * What the card holds, which sets its inner padding:
 * - `row` — one row: a leading 40px visual, text, a trailing value (64px tall with a 40px icon).
 * - `tile` — a stacked block of content, such as an app tile or a position summary.
 * - `none` — content that pads itself, such as sections split by hairlines.
 */
export type CardPadding = 'none' | 'row' | 'tile';

const cardVariants = cva('rounded-2xl text-left', {
  variants: {
    surface: {
      fill: 'bg-fill',
      // On `page` with a hairline edge: Activity's rows and pending transfers.
      outline: 'bg-page border border-hairline'
    },
    padding: {
      none: '',
      row: 'px-4 py-3',
      tile: 'p-4'
    },
    interactive: {
      true: [
        'cursor-pointer select-none outline-none transition-colors duration-150 ease-hover',
        'hover:bg-fill-pressed active:bg-fill-pressed',
        'focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-page',
        'disabled:cursor-default disabled:opacity-50 disabled:hover:bg-fill disabled:active:bg-fill'
      ],
      false: ''
    }
  },
  defaultVariants: { surface: 'fill', padding: 'tile', interactive: false }
});

type CardSurface = NonNullable<VariantProps<typeof cardVariants>['surface']>;

export interface CardProps {
  children: React.ReactNode;
  /** `fill` (default) or `outline`: a hairline edge on `page` instead of the fill. */
  surface?: CardSurface;
  padding?: CardPadding;
  /**
   * Render the card's surface onto the single child instead of a `div`, for a child that is its
   * own element (a layout-animated row, an `article`).
   */
  asChild?: boolean;
  /**
   * Pressed feedback and a focus ring, for an `asChild` child that owns its own tap. A card that
   * is itself the tap target is a `CardButton`.
   */
  interactive?: boolean;
  /** Layout only (margins, width, flex). */
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * The design system's card (skills/miden-wallet-frontend/references/design-system.md, "Card"): a
 * `fill` surface with 16px corners and no border, or with `surface="outline"` a hairline edge on
 * `page` (Activity's rows). Cards sit on `page` and are separated by space; otherwise hairlines only
 * divide the rows of a group inside one surface.
 */
export const Card: React.FC<CardProps> = ({
  children,
  surface,
  padding,
  asChild = false,
  interactive = false,
  className,
  'aria-label': ariaLabel,
  'data-testid': dataTestId
}) => {
  const Comp = asChild ? Slot : 'div';
  return (
    <Comp
      className={cn(cardVariants({ surface, padding, interactive }), className)}
      aria-label={ariaLabel}
      data-testid={dataTestId}
    >
      {children}
    </Comp>
  );
};

// Framer owns these names with a different signature (animation and drag events), so they can't
// be forwarded to a motion element.
type FramerConflictingHandlers = 'onAnimationStart' | 'onAnimationEnd' | 'onDrag' | 'onDragStart' | 'onDragEnd';

export interface CardButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  FramerConflictingHandlers
> {
  padding?: CardPadding;
  /** Layout only (margins, width, flex). */
  className?: string;
  'data-testid'?: string;
}

/**
 * A `Card` that is one tap target: a `button` with the tap haptic, the `press` motion, the
 * `fill-pressed` state and a focus ring.
 */
export const CardButton = React.forwardRef<HTMLButtonElement, CardButtonProps>(function CardButton(
  { padding, className, disabled, onClick, children, ...props },
  ref
) {
  const press = usePreset('press');

  return (
    <motion.button
      ref={ref}
      type="button"
      disabled={disabled}
      whileTap={disabled ? undefined : press.whileTap}
      transition={press.transition}
      className={cn(cardVariants({ padding, interactive: true }), className)}
      {...props}
      onClick={e => {
        hapticLight();
        onClick?.(e);
      }}
    >
      {children}
    </motion.button>
  );
});
