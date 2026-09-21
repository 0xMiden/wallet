import React from 'react';

import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
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

const cardVariants = cva('rounded-2xl bg-fill text-left', {
  variants: {
    padding: {
      none: '',
      row: 'px-4 py-3',
      tile: 'p-4'
    },
    // Split, because the two halves need different things of the child. Press feedback works on
    // anything tappable; the focus ring and the disabled states only mean something on an element
    // that can take focus, and claiming them on one that cannot advertises behaviour the card
    // cannot deliver.
    pressable: {
      true: [
        'cursor-pointer transition-colors duration-150 ease-hover',
        'hover:bg-fill-pressed active:bg-fill-pressed'
      ],
      false: ''
    },
    focusable: {
      true: [
        'select-none outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-page',
        'disabled:cursor-default disabled:opacity-50 disabled:hover:bg-fill disabled:active:bg-fill'
      ],
      false: ''
    }
  },
  defaultVariants: { padding: 'tile', pressable: false, focusable: false }
});

export interface CardProps {
  children: React.ReactNode;
  padding?: CardPadding;
  /**
   * Render the card's surface onto the single child instead of a `div`, for a child that is its
   * own element (a layout-animated row, an `article`).
   */
  asChild?: boolean;
  /**
   * Pressed feedback, for an `asChild` child that owns its own tap. A card that is itself the tap
   * target is a `CardButton`.
   */
  pressable?: boolean;
  /**
   * A focus ring and disabled states. Only for a child that can actually take focus: on one that
   * cannot, these classes are inert and advertise behaviour the card cannot deliver.
   */
  focusable?: boolean;
  /** Layout only (margins, width, flex). */
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * The design system's card (skills/miden-wallet-frontend/references/design-system.md, "Card"): a
 * `fill` surface with 16px corners and no border. Cards sit on `page` and are separated by space,
 * never outlined; hairlines only divide the rows of a group inside one surface.
 */
export const Card: React.FC<CardProps> = ({
  children,
  padding,
  asChild = false,
  pressable = false,
  focusable = false,
  className,
  'aria-label': ariaLabel,
  'data-testid': dataTestId
}) => {
  const Comp = asChild ? Slot : 'div';
  return (
    <Comp
      className={cn(cardVariants({ padding, pressable, focusable }), className)}
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
      className={cn(cardVariants({ padding, pressable: true, focusable: true }), className)}
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
