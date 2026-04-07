/**
 * iOS-style card switcher for managing all open dApp sessions.
 *
 * PR-5 minimal version: shipped with multi-bubble polish to give the
 * user a way to manage many parked dApps. The full design (paging
 * carousel, swipe-up-to-close, shared-element morph to fullscreen) is
 * spelled out in `~/.claude/plans/logical-forging-hearth.md` PR-5; this
 * file ships the structural pieces (modal sheet, card grid, tap-to-
 * restore, tap-✕-to-close) and leaves the carousel/morph as future
 * polish that can land without breaking callers.
 *
 * Z-index 80 — above the bubble host (65) and the dApp confirmation
 * modal (70) per the plan's z-index landscape.
 */

import React, { type FC, useCallback, useEffect } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { useSprings } from 'lib/animation';
import {
  type DappSession,
  getDappDisplayName,
  getDappHostname,
  getFallbackColor,
  getFallbackLetter
} from 'lib/dapp-browser';
import { getSnapshot } from 'lib/dapp-browser/snapshot-store';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';

import { type DappSessionState, useDappBrowser } from 'app/providers/DappBrowserProvider';

interface DappSwitcherProps {
  open: boolean;
  onClose: () => void;
}

export const DappSwitcher: FC<DappSwitcherProps> = ({ open, onClose }) => {
  const { sessionStates, restore, close } = useDappBrowser();
  const { t } = useTranslation();

  // Close when there are no sessions left.
  useEffect(() => {
    if (open && sessionStates.length === 0) {
      onClose();
    }
  }, [open, sessionStates.length, onClose]);

  const handleCardTap = useCallback(
    (session: DappSession) => {
      hapticLight();
      void restore(session.id);
      onClose();
    },
    [restore, onClose]
  );

  const handleCardClose = useCallback(
    (e: React.MouseEvent, session: DappSession) => {
      e.stopPropagation();
      hapticMedium();
      void close(session.id);
    },
    [close]
  );

  const headerCountLabel =
    sessionStates.length === 1
      ? (t('openDappCountOne') ?? '1 open dApp')
      : (t('openDappCountPlural') ?? '{count} open dApps').replace('{count}', String(sessionStates.length));

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          // PR-7: proper dialog semantics so VoiceOver/TalkBack trap
          // focus and announce the switcher as a modal experience.
          role="dialog"
          aria-modal="true"
          aria-label={t('dappSwitcher') ?? 'dApp switcher'}
          className="fixed inset-0 flex flex-col items-center justify-start"
          style={{ zIndex: 80, backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(24px)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose();
          }}
        >
          {/* Top bar with close button */}
          <div
            className="flex w-full items-center justify-between px-4"
            style={{ paddingTop: 'calc(env(safe-area-inset-top) + 16px)' }}
          >
            <div className="text-base font-semibold text-pure-white" aria-live="polite">
              {headerCountLabel}
            </div>
            <button
              type="button"
              aria-label={t('closeDappSwitcher') ?? 'Close dApp switcher'}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10"
              onClick={e => {
                e.stopPropagation();
                onClose();
              }}
            >
              <span className="text-xl text-pure-white" aria-hidden="true">
                ✕
              </span>
            </button>
          </div>

          {/* Card grid — scrollable so 6+ cards don't overflow. The
              grid's own click handler stops propagation so taps
              inside a card don't bubble to the backdrop's dismiss
              handler. */}
          <div
            className="mt-6 w-full flex-1 overflow-y-auto px-4"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 24px)' }}
            onClick={e => e.stopPropagation()}
            role="list"
          >
            <div className="grid grid-cols-2 gap-3">
              {sessionStates.map(state => (
                <SwitcherCard key={state.session.id} state={state} onTap={handleCardTap} onClose={handleCardClose} />
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

interface SwitcherCardProps {
  state: DappSessionState;
  onTap: (session: DappSession) => void;
  onClose: (e: React.MouseEvent, session: DappSession) => void;
}

const SwitcherCard: FC<SwitcherCardProps> = ({ state, onTap, onClose }) => {
  // PR-7: reduce-motion-aware springs. The card enter animation is
  // coupled to the switcher's AnimatePresence so the whole surface
  // snaps instantly when reduce motion is on.
  const springs = useSprings();
  const { session } = state;
  const snapshot = getSnapshot(session.id);
  const fallbackColor = getFallbackColor(session.origin);
  const fallbackLetter = getFallbackLetter(session.origin);
  // Shared display-name helper drops the `https://` prefix the
  // session.title falls back to before the page loads, so the card
  // title and aria-label both read as the friendly hostname.
  const displayName = getDappDisplayName(session);
  const hostname = getDappHostname(session.url);

  return (
    // The card is a `listitem` rather than a `button` so the per-card
    // close ✕ stays its own first-class accessibility element. iOS
    // VoiceOver collapses the children of role="button" into the
    // parent's accessible name, which used to hide the close X
    // entirely from the a11y tree. The tap-to-restore action lives on
    // a child button that fills the card.
    <motion.div
      layout
      initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 24, scale: 0.96 }}
      transition={springs.sheetPresent}
      className="relative flex aspect-[3/4] flex-col overflow-hidden rounded-2xl bg-pure-white shadow-[0_16px_48px_rgba(0,0,0,0.4)]"
      role="listitem"
    >
      {/* Tap-to-restore button — fills the card and sits behind the
          per-card close X so the close X stays independently tappable
          and is its own a11y element. */}
      <button
        type="button"
        className="absolute inset-0 cursor-pointer"
        onClick={() => onTap(session)}
        aria-label={`${displayName}. Activate to switch to this dApp.`}
      />
      {/* Snapshot or fallback. `background-position: top center` makes
          the card show the TOP of the page (favicon / header / hero)
          rather than a middle slice — the default `center` position
          cropped the Miden logo to "DEN" and similar on tall pages. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={
          snapshot
            ? {
                backgroundImage: `url(${snapshot})`,
                backgroundSize: 'cover',
                backgroundPosition: 'top center',
                backgroundRepeat: 'no-repeat'
              }
            : { background: fallbackColor }
        }
      >
        {!snapshot && (
          <div className="flex h-full w-full items-center justify-center">
            <span className="text-5xl font-bold text-pure-white opacity-90">{fallbackLetter}</span>
          </div>
        )}
      </div>

      {/* Top gradient with title — pointer-events-none so the
          tap-to-restore button beneath stays clickable; the close X
          re-enables pointer events on itself. */}
      <div
        className="pointer-events-none relative flex items-start justify-between p-3"
        style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0))'
        }}
      >
        <div className="min-w-0 flex-1 pr-2">
          <div className="truncate text-sm font-semibold text-pure-white">{displayName}</div>
          {displayName !== hostname && <div className="truncate text-xs text-pure-white/80">{hostname}</div>}
        </div>
        <button
          type="button"
          aria-label={`Close ${displayName}`}
          className="pointer-events-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/40"
          onClick={e => onClose(e, session)}
          onKeyDown={e => {
            // Stop the card's keyboard activation from firing when the
            // user presses Enter/Space on the ✕ inside it.
            if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
          }}
        >
          <span className="text-xs text-pure-white" aria-hidden="true">
            ✕
          </span>
        </button>
      </div>

      {/* Loading indicator (bottom-left) */}
      {state.isLoading && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-pure-white">
          Loading…
        </div>
      )}
    </motion.div>
  );
};
