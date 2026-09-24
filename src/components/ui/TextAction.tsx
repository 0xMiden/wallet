import React from 'react';

import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

export interface TextActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Layout only (alignment, margins). */
  className?: string;
  'data-testid'?: string;
}

/**
 * A text action (design-system.md, "accent-tint-ink"): "Learn more", "Use a custom URL", "Forgot
 * passcode". 15px Nunito bold in `accent-tint-ink`, never underlined and never the brand orange,
 * which is too light for text. A 44px hit area around the label, with the tap haptic.
 */
export const TextAction = React.forwardRef<HTMLButtonElement, TextActionProps>(function TextAction(
  { className, onClick, children, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      {...props}
      onClick={event => {
        hapticLight();
        onClick?.(event);
      }}
      className={cn(
        'inline-flex min-h-11 items-center rounded-full px-1 text-action text-accent-tint-ink',
        'outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-50',
        className
      )}
    >
      {children}
    </button>
  );
});

export default TextAction;
