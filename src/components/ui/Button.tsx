import React from 'react';

import { cva } from 'class-variance-authority';
import { motion } from 'framer-motion';

import { IconName } from 'app/icons/v2';
import { ACCENT_CLASSES, FlowAccent } from 'components/flow/accent';
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
  /**
   * The flow this button belongs to (design-system.md, "Action colours"): a send CTA is blue, a
   * swap CTA purple, and so on down every page of that flow. Only the `primary` fill reads it —
   * the other variants sit on `fill` in every flow. Defaults to the brand orange, which is what
   * an app-level action (onboarding, settings, a global confirmation) keeps.
   */
  accent?: FlowAccent;
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
    'relative flex shrink-0 items-center justify-center gap-x-2 rounded-full px-4',
    'cursor-pointer select-none outline-none transition-colors duration-150 ease-hover',
    'focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-page',
    'disabled:cursor-default'
  ],
  {
    variants: {
      variant: {
        // The fill is applied separately, from `ACCENT_CLASSES[accent].cta`: the flow's set has to
        // REPLACE the brand's rest/hover/disabled classes wholesale, and merging them one modifier
        // at a time leaves the brand's `dark:disabled:` behind.
        [ButtonVariant.Primary]: 'text-text-on-accent',
        [ButtonVariant.Secondary]: 'bg-fill text-ink hover:bg-fill-pressed disabled:bg-fill disabled:text-muted',
        [ButtonVariant.Destructive]:
          'bg-fill text-negative-ink hover:bg-fill-pressed disabled:bg-fill disabled:text-muted',
        [ButtonVariant.Ghost]:
          'border border-hairline bg-transparent text-ink hover:bg-fill disabled:bg-transparent disabled:text-muted'
      },
      size: {
        // 48px, not 52: a pinned CTA (often with a secondary under it) was eating the page.
        //
        // The width is the row it sits in, up to `--container-cta` (370px: the 402px reference
        // screen less the 16px page margin either side), CENTRED once the cap bites. Both halves
        // are the size's job, not the caller's. The cap was here on its own before and was turned
        // off by `max-w-none` in 65 files, because uncentred it left the button hard against the
        // left of a wide row with all the slack on the right — worse than no cap, so every screen
        // defeated it and the CTA went edge to edge instead. Split by `mx-auto` that slack is the
        // same 16px the page margin gives, so the button lands on the page margin both in a
        // footer that pads itself and in one that does not.
        lg: 'h-12 w-full max-w-cta mx-auto text-cta',
        // No cap and no centring: a compact button is sized by its own label and never reaches
        // one, and it sits wherever the row it belongs to puts it.
        sm: 'h-9 text-cta-sm'
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
 * (margins, position in its row), not for restyling. Loading swaps the label for the spinner and
 * keeps the label's width, so the button never changes size.
 *
 * A `lg` button's WIDTH is the component's, not the caller's: it fills its row up to the CTA cap
 * and centres there (see the `size` variants). A caller pairs it (`flex-1` in a two-button row)
 * or nudges it (`mx-0` for the few legacy buttons that set a width of their own); passing
 * `max-w-none` to unpin the cap is what produced the edge-to-edge CTAs this contract replaces.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = ButtonVariant.Primary,
    accent = 'brand',
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
      className={cn(
        buttonVariants({ variant, size }),
        variant === ButtonVariant.Primary && ACCENT_CLASSES[accent].cta,
        isLoading && 'pointer-events-none',
        className
      )}
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
          {/* The label stays laid out but transparent, so the button holds its width and keeps
              its accessible name (`invisible` would drop it from the accessibility tree). */}
          <span className="flex items-center justify-center gap-x-2 opacity-0">{content}</span>
          <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
            <Loader color="currentColor" />
          </span>
        </>
      ) : (
        content
      )}
    </motion.button>
  );
});
