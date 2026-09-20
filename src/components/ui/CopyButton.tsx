import React, { useEffect, useRef, useState } from 'react';

import { Clipboard } from '@capacitor/clipboard';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { hapticLight } from 'lib/mobile/haptics';
import useIsMounted from 'lib/ui/useIsMounted';

const COPIED_FEEDBACK_MS = 1500;

export interface CopyButtonProps {
  /** The value written to the clipboard. */
  text: string;
  /**
   * Overrides the default "Copy" → "Copied" text label. A function receives the current
   * `copied` state, for a caller that swaps an icon instead of text (e.g. a copy glyph to a
   * checkmark).
   */
  children?: React.ReactNode | ((copied: boolean) => React.ReactNode);
  className?: string;
  disabled?: boolean;
  'data-testid'?: string;
  /**
   * A screen reader label, or a function of `copied` for a caller whose `children` is an icon
   * (an icon has no text for the `aria-live` region below to announce, so the state has to be
   * carried by the accessible name instead).
   */
  'aria-label'?: string | ((copied: boolean) => string);
}

/**
 * The app's copy action: an accent text button (or, via `children`, an icon) that writes `text`
 * to the clipboard and shows "Copied" feedback for a beat. Built on `@capacitor/clipboard`, which
 * has its own web implementation — the same call works on desktop, the extension and mobile
 * without a platform branch (the pattern `ContactDetailPage` used before this component existed).
 */
export const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  children,
  className,
  disabled,
  'data-testid': dataTestId,
  'aria-label': ariaLabel
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // `clearTimeout` alone is not enough: the timer is armed AFTER an awaited `Clipboard.write`, so a
  // component unmounted while that write is still in flight (a real round trip through the Capacitor
  // bridge on mobile) would have nothing to clear at unmount and would then arm a timer after
  // teardown. The liveness check is what stops the continuation running at all — via the shared hook,
  // which sets the flag in the effect BODY (a cleanup-only `useRef(true)` latches false forever after
  // StrictMode's first simulated unmount; see DeadletteredNotesNotice.tsx:54).
  const isMounted = useIsMounted();
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = async () => {
    hapticLight();
    try {
      await Clipboard.write({ string: text });
      if (!isMounted()) return;
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    } catch {
      // Nothing to report — the value stays on screen to copy by hand.
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      disabled={disabled}
      data-testid={dataTestId}
      aria-label={typeof ariaLabel === 'function' ? ariaLabel(copied) : ariaLabel}
      className={clsx('shrink-0 font-heading text-sm font-bold text-accent-tint-ink disabled:opacity-50', className)}
    >
      {/* `aria-live` so "Copied" is announced even though nothing moves focus — the tap that
          triggers it already has the user's attention, but a screen reader user tabbing past
          afterward would otherwise never learn the copy succeeded. */}
      <span aria-live="polite">
        {typeof children === 'function' ? children(copied) : (children ?? (copied ? t('copied') : t('copy')))}
      </span>
    </button>
  );
};
