import React, { FC, useEffect, useMemo, useRef, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { durations, easings, useMotion, useSprings } from 'lib/animation';
import { useOverlayScreenKey } from 'lib/e2e/useOverlayScreenKey';
import { isSwapEnabled } from 'lib/feature-flags';
import { useAllBalances, useAllTokensBaseMetadata, useMidenContext } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import Portal from 'lib/ui/Portal';
import { useLocation } from 'lib/woozie';

import { NotesIllustration } from './NotesIllustration';
import { SwipeIllustration } from './SwipeIllustration';
import { TourStep, useTourStore } from './tour-store';

/** Padding around the anchored element inside the spotlight cutout. */
const SPOTLIGHT_PAD = 8;
/** Clearance between the spotlight cutout and the coach card (5rem). */
const CARD_GAP = 80;
/** Minimum distance from the viewport edges the card may be clamped to. */
const CARD_MARGIN = 16;
/** Bottom offset for anchorless steps (explainers / waiting) — roomy enough
 *  to clear the iOS home indicator without reading the safe-area inset. */
const CARD_FALLBACK_BOTTOM = 40;
/** Anchorless bottom offset while the navbar is visible (the swipe-teaching
 *  phase drops the navbar hold), so the card clears the BottomNav too. */
const CARD_FALLBACK_BOTTOM_WITH_NAV = 116;

/**
 * Anchors are looked up by selector, not by importing the host components —
 * the pages under tour never know it exists. Steps without a selector render
 * the coach card alone (explainers and waiting states).
 */
const STEP_ANCHORS: Partial<Record<TourStep, string>> = {
  balance: '[data-tutorial="balance"]',
  fund: '[data-testid="faucet-prompt-action"]',
  'go-claim': '[data-testid="pending-notes-prompt-action"]',
  claim: '[data-testid="claim-all-button"]',
  finish: '[data-tutorial="balance"]',
  overview: '[data-testid="action-segment-overview"]'
};

const SWIPE_STEPS: readonly TourStep[] = ['swipe-send', 'swipe-receive', 'swipe-earn', 'swipe-swap'];

interface SpotlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function sameRect(a: SpotlightRect, b: SpotlightRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/**
 * The guided-tour overlay. Mounted once at App level so it survives the route
 * trips the tour itself causes (home → /pending-notes → generating-transaction
 * → home); renders nothing until `startTutorialTour()` fires.
 *
 * The whole overlay is pointer-events-none except the coach card: the dimmed
 * backdrop is drawn as a giant box-shadow around the cutout, so the
 * spotlighted control stays directly tappable and the tour never traps input.
 */
export const TutorialTour: FC = () => {
  const active = useTourStore(s => s.status === 'active');
  if (!active) return null;
  return <ActiveTour />;
};

const ActiveTour: FC = () => {
  const { t } = useTranslation();
  const springs = useSprings();
  // Step text swaps under mode="wait" (exit, then enter), so both legs must be
  // quick tweens — a spring here reads as the card "thinking" between steps.
  const textEnter = useMotion({ duration: durations.fast, ease: easings.easeOutCubic });
  const textExit = useMotion({ duration: 0.1, ease: easings.easeInCubic });
  const step = useTourStore(s => s.step);
  const fundStarted = useTourStore(s => s.fundStarted);
  const setStep = useTourStore(s => s.setStep);
  const end = useTourStore(s => s.end);
  const { pathname } = useLocation();
  useOverlayScreenKey(true, 'tutorial-tour');
  // Hide the bottom tab navbar during the guided claim phase (refcounted;
  // reverses on end/skip). Raising `data-hide-navbar` also locks the home
  // carousel's horizontal swipe (#481) — wanted early on (a stray swipe would
  // drag an adjacent pane over the spotlighted one), but it MUST drop for the
  // swipe-teaching phase, where that same lock would make the taught gesture
  // impossible.
  const swipePhase = SWIPE_STEPS.includes(step) || step === 'overview' || step === 'wrap-up';
  useHideNavbarWhileOpen(!swipePhase);

  // Fund-step arrival signal: the faucet's MIDEN note showing up in claimable
  // notes. Only watched while the fund/notes steps need it.
  const { currentAccount } = useMidenContext();
  const publicKey = currentAccount?.publicKey ?? '';
  const midenFaucetId = useMidenFaucetId();
  const watchNotes = step === 'fund' && publicKey !== '';
  const { data: claimableNotes } = useClaimableNotes(publicKey, watchNotes);
  const midenNoteArrived = useMemo(
    () => Boolean(midenFaucetId && claimableNotes?.some(n => n?.faucetId === midenFaucetId && !n?.swapOrder)),
    [claimableNotes, midenFaucetId]
  );

  useEffect(() => {
    if (step === 'fund' && fundStarted && midenNoteArrived) setStep('notes');
  }, [step, fundStarted, midenNoteArrived, setStep]);

  // Finish step: the claim only shows in the balance once the consume confirms
  // and syncs. Force a refetch on arrival (skips the poll's deduping window)
  // and hold a visible waiting state until the claimed amount actually lands —
  // otherwise the tour spotlights a stale number and reads as "slow".
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balances = [], mutate: mutateBalances } = useAllBalances(publicKey, allTokensBaseMetadata);
  const hasBalance = useMemo(() => balances.some(token => token.balance > 0), [balances]);
  useEffect(() => {
    if (step === 'finish') mutateBalances();
  }, [step, mutateBalances]);

  // Route-driven transitions: the user's own taps move the app; the tour follows.
  useEffect(() => {
    switch (step) {
      case 'go-claim':
        if (pathname === '/pending-notes') setStep('claim');
        break;
      case 'claim':
        if (pathname.includes('generating-transaction')) setStep('await-return');
        // Backed out of Pending Notes — rewind to the "tap the card" step
        // rather than pointing at a button that no longer exists.
        else if (pathname === '/') setStep('go-claim');
        break;
      case 'await-return':
        if (pathname === '/') setStep('finish');
        // Any other route (View in Activities on a failed claim, history, …)
        // means the user left the guided path. The tour is INVISIBLE on this
        // step — no Skip on screen — so it must end itself here, or its
        // mounted navbar hold strands the user with no bottom nav (the hold
        // and the E2E overlay key release on ActiveTour unmount).
        else if (!pathname.includes('generating-transaction')) end();
        break;
      case 'swipe-send':
      case 'swipe-receive':
      case 'swipe-earn':
      case 'swipe-swap': {
        // Ladder keyed by the pane REACHED, not the step order — a segment-bar
        // tap that jumps ahead (or a swipe back) just re-syncs the tour to
        // wherever the carousel actually is.
        const swipeLadder: Array<[string, TourStep]> = [
          ['/send', 'swipe-receive'],
          ['/receive', 'swipe-earn'],
          ['/earn', isSwapEnabled() ? 'swipe-swap' : 'overview'],
          ['/swap', 'overview']
        ];
        const reached = swipeLadder.find(([path]) => pathname === path || pathname.startsWith(`${path}/`));
        if (reached && reached[1] !== step) setStep(reached[1]);
        break;
      }
      case 'overview':
        if (pathname === '/') setStep('wrap-up');
        break;
    }
  }, [pathname, step, setStep, end]);

  const fundWaiting = step === 'fund' && fundStarted;
  const selector = fundWaiting ? undefined : STEP_ANCHORS[step];

  // Anchor geometry: polled (anchors mount late, scroll, resize, carousel
  // moves) rather than observed — a 250ms interval plus scroll/resize
  // listeners keeps the cutout glued to the target without wiring the host
  // components up to the tour.
  const [rect, setRect] = useState<SpotlightRect | null>(null);
  useEffect(() => {
    if (!selector) {
      setRect(null);
      return;
    }
    let raf = 0;
    const measure = () => {
      const el = document.querySelector(selector);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const next: SpotlightRect = { left: r.left, top: r.top, width: r.width, height: r.height };
      setRect(prev => (prev && sameRect(prev, next) ? prev : next));
    };
    measure();
    const interval = setInterval(measure, 250);
    const onViewportChange = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    return () => {
      clearInterval(interval);
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    };
  }, [selector]);

  const hidden = step === 'await-return';

  // The card's own height feeds the placement math (an above-the-spotlight
  // card is positioned by its bottom edge). Re-observed whenever the tour
  // comes back from its hidden await-return leg, since that unmounts the DOM.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardHeight, setCardHeight] = useState(0);
  useEffect(() => {
    if (hidden) return;
    const el = cardRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setCardHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [hidden]);

  if (hidden) return null;

  // Anchor-aware placement: a highlight in the bottom half of the viewport
  // puts the card above it, top half puts it below — always CARD_GAP clear of
  // the cutout, clamped to the viewport. Anchorless steps rest near the bottom.
  const viewportHeight = window.innerHeight;
  const fallbackBottom = swipePhase ? CARD_FALLBACK_BOTTOM_WITH_NAV : CARD_FALLBACK_BOTTOM;
  let cardTop = viewportHeight - cardHeight - fallbackBottom;
  if (rect) {
    const spotTop = rect.top - SPOTLIGHT_PAD;
    const spotBottom = rect.top + rect.height + SPOTLIGHT_PAD;
    const inBottomHalf = (spotTop + spotBottom) / 2 > viewportHeight / 2;
    cardTop = inBottomHalf ? spotTop - CARD_GAP - cardHeight : spotBottom + CARD_GAP;
    cardTop = Math.min(Math.max(cardTop, CARD_MARGIN), viewportHeight - cardHeight - CARD_MARGIN);
  }

  const finishWaiting = step === 'finish' && !hasBalance;
  const waiting = fundWaiting || finishWaiting;
  const copy = stepCopy(step, fundWaiting, finishWaiting);
  const cta =
    step === 'balance' || step === 'notes' || (step === 'finish' && hasBalance)
      ? 'next'
      : step === 'wrap-up'
        ? 'done'
        : null;
  const advance = () => {
    switch (step) {
      case 'balance':
        setStep('fund');
        break;
      case 'notes':
        setStep('go-claim');
        break;
      case 'finish':
        setStep('swipe-send');
        break;
      case 'wrap-up':
        end();
        break;
    }
  };

  return (
    <Portal>
      <div className="pointer-events-none fixed inset-0 z-40">
        <AnimatePresence>
          {rect && (
            <motion.div
              key="spotlight"
              className="absolute rounded-xl"
              initial={{ opacity: 0 }}
              animate={{
                opacity: 1,
                left: rect.left - SPOTLIGHT_PAD,
                top: rect.top - SPOTLIGHT_PAD,
                width: rect.width + SPOTLIGHT_PAD * 2,
                height: rect.height + SPOTLIGHT_PAD * 2
              }}
              exit={{ opacity: 0 }}
              transition={springs.morph}
              style={{ boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)' }}
            />
          )}
        </AnimatePresence>

        <motion.div
          ref={cardRef}
          className="pointer-events-auto absolute inset-x-4"
          initial={false}
          animate={{ top: cardTop }}
          transition={springs.standard}
        >
          <div className="flex flex-col gap-3 rounded-lg-token bg-surface-solid p-4 shadow-lg">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${step}${waiting ? '-waiting' : ''}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8, transition: textExit }}
                transition={textEnter}
                className="flex flex-col gap-1"
              >
                {step === 'notes' && <NotesIllustration />}
                {SWIPE_STEPS.includes(step) && <SwipeIllustration />}
                <div className="flex items-center gap-2">
                  {waiting && (
                    <span className="text-accent-primary">
                      <Icon name={IconName.Loader} size="sm" className="animate-spin" fill="currentColor" />
                    </span>
                  )}
                  <span className="text-base font-semibold text-heading-gray">{t(copy.titleKey)}</span>
                </div>
                <p className="text-sm text-text-muted">{t(copy.bodyKey)}</p>
              </motion.div>
            </AnimatePresence>
            <div className="flex flex-col gap-2">
              {cta && <Button title={t(cta === 'done' ? 'done' : 'next')} onClick={advance} />}
              {cta !== 'done' && <Button variant={ButtonVariant.Secondary} title={t('skip')} onClick={end} />}
            </div>
          </div>
        </motion.div>
      </div>
    </Portal>
  );
};

function stepCopy(step: TourStep, fundWaiting: boolean, finishWaiting: boolean): { titleKey: string; bodyKey: string } {
  if (fundWaiting) return { titleKey: 'tourFundWaitingTitle', bodyKey: 'tourFundWaitingBody' };
  if (finishWaiting) return { titleKey: 'tourFinishWaitingTitle', bodyKey: 'tourFinishWaitingBody' };
  switch (step) {
    case 'balance':
      return { titleKey: 'tourBalanceTitle', bodyKey: 'tourBalanceBody' };
    case 'fund':
      return { titleKey: 'tourFundTitle', bodyKey: 'tourFundBody' };
    case 'notes':
      return { titleKey: 'tourNotesTitle', bodyKey: 'tourNotesBody' };
    case 'go-claim':
      return { titleKey: 'tourGoClaimTitle', bodyKey: 'tourGoClaimBody' };
    case 'claim':
      return { titleKey: 'tourClaimTitle', bodyKey: 'tourClaimBody' };
    case 'swipe-send':
      return { titleKey: 'tourSwipeSendTitle', bodyKey: 'tourSwipeSendBody' };
    case 'swipe-receive':
      return { titleKey: 'tourSwipeReceiveTitle', bodyKey: 'tourSwipeReceiveBody' };
    case 'swipe-earn':
      return { titleKey: 'tourSwipeEarnTitle', bodyKey: 'tourSwipeEarnBody' };
    case 'swipe-swap':
      return { titleKey: 'tourSwipeSwapTitle', bodyKey: 'tourSwipeSwapBody' };
    case 'overview':
      return { titleKey: 'tourOverviewTitle', bodyKey: 'tourOverviewBody' };
    case 'wrap-up':
      return { titleKey: 'tourWrapUpTitle', bodyKey: 'tourWrapUpBody' };
    default:
      return { titleKey: 'tourFinishTitle', bodyKey: 'tourFinishBody' };
  }
}

export default TutorialTour;
