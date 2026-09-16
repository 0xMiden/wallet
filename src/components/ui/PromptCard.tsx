import React, { FC, useLayoutEffect, useRef } from 'react';

import classNames from 'clsx';
import { motion, useReducedMotion } from 'framer-motion';
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
  /**
   * Optional E2E hook, forwarded to the card root. The card is generic, so
   * without one every prompt looks identical in the DOM and no test can assert
   * that a PARTICULAR prompt surfaced. Set by specific callers.
   */
  'data-testid'?: string;
  /** Optional E2E hook for the CTA button, which the root's id cannot reach. */
  actionTestId?: string;
}

const CardActionButton: FC<{ className?: string; children?: React.ReactNode }> = ({ className, children }) => (
  <button type="button" data-card-action className={className}>
    {children}
  </button>
);

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
  className,
  'data-testid': testId,
  actionTestId
}) => {
  const { t } = useTranslation();

  const containerRef = useRef<HTMLDivElement>(null);
  // Set when the card is activated with focus inside it, so a hero that replaces
  // the activated button can keep that focus in the card (#923).
  const restoreFocusRef = useRef(false);

  const handleClick = () => {
    if (!onClick) return;
    const active = document.activeElement;
    // Only focus the user actually had: a pointer tap that focused nothing (Safari
    // does not focus buttons on click) is not moved anywhere.
    restoreFocusRef.current = !!active && active !== containerRef.current && !!containerRef.current?.contains(active);
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

  // The card action is a REAL button around the title lockup, not a
  // `role="button"` on the container: ARIA gives the button role presentational
  // children, which hid the dismiss X and CTA nested inside it. Its click
  // bubbles to the container handler, so a pointer tap anywhere on the card and
  // Enter/Space on this button both run the same action.
  const Lockup = onClick ? CardActionButton : 'div';

  // Every exit from the hero has to be narrated through the region that existed
  // BEFORE the change, not only hero-to-hero swaps: a failure drops the hero and
  // shows the faucet's message as plain body text beside a freshly mounted
  // failure indicator - which is exactly the node assistive tech does not
  // announce - so the message is carried here instead.
  const liveAnnouncement = hero
    ? [hero.label, hero.subLabel].filter(Boolean).join('. ')
    : status === 'failure'
      ? [t('failed'), body].filter(Boolean).join('. ')
      : '';

  const heroShown = hero !== undefined;
  // A hero replaces the lockup outright, so the card-action button a keyboard user
  // just pressed unmounts and focus falls to the page. Run before paint: keep that
  // focus in the card while the hero shows, and hand it back to the card's own
  // action when the hero ends without the card going away.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const active = document.activeElement;
    if (heroShown) {
      const focusLeftTheCard = !active || active === document.body || !container.contains(active);
      if (restoreFocusRef.current && focusLeftTheCard) container.focus({ preventScroll: true });
      restoreFocusRef.current = false;
    } else if (active === container) {
      container.querySelector<HTMLElement>('[data-card-action]')?.focus({ preventScroll: true });
    }
  }, [heroShown]);

  const reduceMotion = useReducedMotion();
  // A looping flip is exactly what reduced motion asks us not to run.
  const flipping = status === 'loading' && !reduceMotion;

  const ActionButton =
    actionLabel && onAction && status !== 'loading' && status !== 'success' ? (
      <button
        data-testid={actionTestId}
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
      ref={containerRef}
      data-testid={testId}
      // Focusable only while a hero holds the card, as the place focus stays.
      tabIndex={heroShown ? -1 : undefined}
      onClick={onClick ? handleClick : undefined}
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
      {/* The hero replaces the title, body and CTA outright, so this is the only
          thing left to narrate the funding lifecycle. It is rendered on every
          card and never keyed: a live region is only announced when it already
          exists before its content changes, and the hero lockup itself is keyed
          by label, so putting the role there recreated the node on each swap
          and the "Funds deposited" beat went unannounced. */}
      <span role="status" aria-live="polite" className="sr-only">
        {liveAnnouncement}
      </span>
      {status === 'loading' && (
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-accent-primary/15">
          <motion.span
            className="block h-full w-1/3 rounded-full bg-accent-primary"
            animate={reduceMotion ? { x: 0 } : { x: ['-100%', '300%'] }}
            transition={reduceMotion ? { duration: 0 } : { duration: 1.4, ease: 'easeInOut', repeat: Infinity }}
          />
        </span>
      )}
      {hero ? (
        // Keyed so the lockup re-pops when the hero swaps (Funding → Funded!).
        <motion.div
          key={hero.label}
          // The stable live region below narrates this; the keyed lockup is
          // recreated on every hero swap, so it must not be read a second time.
          aria-hidden="true"
          className="flex flex-1 flex-col items-center justify-center gap-1"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
        >
          <div className="flex items-center gap-2.5">
            <span
              className={classNames(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-pure-white',
                hero.tone === 'positive' ? 'bg-status-positive' : 'bg-accent-primary'
              )}
            >
              <motion.span
                className="flex items-center justify-center"
                animate={flipping ? { rotate: [0, 0, 180, 180, 360] } : { rotate: 0 }}
                transition={
                  flipping
                    ? { duration: 2.2, times: [0, 0.35, 0.5, 0.85, 1], ease: [0.77, 0, 0.175, 1], repeat: Infinity }
                    : { duration: 0 }
                }
              >
                <Icon name={hero.icon} size="xs" fill="currentColor" />
              </motion.span>
            </span>
            <span className="font-heading text-xl font-extrabold text-heading-gray">{hero.label}</span>
          </div>
          {hero.subLabel && <span className="text-xs font-normal text-text-tertiary-token">{hero.subLabel}</span>}
        </motion.div>
      ) : (
        <Lockup className="flex flex-col gap-1 min-w-0 flex-1 text-left text-black">
          <div className={classNames('text-base font-bold font-heading leading-tight truncate')}>{title}</div>
          {body && <div className="text-xs font-normal line-clamp-2">{body}</div>}
        </Lockup>
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
