import React from 'react';

import { cn } from 'lib/ui/util';

export interface ErrorLineProps {
  /** The message. Nothing renders when it is empty, so a caller can pass its error state directly. */
  children?: React.ReactNode;
  /**
   * `alert` (default) for something that just went wrong, `note` for a standing condition the
   * page always shows in this state — a `status` role would claim the latter had just changed.
   */
  role?: 'alert' | 'note';
  /** Layout only (margins). */
  className?: string;
  'data-testid'?: string;
}

/**
 * The one inline error under a section's content: 13px `negative-ink`, inset 4px like the section
 * label above it, selectable so the user can copy a message worth reporting, and announced by
 * `role="alert"` because nothing else on the page moves when it appears.
 *
 * Use it for a failure that belongs to the thing directly above it. A failure that needs a title
 * and its own surface is a `Notice`; a failure that belongs to one field is `TextField`'s `error`.
 */
export const ErrorLine: React.FC<ErrorLineProps> = ({
  children,
  role = 'alert',
  className,
  'data-testid': dataTestId
}) => {
  if (!children) return null;

  return (
    <p
      role={role}
      data-testid={dataTestId}
      className={cn('px-1 text-caption wrap-break-word text-negative-ink select-text', className)}
    >
      {children}
    </p>
  );
};
