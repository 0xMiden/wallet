import React, { useEffect, useRef, useState } from 'react';

import { Clipboard } from '@capacitor/clipboard';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { hapticLight } from 'lib/mobile/haptics';

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
  'aria-label'?: string;
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

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = async () => {
    hapticLight();
    try {
      await Clipboard.write({ string: text });
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
      aria-label={ariaLabel}
      className={clsx('shrink-0 font-heading text-sm font-bold text-accent disabled:opacity-50', className)}
    >
      {typeof children === 'function' ? children(copied) : (children ?? (copied ? t('copied') : t('copy')))}
    </button>
  );
};
