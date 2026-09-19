import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { useClipboardCopy } from 'lib/ui/useClipboardCopy';

import { Pill, PillSize } from './Pill';

export interface CopyChipProps {
  /** The value written to the clipboard. */
  text: string;
  /** The trimmed content shown inside the chip (an address or hash short-view). */
  children: React.ReactNode;
  size?: PillSize;
  className?: string;
  'data-testid'?: string;
  /**
   * A screen reader label; the copy glyph itself has no text of its own. A function receives the
   * current `copied` state, for a caller that wants a distinct "Copied" announcement.
   */
  'aria-label'?: string | ((copied: boolean) => string);
}

/**
 * A Pill that copies `text` to the clipboard on tap: the hash/address chip variant of `Copy`
 * (`CopyButton` is the orange text-action variant for a detail row). Built on the same
 * `useClipboardCopy` hook as `CopyButton`, so both read from one clipboard/feedback
 * implementation. `Pill`'s own tap handler fires the haptic, so this hook is never asked to fire
 * one itself.
 */
export const CopyChip: React.FC<CopyChipProps> = ({
  text,
  children,
  size = 'sm',
  className,
  'data-testid': dataTestId,
  'aria-label': ariaLabel
}) => {
  const { t } = useTranslation();
  const { copied, copy } = useClipboardCopy(text);

  return (
    <>
      <Pill
        size={size}
        tone="neutral"
        icon={<Icon name={copied ? IconName.Checkmark : IconName.CopyNew} />}
        onClick={() => void copy()}
        className={className}
        aria-label={typeof ariaLabel === 'function' ? ariaLabel(copied) : ariaLabel}
        data-testid={dataTestId}
      >
        {/* `aria-live` so "Copied" is announced even though nothing moves focus, mirroring
            `CopyButton` — the icon swap alone says nothing to a screen reader. */}
        <span aria-live="polite" className="sr-only">
          {copied ? t('copied') : ''}
        </span>
        {children}
      </Pill>
      {/* A sibling, not nested inside the Pill's own `<button>` — an `<input>` isn't valid
          interactive content inside a button. Carries the untrimmed value for the wallet's E2E
          suite (`playwright/e2e/helpers/history.ts`'s `readDetailRowFullValue`, which reaches it
          via the surrounding `DetailRow`'s testid); this is the one thing the frozen
          `app/atoms/CopyButton` this replaces did that plain `Clipboard.write` doesn't reproduce
          on its own (no hidden DOM copy source is needed for the real copy anymore). */}
      <input readOnly value={text} tabIndex={-1} aria-hidden="true" className="sr-only" />
    </>
  );
};
