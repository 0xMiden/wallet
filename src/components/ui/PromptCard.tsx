import React, { FC } from 'react';

import classNames from 'clsx';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

export type PromptCardVariant = 'default' | 'warning' | 'critical';

export interface PromptCardProps {
  title: string;
  body?: string;
  variant?: PromptCardVariant;
  onClick?: () => void;
  onDismiss?: () => void;
  className?: string;
}

const VARIANT_TITLE: Record<PromptCardVariant, string> = {
  default: 'text-text-primary-token',
  warning: 'text-status-pending',
  critical: 'text-status-negative'
};

const VARIANT_ACCENT_BORDER: Record<PromptCardVariant, string> = {
  default: '',
  warning: 'border-l-2 border-status-pending',
  critical: 'border-l-2 border-status-negative'
};

export const PromptCard: FC<PromptCardProps> = ({
  title,
  body,
  variant = 'default',
  onClick,
  onDismiss,
  className
}) => {
  const handleClick = () => {
    if (!onClick) return;
    hapticLight();
    onClick();
  };

  const handleDismiss = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onDismiss) return;
    hapticLight();
    onDismiss();
  };

  const Trail = onDismiss ? (
    <button
      type="button"
      onClick={handleDismiss}
      aria-label="Dismiss"
      className="shrink-0 flex items-center justify-center w-6 h-6 -mr-1 text-text-tertiary-token"
    >
      <Icon name={IconName.Close} className="w-4 h-4" fill="currentColor" />
    </button>
  ) : (
    <Icon name={IconName.ChevronRight} className="shrink-0 w-4 h-4" />
  );

  return (
    <div
      role={onClick ? 'button' : undefined}
      onClick={onClick ? handleClick : undefined}
      className={classNames(
        'w-full bg-gray-25 rounded-md-token',
        'flex items-center gap-3 px-4 py-4.5',
        onClick && 'cursor-pointer active:opacity-90 transition-opacity',
        VARIANT_ACCENT_BORDER[variant],
        className
      )}
    >
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <div className={classNames('text-sm font-semibold leading-tight truncate', VARIANT_TITLE[variant])}>
          {title}
        </div>
        {body && (
          <div
            className="text-sm font-normal leading-snug text-text-secondary-token"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden'
            }}
          >
            {body}
          </div>
        )}
      </div>
      {Trail}
    </div>
  );
};

export default PromptCard;
