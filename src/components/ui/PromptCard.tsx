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

export const PromptCard: FC<PromptCardProps> = ({ title, body, onClick, onDismiss, className }) => {
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
    <Icon name={IconName.ChevronRight} size="xs" className="dark:stroke-pure-white" />
  );

  return (
    <div
      role={onClick ? 'button' : undefined}
      onClick={onClick ? handleClick : undefined}
      className={classNames('w-full bg-surface-input rounded-10', 'flex items-center gap-3 px-4 py-3', className)}
    >
      <div className="flex flex-col gap-1 min-w-0 flex-1 text-black">
        <div className={classNames('text-base font-bold font-heading leading-tight truncate')}>{title}</div>
        {body && <div className="text-xs font-normal">{body}</div>}
      </div>
      {Trail}
    </div>
  );
};

export default PromptCard;
