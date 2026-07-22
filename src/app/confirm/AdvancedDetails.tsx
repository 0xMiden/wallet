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
        <pre className="text-xs bg-gray-50 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-words">
          {children}
        </pre>
      )}
    </div>
  );
};
