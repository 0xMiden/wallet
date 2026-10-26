import React, { useId, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { cn } from 'lib/ui/util';

import { TextAction } from './TextAction';

export interface ErrorDetailsProps {
  /** The raw error. Nothing renders when it is empty, so a caller passes what it has. */
  details?: string;
  /** Layout only (width, alignment, margins). */
  className?: string;
  'data-testid'?: string;
}

/**
 * The raw error behind a friendly failure message: a "Show full error" text action that reveals it
 * in muted caption text, selectable so it can go into a bug report.
 *
 * `wrap-anywhere`, not `wrap-break-word`: a raw error carries long unbreakable tokens (ids, URLs),
 * and only `anywhere` lowers the min-content width a fit-content box (a centred flex column) sizes
 * to, so the text wraps instead of widening its box past the screen.
 */
export const ErrorDetails: React.FC<ErrorDetailsProps> = ({ details, className, 'data-testid': dataTestId }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailsId = useId();

  if (!details) return null;

  return (
    <div data-testid={dataTestId} className={cn('flex flex-col items-start gap-2', className)}>
      <TextAction
        className="-mx-1"
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        onClick={() => setOpen(v => !v)}
      >
        {open ? t('hideFullError') : t('showFullError')}
      </TextAction>
      {open && (
        <p id={detailsId} className="w-full text-caption text-muted wrap-anywhere select-text">
          {details}
        </p>
      )}
    </div>
  );
};
