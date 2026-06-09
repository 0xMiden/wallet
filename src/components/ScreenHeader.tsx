import React from 'react';

import { Icon, IconName } from 'app/icons/v2';

export interface ScreenHeaderProps {
  title: React.ReactNode;
  closeLabel: string;
  onClose: () => void;
  backLabel?: string;
  onBack?: () => void;
}

export const ScreenHeader: React.FC<ScreenHeaderProps> = ({ title, closeLabel, onClose, backLabel, onBack }) => (
  <div className="w-full flex justify-between items-center border-b border-border-faint py-4">
    {onBack && (
      <button
        type="button"
        onClick={onBack}
        aria-label={backLabel ?? closeLabel}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100"
      >
        <Icon name={IconName.ArrowLeft} size="sm" fill="currentColor" className="text-heading-gray" />
      </button>
    )}
    <h1 className="min-w-0 text-center text-[28px] font-bold leading-none text-heading-gray">{title}</h1>
    <button
      type="button"
      onClick={onClose}
      aria-label={closeLabel}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100"
    >
      <Icon name={IconName.Close} size="sm" fill="currentColor" className="text-black" />
    </button>
  </div>
);
