import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

export interface AdvancedDetailsProps {
  label?: string;
  children: React.ReactNode;
}

export const AdvancedDetails: React.FC<AdvancedDetailsProps> = ({ label, children }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full mt-3">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center justify-between text-sm text-text-muted py-2"
        onClick={() => setOpen(o => !o)}
      >
        <span>{label ?? t('advancedDetails')}</span>
        <span aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="text-xs font-mono bg-gray-50 rounded-lg p-2 overflow-x-auto break-words whitespace-pre-wrap">
          {children}
        </div>
      )}
    </div>
  );
};

/** String values longer than this collapse to a truncated, click-to-expand preview. */
export const FOLD_THRESHOLD = 40;

export interface FoldableFieldProps {
  label: string;
  value: string | number;
}

/**
 * One `label: value` row for a raw-details disclosure. Short values (numbers,
 * short strings like `importNotes: 0`) render inline; long string values (e.g. a
 * base64 `requestBytes` blob) collapse to a `"preview…"` and expand on click, so
 * one huge value can't make the whole confirm dialog scroll uselessly.
 */
export const FoldableField: React.FC<FoldableFieldProps> = ({ label, value }) => {
  const [open, setOpen] = useState(false);
  const isString = typeof value === 'string';
  const str = String(value);
  const foldable = isString && str.length > FOLD_THRESHOLD;

  if (!foldable) {
    return (
      <div className="py-0.5">
        <span className="text-text-muted">{label}: </span>
        <span className="break-all">{isString ? `"${str}"` : str}</span>
      </div>
    );
  }

  return (
    <div className="py-0.5">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full text-left items-start gap-x-1"
        onClick={() => setOpen(o => !o)}
      >
        <span aria-hidden className="text-text-muted">
          {open ? '▾' : '▸'}
        </span>
        <span className="text-text-muted">{label}:</span>
        {!open && <span className="break-all">{`"${str.slice(0, FOLD_THRESHOLD)}…"`}</span>}
      </button>
      {open && <div className="pl-4 break-all">{`"${str}"`}</div>}
    </div>
  );
};
