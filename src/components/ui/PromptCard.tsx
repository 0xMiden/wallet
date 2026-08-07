import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

export type PromptCardVariant = 'default' | 'warning' | 'critical';
export type PromptCardStatus = 'idle' | 'loading' | 'success' | 'failure';

/**
 * Full-card takeover state: a big centered icon-tile + label lockup (e.g.
 * "Funding" while the faucet mints, "Funded!" when it lands) that replaces
 * the title/body/CTA row.
 */
export interface PromptCardHero {
  icon: IconName;
  label: string;
  subLabel?: string;
  tone: 'accent' | 'positive';
}

export interface PromptCardProps {
  title: string;
  body?: string;
  variant?: PromptCardVariant;
  icon?: IconName;
  hero?: PromptCardHero;
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
  icon,
  hero,
  onClick,
  actionLabel,
  onAction,
  actionDisabled = false,
  status = 'idle',
  onDismiss,
  className
}) => {
  const { t } = useTranslation();

  const handleClick = () => {
    if (!onClick) return;
    hapticLight();
    onClick();
  };

  // The whole card is the tap target, so it must behave like a button for
  // keyboard users too: Enter/Space activate it. Keys pressed on the inner
  // real buttons (dismiss X, CTA) bubble up here — ignore those so a single
  // press doesn't fire both actions.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handleClick();
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

  const ActionButton =
    actionLabel && onAction && status !== 'loading' && status !== 'success' ? (
      <button
        type="button"
        onClick={handleAction}
        disabled={actionDisabled}
        className="shrink-0 rounded-full bg-accent-primary px-3 py-1.5 text-xs font-semibold text-pure-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {actionLabel}
      </button>
    ) : null;

  const StatusIndicator =
    status === 'loading' ? (
      <span role="status" aria-label={t('promptCardLoading')} className="shrink-0 text-accent-primary">
        <Icon name={IconName.Loader} size="sm" className="animate-spin" fill="currentColor" />
      </span>
    ) : status === 'success' ? (
      <span
        role="status"
        aria-label={t('success')}
        className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-status-positive/15 text-status-positive"
      >
        <Icon name={IconName.Checkmark} size="xs" className="scale-75" fill="currentColor" />
      </span>
    ) : status === 'failure' ? (
      <span
        role="status"
        aria-label={t('failed')}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-status-negative/15 text-status-negative"
      >
        <Icon name={IconName.Close} size="xs" fill="currentColor" />
      </span>
    ) : null;

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick ? handleClick : undefined}
      onKeyDown={onClick ? handleKeyDown : undefined}
      className={classNames(
        'relative overflow-hidden w-full h-[72px] bg-surface-input rounded-10',
        'flex items-center gap-3 px-4',
        // Tappable cards press in like the app's buttons do.
        onClick && 'transition-transform active:scale-[0.98]',
        className
      )}
    >
      {!hero && icon && (
        <span
          className={classNames(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-primary/15 text-accent-primary',
            status === 'loading' && 'animate-pulse'
          )}
        >
          <Icon name={icon} size="sm" fill="currentColor" />
        </span>
      )}
      {status === 'loading' && (
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-accent-primary/15">
          <span className="prompt-progress-runner block h-full w-1/3 rounded-full bg-accent-primary" />
        </span>
      )}
      {hero ? (
        // Keyed so the lockup re-pops when the hero swaps (Funding → Funded!).
        <div key={hero.label} className="prompt-hero-pop flex flex-1 flex-col items-center justify-center gap-1">
          <div className="flex items-center gap-2.5">
            <span
              className={classNames(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-pure-white',
                hero.tone === 'positive' ? 'bg-status-positive' : 'bg-accent-primary'
              )}
            >
              <Icon
                name={hero.icon}
                size="xs"
                fill="currentColor"
                className={status === 'loading' ? 'prompt-hero-flip' : undefined}
              />
            </span>
            <span className="font-heading text-xl font-extrabold text-heading-gray">{hero.label}</span>
          </div>
          {hero.subLabel && <span className="text-xs font-normal text-text-tertiary-token">{hero.subLabel}</span>}
        </div>
      ) : (
        <div className="flex flex-col gap-1 min-w-0 flex-1 text-black">
          <div className={classNames('text-base font-bold font-heading leading-tight truncate')}>{title}</div>
          {body && <div className="text-xs font-normal line-clamp-2">{body}</div>}
        </div>
      )}
      {onDismiss && !hero ? (
        // Right rail: a plain dismiss X tucked in the box's top-right corner,
        // with the CTA/status on the body line below — same edge, no overlap.
        // Hidden during a hero takeover: an in-process card can't be dismissed.
        <div className="flex shrink-0 flex-col items-end justify-between self-stretch py-2">
          <button
            type="button"
            onClick={handleDismiss}
            aria-label={t('promptCardDismiss')}
            className="flex h-5 w-5 items-center justify-center text-text-tertiary-token"
          >
            <Icon name={IconName.Close} className="w-3.5 h-3.5" fill="currentColor" />
          </button>
          <div className="flex items-center gap-2">
            {StatusIndicator}
            {ActionButton}
          </div>
        </div>
      ) : (
        !hero && (
          <>
            {StatusIndicator}
            {ActionButton}
            <Icon name={IconName.ChevronRight} size="xs" className="dark:stroke-pure-white" />
          </>
        )
      )}
    </div>
  );
};

export default PromptCard;
