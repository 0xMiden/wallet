import React from 'react';

import classNames from 'clsx';

import { ReactComponent as InfoIcon } from 'app/icons/information.svg';

/**
 * Grey pill used to label a review section (row label or the hero caption).
 * Background/text are token-based so they auto-flip with the theme.
 */
export const ReviewLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <span
    className={classNames(
      'inline-flex items-center rounded-full bg-surface-interactive px-2 py-1 text-sm font-bold text-gray dark:text-pure-white font-heading',
      className
    )}
  >
    {children}
  </span>
);

export interface ReviewRowProps {
  label: string;
  /** Default value text (large, bold). Ignored when `children` is provided. */
  value?: string;
  /** Inline "Edit" link rendered after the value, separated by a divider. */
  onEdit?: () => void;
  editLabel?: string;
  /** Custom value content (badges, dots, bold text…); overrides `value`. */
  children?: React.ReactNode;
  /** Optional helper line under the value, prefixed with an info icon. */
  note?: React.ReactNode;
}

/**
 * One label/value block in a review screen: a grey pill label on top, then the
 * value (large, bold, `font-heading`) below — optionally followed by an inline
 * "Edit" link and an info note. Dividers between rows are owned by the parent
 * (ReviewLayout's `dividers` prop), so this stays border-free.
 */
export const ReviewRow: React.FC<ReviewRowProps> = ({ label, value, onEdit, editLabel, children, note }) => (
  <div className="py-6">
    <ReviewLabel>{label}</ReviewLabel>

    <div className="mt-2 font-heading text-2xl font-bold text-heading-gray wrap-break-word">
      {children ?? value}
      {onEdit && (
        <>
          <span className="mx-2 text-heading-gray">|</span>
          <button type="button" onClick={onEdit} className="align-baseline text-primary-500 cursor-pointer">
            {editLabel}
          </button>
        </>
      )}
    </div>

    {note && (
      <div className="mt-2 flex items-start gap-1.5 text-xs text-heading-gray">
        <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 fill-current" />
        <span>{note}</span>
      </div>
    )}
  </div>
);
