import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconSize } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { useClipboardCopy } from 'lib/ui/useClipboardCopy';
import { cn } from 'lib/ui/util';

import { AnimatedCopyIcon } from './AnimatedCopyIcon';
import { CopyLabel } from './CopyLabel';

export type CopyButtonIcon = 'leading' | 'trailing' | 'only';

export interface CopyButtonProps {
  /** The value written to the clipboard. */
  text: string;
  /** The label before a copy. Defaults to "Copy". Ignored when `icon` is `'only'`. */
  label?: React.ReactNode;
  /**
   * The label rolls to this after a copy. Defaults to "Copied". `null` keeps `label` in place, for
   * a control whose glyph alone confirms the copy (the balance card's address).
   */
  copiedLabel?: React.ReactNode | null;
  /** Adds the animated copy glyph (copy mark → check) before or after the label, or alone. */
  icon?: CopyButtonIcon;
  iconSize?: IconSize;
  /** Classes for the glyph box, e.g. `text-muted`. */
  iconClassName?: string;
  /** Classes for the check alone, e.g. `text-positive-ink`. */
  checkClassName?: string;
  /** Classes for the row that holds the glyph and label: gap, font. */
  contentClassName?: string;
  className?: string;
  disabled?: boolean;
  'data-testid'?: string;
  /**
   * A screen reader label, or a function of `copied`. Needed when the visible label is a value
   * (an address) or there is none (`icon="only"`).
   */
  'aria-label'?: string | ((copied: boolean) => string);
}

/**
 * The app's copy action. Writes `text` to the clipboard and confirms it in place: the label rolls
 * to "Copied" and, with `icon`, the copy glyph morphs into a check (`AnimatedCopyIcon`,
 * `CopyLabel`, `lib/animation/copy`), both for `COPY_FEEDBACK_MS`. One light haptic per tap. A
 * failed write shows nothing: the value stays on screen to copy by hand.
 *
 * Colour comes from the caller: the default is the `accent-tint-ink` text action of a detail row,
 * and a caller's own text colour in `className` replaces it (glyph and label paint in
 * `currentColor`). Built on `@capacitor/clipboard`, which has its own web implementation, so the
 * same call works on desktop, the extension and mobile.
 */
export const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  label,
  copiedLabel,
  icon,
  iconSize = 'xs',
  iconClassName,
  checkClassName,
  contentClassName,
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

  const showLabel = icon !== 'only';
  const rollsTo = copiedLabel === undefined ? t('copied') : copiedLabel;
  // The label says "Copied" itself when it rolls; otherwise a hidden line does, so the aria-live
  // region below always carries the confirmation.
  const labelAnnounces = showLabel && rollsTo !== null;
  const glyph = icon && (
    <AnimatedCopyIcon copied={copied} size={iconSize} className={iconClassName} checkClassName={checkClassName} />
  );

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      disabled={disabled}
      data-testid={dataTestId}
      data-copied={copied ? 'true' : 'false'}
      aria-label={typeof ariaLabel === 'function' ? ariaLabel(copied) : ariaLabel}
      // `cn` (tailwind-merge), not `clsx`: a caller's own text color in `className` has to
      // REPLACE the default `text-accent-tint-ink` it conflicts with, not just coexist with it.
      className={cn('shrink-0 text-action text-accent-tint-ink disabled:opacity-50', className)}
    >
      {/* `aria-live` so "Copied" is announced even though nothing moves focus. The leaving label
          is `aria-hidden` while it rolls out, so only the new one is read. */}
      <span aria-live="polite" className={cn('flex min-w-0 items-center gap-1.5', contentClassName)}>
        {icon !== 'trailing' && glyph}
        {showLabel && (
          <CopyLabel copied={labelAnnounces && copied} copiedLabel={rollsTo}>
            {label ?? t('copy')}
          </CopyLabel>
        )}
        {icon === 'trailing' && glyph}
        {!labelAnnounces && <span className="sr-only">{copied ? t('copied') : ''}</span>}
      </span>
    </button>
  );
};
