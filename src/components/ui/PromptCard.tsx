import React, { FC, useLayoutEffect, useRef, useState } from 'react';

import classNames from 'clsx';
import { motion, useReducedMotion } from 'framer-motion';
import { flushSync } from 'react-dom';
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
  /**
   * The card action. Keyboard focus stays in the card when this swaps in a hero only
   * if the hero is scheduled before the handler's first await: the render it causes
   * is committed synchronously, and a later one no longer knows the tap moved focus.
   */
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

/**
 * The tone of an icon bubble: the accent for anything neutral or in progress, the status green for
 * a finished one, the status red for a failed one.
 */
type PromptIconTone = 'accent' | 'positive' | 'negative';

const ICON_BUBBLE_TONE: Record<PromptIconTone, string> = {
  accent: 'bg-accent-primary/15 text-accent-primary',
  positive: 'bg-status-positive/15 text-status-positive',
  negative: 'bg-status-negative/15 text-status-negative'
};

interface PromptIconBubbleProps {
  tone: PromptIconTone;
  /** 24px for a status mark in the corner, 36px for the icon beside a title. */
  size: 24 | 36;
  role?: 'status';
  'aria-label'?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * The card's icon circle, in one shape: a round bubble in the tone's own tint carrying the tone's
 * own ink, like every other icon circle in the wallet. All four of the card's icons — its leading
 * glyph, the success and failure status marks and the hero lockup — are drawn by this, so none of
 * them can drift back into a squared tile on a solid fill with a white glyph.
 *
 * Deliberately not `Avatar`: that is a disc of one solid colour with WHITE initials or a white
 * glyph (`text-pure-white` sits in its base class and its `color` prop takes a raw CSS colour, not
 * a token), which is the opposite pairing to the tinted fill and tinted ink these bubbles use.
 */
const PromptIconBubble: FC<PromptIconBubbleProps> = ({
  tone,
  size,
  role,
  'aria-label': ariaLabel,
  className,
  children
}) => (
  <span
    role={role}
    aria-label={ariaLabel}
    className={classNames(
      'flex shrink-0 items-center justify-center overflow-hidden rounded-full',
      size === 24 ? 'h-6 w-6' : 'h-9 w-9',
      ICON_BUBBLE_TONE[tone],
      className
    )}
  >
    {children}
  </span>
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
  // Whether the container itself (not a child) holds focus. It stays focusable while it
  // does: Chromium blurs a focused element the moment its tabindex is removed, which would
  // drop focus to the page before the hero-end hand-back below could move it on.
  const [holdsFocus, setHoldsFocus] = useState(false);

  const handleClick = () => {
    if (!onClick) return;
    // Only focus the user actually had in the card: a pointer tap that focused nothing
    // (Safari does not focus buttons on click) is not moved anywhere.
    const hadFocus = !!containerRef.current?.contains(document.activeElement);
    hapticLight();
    // Rendered and committed before this returns, so the check below sees what the tap did.
    flushSync(onClick);
    // A hero replaced the lockup and unmounted the button just pressed: keep focus in the
    // card instead of letting it fall to the page (#923).
    if (hadFocus && (!document.activeElement || document.activeElement === document.body)) {
      containerRef.current?.focus({ preventScroll: true });
    }
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
  // When a hero ends with focus still on the card, hand it to the card's own action
  // before paint; the blur that follows lets the container stop being focusable.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!heroShown && container && document.activeElement === container) {
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
        className="shrink-0 rounded-full bg-accent-primary px-3 py-1.5 text-badge font-semibold text-pure-white disabled:cursor-not-allowed disabled:opacity-50"
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
      <PromptIconBubble tone="positive" size={24} role="status" aria-label={t('success')}>
        <Icon name={IconName.Checkmark} size="xs" className="scale-75" fill="currentColor" />
      </PromptIconBubble>
    ) : status === 'failure' ? (
      <PromptIconBubble tone="negative" size={24} role="status" aria-label={t('failed')}>
        <Icon name={IconName.Close} size="xs" fill="currentColor" />
      </PromptIconBubble>
    ) : null;

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      // Focusable while a hero holds the card, as the place focus stays, and until focus leaves.
      tabIndex={heroShown || holdsFocus ? -1 : undefined}
      onFocus={event => {
        if (event.target === event.currentTarget) setHoldsFocus(true);
      }}
      onBlur={event => {
        // A page, tab or side-panel blur fires this too while focus stays on the card.
        if (event.target === event.currentTarget && document.activeElement !== event.currentTarget) {
          setHoldsFocus(false);
        }
      }}
      onClick={onClick ? handleClick : undefined}
      className={classNames(
        // `outline`, like Activity's rows: a single actionable card that has to separate itself
        // where it sits on the page, not a grey block on the home page.
        'relative overflow-hidden w-full h-[72px] bg-page border border-hairline rounded-2xl',
        'flex items-center gap-3 px-4',
        // Tappable cards press in like the app's buttons do.
        onClick && 'transition-transform active:scale-[0.98]',
        className
      )}
    >
      {!hero && icon && (
        <PromptIconBubble tone="accent" size={36} className={status === 'loading' ? 'animate-pulse' : undefined}>
          <Icon name={icon} size="sm" fill="currentColor" />
        </PromptIconBubble>
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
            {/* The same bubble the card's other icons wear, sized to sit with its `text-title-page`
                label — not a squared tile on a solid fill with a white glyph. */}
            <PromptIconBubble tone={hero.tone} size={36}>
              <motion.span
                className="flex items-center justify-center"
                animate={flipping ? { rotate: [0, 0, 180, 180, 360] } : { rotate: 0 }}
                transition={
                  flipping
                    ? { duration: 2.2, times: [0, 0.35, 0.5, 0.85, 1], ease: [0.77, 0, 0.175, 1], repeat: Infinity }
                    : { duration: 0 }
                }
              >
                <Icon name={hero.icon} size="sm" fill="currentColor" />
              </motion.span>
            </PromptIconBubble>
            <span className="text-title-page text-ink">{hero.label}</span>
          </div>
          {hero.subLabel && <span className="text-caption text-text-tertiary-token">{hero.subLabel}</span>}
        </motion.div>
      ) : (
        <Lockup className="flex flex-col gap-1 min-w-0 flex-1 text-left text-ink">
          <div className="text-row-title truncate">{title}</div>
          {body && <div className="text-caption line-clamp-2 text-muted">{body}</div>}
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
