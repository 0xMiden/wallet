import React, { FC } from 'react';

import classNames from 'clsx';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

export type PromptCardVariant = 'default' | 'warning' | 'critical';
export type PromptCardStatus = 'idle' | 'loading' | 'success' | 'failure';

export interface PromptCardProps {
  title: string;
  body?: string;
  variant?: PromptCardVariant;
  onClick?: () => void;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  status?: PromptCardStatus;
  onDismiss?: () => void;
  className?: string;
}

export const PromptCard: FC<PromptCardProps> = ({
  title,
  body,
  onClick,
  actionLabel,
  onAction,
  actionDisabled = false,
  status = 'idle',
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

  const handleAction = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onAction || actionDisabled || status === 'loading' || status === 'success') return;
    hapticLight();
    onAction();
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

  const StatusIndicator =
    status === 'loading' ? (
      <span role="status" aria-label="Loading" className="shrink-0 text-accent-primary">
        <Icon name={IconName.Loader} size="sm" className="animate-spin" fill="currentColor" />
      </span>
    ) : status === 'success' ? (
      <span
        role="status"
        aria-label="Success"
        className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-status-positive/15 text-status-positive"
      >
        <Icon name={IconName.Checkmark} size="xs" className="scale-75" fill="currentColor" />
      </span>
    ) : status === 'failure' ? (
      <span
        role="status"
        aria-label="Failed"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-status-negative/15 text-status-negative"
      >
        <Icon name={IconName.Close} size="xs" fill="currentColor" />
      </span>
    ) : null;

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
      {StatusIndicator}
      {actionLabel && onAction && status !== 'loading' && status !== 'success' && (
        <button
          type="button"
          onClick={handleAction}
          disabled={actionDisabled}
          className="shrink-0 text-xs font-semibold text-accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {actionLabel}
        </button>
      )}
      {Trail}
    </div>
  );
};

export default PromptCard;
