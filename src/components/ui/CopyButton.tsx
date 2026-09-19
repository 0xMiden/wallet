import React from 'react';

import { useTranslation } from 'react-i18next';

import { hapticLight } from 'lib/mobile/haptics';
import { useClipboardCopy } from 'lib/ui/useClipboardCopy';
import { cn } from 'lib/ui/util';

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
  const { copied, copy } = useClipboardCopy(text);

  const handleCopy = async () => {
    hapticLight();
    await copy();
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      disabled={disabled}
      data-testid={dataTestId}
      aria-label={typeof ariaLabel === 'function' ? ariaLabel(copied) : ariaLabel}
      // `cn` (tailwind-merge), not `clsx`: a caller's own text color in `className` has to
      // REPLACE the default `text-accent-tint-ink` it conflicts with, not just coexist with it —
      // plain `clsx` leaves both classes in the string, with the winner decided by Tailwind's
      // compiled order rather than the caller's intent (the same class of bug `Pill` had for
      // border color).
      className={cn('shrink-0 text-action text-accent-tint-ink disabled:opacity-50', className)}
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
