import React, { useEffect, useRef } from 'react';

import { motion } from 'framer-motion';

import { usePreset } from 'lib/animation';
import type { UiEvidenceInput } from 'lib/telemetry/ui-producer-diagnostics';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { UserErrorId } from 'lib/telemetry/user-visible-error';
import { cn } from 'lib/ui/util';

export interface ErrorLineProps {
  /** Identifies the displayed error for reporting; null marks a display that is not an error. */
  errorId?: UserErrorId | null;
  errorDiagnostics?: UiEvidenceInput;
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
 * `role="alert"`. A message that arrives while the line is mounted opens its own height (the
 * `reveal` preset), so the content below is moved rather than jumped; one that is there on mount
 * is simply there, and one that clears is gone at once, since a cleared error must not linger.
 *
 * Use it for a failure that belongs to the thing directly above it. A failure that needs a title
 * and its own surface is a `Notice`; a failure that belongs to one field is `TextField`'s `error`.
 */
export const ErrorLine: React.FC<ErrorLineProps> = ({
  children,
  errorId,
  errorDiagnostics,
  role = 'alert',
  className,
  'data-testid': dataTestId
}) => {
  useUserVisibleError(children ? errorId : null, 'inline', undefined, errorDiagnostics);
  const reveal = usePreset('reveal');
  // Only a message that arrives after mount opens; one that is there on the first render is drawn
  // as the plain line, with no wrapper around it.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const shown = useRef(false);
  const opens = useRef(false);
  if (children && !shown.current) opens.current = mounted.current;
  shown.current = Boolean(children);
  if (!children) return null;

  const line = (
    <p
      role={role}
      data-testid={dataTestId}
      className={cn('px-1 text-caption wrap-anywhere text-negative-ink select-text', className)}
    >
      {children}
    </p>
  );
  if (!opens.current) return line;

  return (
    // The wrapper owns the height, so the caller's margins on the line open with it.
    <motion.div
      className="overflow-hidden"
      initial={reveal.initial}
      animate={reveal.animate}
      transition={reveal.transition}
    >
      {line}
    </motion.div>
  );
};
