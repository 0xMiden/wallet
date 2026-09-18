import React from 'react';

import { cva } from 'class-variance-authority';
import { motion } from 'framer-motion';

import { IconName } from 'app/icons/v2';
import { Loader } from 'components/Loader';
import { usePreset } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';
import { IconOrComponent } from 'utils/icon-or-component';

export enum ButtonVariant {
  /** The one main action on a screen: accent fill, white label. */
  Primary = 'primary',
  /** Every other action: `fill`, `ink` label. */
  Secondary = 'secondary',
  /** A destructive action: `fill`, `negative-ink` label. */
  Destructive = 'destructive',
  /** A quiet outlined action, for the few places a filled secondary is too heavy. */
  Ghost = 'ghost'
}

/** `lg` is the 52px CTA; `sm` the 36px compact button. */
export type ButtonSize = 'lg' | 'sm';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  title?: string;
  iconLeft?: React.ReactNode | IconName;
  iconRight?: React.ReactNode | IconName;
  isLoading?: boolean;
  /** Optional E2E hook, forwarded to the root <button>. Set by specific callers. */
  'data-testid'?: string;
}

const buttonVariants = cva(
  [
    'relative flex shrink-0 items-center justify-center gap-x-2 rounded-full px-4 font-heading font-extrabold',
    'cursor-pointer select-none outline-none transition-colors duration-150 ease-hover',
    'focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-page',
    'disabled:cursor-default'
  ],
  {
    variants: {
      variant: {
        [ButtonVariant.Primary]:
          'bg-accent-primary text-text-on-accent hover:bg-accent-primary-hover disabled:bg-primary-disabled dark:disabled:bg-primary-disabled-dark',
        [ButtonVariant.Secondary]: 'bg-fill text-ink hover:bg-fill-pressed disabled:bg-fill disabled:text-muted',
        [ButtonVariant.Destructive]:
          'bg-fill text-negative-ink hover:bg-fill-pressed disabled:bg-fill disabled:text-muted',
        [ButtonVariant.Ghost]:
          'border border-hairline bg-transparent text-ink hover:bg-fill disabled:bg-transparent disabled:text-muted'
      },
      size: {
        lg: 'h-13 w-full max-w-92.5 text-[19px] leading-6',
        sm: 'h-9 text-[15px] leading-5'
      }
    },
    defaultVariants: {
      variant: ButtonVariant.Primary,
      size: 'lg'
    }
  }
);

/**
 * The design system's primary action (skills/miden-wallet-frontend/references/design-system.md,
 * "Primary action"): a pill in one of four variants and two sizes. `className` is for layout
 * (margins, width), not for restyling. Loading swaps the label for the spinner and keeps the
 * label's width, so the button never changes size.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = ButtonVariant.Primary,
    size = 'lg',
    title = 'Button Title',
    iconRight,
    iconLeft,
    disabled,
    className,
    isLoading,
    children,
    ...props
  },
  ref
) {
  const press = usePreset('press');

  const content = children ?? (
    <>
      {iconLeft && (
        <span className="w-6">
          <IconOrComponent icon={iconLeft} color="currentColor" />
        </span>
      )}
      <span>{title}</span>
      {iconRight && (
        <span className="w-6">
          <IconOrComponent icon={iconRight} color="currentColor" />
        </span>
      )}
    </>
  );

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur();
    hapticLight();
    props.onClick?.(e);
  };
  // These DOM handlers share a name with framer's own (animation and drag events) and have a
  // different signature, so they can't be forwarded to a motion element. No caller passes them.
  const {
    onAnimationStart: _onAnimationStart,
    onAnimationEnd: _onAnimationEnd,
    onDrag: _onDrag,
    onDragStart: _onDragStart,
    onDragEnd: _onDragEnd,
    ...motionButtonProps
  } = props;

  return (
    <motion.button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), isLoading && 'pointer-events-none', className)}
      disabled={disabled}
      type="button"
      aria-busy={isLoading || undefined}
      whileTap={!disabled && !isLoading ? press.whileTap : undefined}
      transition={press.transition}
      {...motionButtonProps}
      onClick={onClick}
    >
      {isLoading ? (
        <>
          {/* The label stays laid out, invisibly, so the button holds its width. */}
          <span aria-hidden="true" className="invisible flex items-center justify-center gap-x-2">
            {content}
          </span>
          <span className="absolute inset-0 flex items-center justify-center">
            <Loader color="currentColor" />
          </span>
        </>
      ) : (
        content
      )}
    </motion.button>
  );
});
