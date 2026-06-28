import React from 'react';

export interface ReviewRowProps {
  label: string;
  /** Default value text (medium weight). Ignored when `children` is provided. */
  value?: string;
  /** Inline "Edit" link rendered under the value. */
  onEdit?: () => void;
  editLabel?: string;
  /** Custom value content (badges, dots, bold text…); overrides `value`. */
  children?: React.ReactNode;
}

/**
 * One label/value line in a review screen. Dividers between rows are owned by
 * the parent (ReviewLayout's `dividers` prop), so this stays border-free.
 */
export const ReviewRow: React.FC<ReviewRowProps> = ({ label, value, onEdit, editLabel, children }) => (
  <div className="flex items-start justify-between py-4">
    <span className="text-sm text-heading-gray font-medium">{label}</span>
    <div className="flex flex-col items-end text-right">
      {children ?? <span className="text-sm text-heading-gray font-semibold">{value}</span>}
      {onEdit && (
        <button type="button" onClick={onEdit} className="text-xs text-primary-500 font-medium mt-1 cursor-pointer">
          {editLabel}
        </button>
      )}
    </div>
  </div>
);
