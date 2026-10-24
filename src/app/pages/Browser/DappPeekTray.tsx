/**
 * Right-anchored tray of "peek cards" representing every parked dApp.
 *
 * This replaces the original bottom-right bubble stack. The new tray is
 * modeled after the iOS App Switcher / Android Recents "peek" — portrait
 * mini-cards with snapshot backgrounds that cascade from the right edge
 * of the screen, just above the floating navbar pill.
 *
 * Why a tray instead of the old bubbles:
 *  - Bubbles carried no context beyond a cropped circle — users couldn't
 *    tell three dApps apart at a glance.
 *  - Stacked bubbles became an unreadable pile once 3+ were parked,
 *    forcing a "+N" escape hatch that hid most of the state.
 *  - Cards show the name and a usable snapshot thumbnail, so "which dApp
 *    is this?" is answerable without tapping anything.
 *
 * Layout:
 *  - Fixed to the bottom of the viewport, sitting directly above the
 *    floating React BottomNav. It reads the top edge of the React footer
 *    overlay (`[data-tabbar-footer="true"]`) while the bar is at rest,
 *    re-reading on resize, on `body[data-hide-navbar]` changing and when
 *    the footer mounts (see peek-footer).
 *  - Up to `MAX_VISIBLE_CARDS` cards render inline. Each card behind the
 *    front one is offset CARD_STACK_OFFSET pixels to the left and
 *    scaled down slightly; the rightmost (frontmost) card is fully
 *    visible and bears the close + overflow buttons.
 *  - When more than `MAX_VISIBLE_CARDS` sessions are parked, the card at
 *    index MAX_VISIBLE_CARDS-1 carries a "+N" badge that opens the
 *    fullscreen switcher as a browse-all escape hatch.
 *
 * `data-dapp-bubble-host="true"` on the outer element keeps the existing
 * `body[data-drawer-open]` CSS morph working — no main.css edits needed.
 * The tray slides down out of sight whenever a Settings sub-page or the
 * new dApp actions sheet takes over the bottom of the screen.
 */

import React, { type FC, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';

import type { MorphVelocity } from '@miden/dapp-browser';
import { useDappBrowser } from 'app/providers/DappBrowserProvider';
import { type DappSession } from 'lib/dapp-browser';
import { getSnapshot, subscribeSnapshots } from 'lib/dapp-browser/snapshot-store';

import { DappExpanderOverlay } from './DappExpanderOverlay';
import { CARD_HEIGHT, CARD_STACK_OFFSET, CARD_WIDTH, DappPeekCard } from './DappPeekCard';
import { FOOTER_CLEARANCE_FALLBACK, subscribeFooterClearance } from './peek-footer';
import { CARD_CORNER_RADIUS, type SlotRect, frontCardRect, resolveTargetRect } from './peek-target-rect';

const MAX_VISIBLE_CARDS = 3;
// Side padding from the right edge of the screen. 16pt matches the
// wallet's standard content gutter so the tray aligns with everything
// else visually.
const EDGE_PADDING = 16;

/** A restore without a native morph: its snapshot flies from the card to the slot instead of the page. */
interface ColdExpand {
  session: DappSession;
  snapshot: string | null;
  sourceRect: SlotRect;
  targetRect: SlotRect;
}

/**
 * `ids` most recently arrived first. A session joins at the front and keeps its place, so the card a collapse lands
 * on is still the front card once its session parks, whatever order the sessions were opened in.
 */
function useArrivalOrder(ids: string[]): string[] {
  const order = useRef<string[]>([]);
  const kept = order.current.filter(id => ids.includes(id));
  order.current = [...ids.filter(id => !kept.includes(id)), ...kept];
  return order.current;
}

/** Off its resting place (slid away under a drawer, or sliding back) the tray offers no card to land on. */
function trayAtRest(tray: HTMLElement): boolean {
  if (document.body.hasAttribute('data-drawer-open')) return false;
  const transform = window.getComputedStyle(tray).transform;
  return !transform || transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
}

export const DappPeekTray: FC = () => {
  const { parkedSessions, sessionStates, motion, restore, close, openSwitcher, reportLandingCard, slotRect } =
    useDappBrowser();
  const [, setSnapshotTick] = useState(0);
  const [footerClearance, setFooterClearance] = useState(FOOTER_CLEARANCE_FALLBACK);
  const [coldExpand, setColdExpand] = useState<ColdExpand | null>(null);
  const slotRectRef = useRef(slotRect);
  slotRectRef.current = slotRect;
  // DappActive clears the slot when it unmounts, so a restore from a parked tray reads null and lands on the last
  // measured slot instead of the computed fallback.
  const lastMeasuredSlotRef = useRef<SlotRect | null>(null);
  if (slotRect && slotRect.width > 0 && slotRect.height > 0) lastMeasuredSlotRef.current = slotRect;
  // Cyclic rotation pointer into `orderedAll`. The session at
  // `orderedAll[activeIndex]` becomes the frontmost card. Swiping the front
  // card rotates it; a card arriving resets it so the new card is in front.
  const [activeIndex, setActiveIndex] = useState(0);
  const trayRef = useRef<HTMLDivElement>(null);

  // Re-render when the snapshot store updates so freshly-captured
  // snapshots swap in without unmounting their card.
  useEffect(() => subscribeSnapshots(() => setSnapshotTick(tick => tick + 1)), []);

  // Measure the footer's top edge while the bar is at rest so the tray sits just above BottomNav
  // (see peek-footer).
  useEffect(() => subscribeFooterClearance(setFooterClearance), []);

  // The front card is where a native collapse lands (#1817), so its rect is published whenever the tray moves.
  useLayoutEffect(() => {
    const tray = trayRef.current;
    if (!tray) return;
    const publish = () => reportLandingCard(trayAtRest(tray) ? frontCardRect(tray.getBoundingClientRect()) : null);
    publish();
    window.addEventListener('resize', publish);
    tray.addEventListener('transitionend', publish);
    const observer = new MutationObserver(publish);
    observer.observe(document.body, { attributeFilter: ['data-drawer-open'] });
    return () => {
      window.removeEventListener('resize', publish);
      tray.removeEventListener('transitionend', publish);
      observer.disconnect();
    };
  }, [footerClearance, reportLandingCard]);
  useEffect(() => () => reportLandingCard(null), [reportLandingCard]);

  // A warm card hands its rect and release velocity to the native morph, which moves the live page from it. A cold
  // session has no page to move yet, and a plugin that refuses the morph shows the page without one: then the
  // snapshot overlay makes the trip.
  const handleCommitRestore = useCallback(
    (session: DappSession, rect: DOMRect, velocity: MorphVelocity) => {
      const card = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      const expandSnapshot = () =>
        setColdExpand({
          session,
          snapshot: getSnapshot(session.id) ?? null,
          sourceRect: card,
          targetRect: resolveTargetRect(slotRectRef.current, lastMeasuredSlotRef.current)
        });
      const state = sessionStates.find(s => s.session.id === session.id);
      if (!state?.instance || state.isCold) {
        expandSnapshot();
        void restore(session.id);
        return;
      }
      void restore(session.id, {
        // A back card is scaled down, and its corners with it.
        card: { ...card, cornerRadius: CARD_CORNER_RADIUS * (rect.width / CARD_WIDTH) },
        velocity
      }).then(moved => {
        if (!moved) expandSnapshot();
      });
    },
    [restore, sessionStates]
  );

  // Cards render newest-first so the dApp the user most recently
  // minimized is the frontmost card (closest to their thumb, unobscured,
  // obvious tap target). The page in flight keeps a card under it: a
  // collapse lands on the front card before its session parks, and an
  // expand leaves its card until the native page has started covering it.
  // Then we CYCLICALLY ROTATE by `activeIndex` so the user-selected
  // active card is at the front. Finally, slice to MAX_VISIBLE_CARDS
  // and pass the overflow count to the front card as a "+N" badge.
  const parked = [...parkedSessions].reverse().map(state => state.session);
  const movingId = motion && (motion.target === 'collapsed' || !motion.started) ? motion.id : null;
  const moving = parked.some(s => s.id === movingId)
    ? undefined
    : sessionStates.find(state => state.session.id === movingId)?.session;
  const byId = new Map((moving ? [moving, ...parked] : parked).map(s => [s.id, s]));
  const orderedAll = useArrivalOrder([...byId.keys()]).flatMap(id => byId.get(id) ?? []);
  const rotated =
    orderedAll.length > 0 && activeIndex > 0
      ? [...orderedAll.slice(activeIndex), ...orderedAll.slice(0, activeIndex)]
      : orderedAll;
  const visible = rotated.slice(0, MAX_VISIBLE_CARDS);
  // Overflow count stays independent of activeIndex (it's just the
  // cards that don't fit in the visible slice at any given time).
  const overflowCount = Math.max(0, rotated.length - MAX_VISIBLE_CARDS);

  // Reset the rotation pointer whenever a card arrives, so the newly
  // minimized dApp is always the front card, where its collapse lands.
  // Also clamp `activeIndex` if the list shrinks below it (e.g. a
  // session was closed from the switcher).
  const prevCardCountRef = useRef(orderedAll.length);
  useEffect(() => {
    const len = orderedAll.length;
    if (len > prevCardCountRef.current) {
      setActiveIndex(0);
    } else if (activeIndex >= len && len > 0) {
      setActiveIndex(0);
    } else if (len === 0 && activeIndex !== 0) {
      setActiveIndex(0);
    }
    prevCardCountRef.current = len;
  }, [orderedAll.length, activeIndex]);

  const handleNavigate = useCallback(
    (direction: 'left' | 'right') => {
      setActiveIndex(prev => {
        const len = orderedAll.length;
        if (len <= 1) return prev;
        // Swipe RIGHT → the card behind/below the current one moves
        // forward to become active (activeIndex advances). Swipe LEFT
        // rewinds to the previous active card. This matches the
        // physical metaphor: the front card slides right under the
        // finger and the next card emerges to take its place.
        if (direction === 'right') return (prev + 1) % len;
        return (prev - 1 + len) % len;
      });
    },
    [orderedAll.length]
  );

  // Width of the positioning box: front card is fully visible plus each
  // behind-card contributes CARD_STACK_OFFSET of left-side peek. This
  // lets us right-anchor the container without the back cards getting
  // clipped off the left edge of the viewport.
  const stackWidth = CARD_WIDTH + Math.max(0, visible.length - 1) * CARD_STACK_OFFSET;

  // Portal the tray into `document.body` rather than letting it render
  // inside the wallet's React tree. The app's global layout CSS in
  // main.css applies `width: 100% !important; height: 100% !important`
  // to every `#root > div` so the main layout container fills the
  // viewport — but because the provider mounts this tray as a sibling
  // of its children, React ended up placing the tray's outer element
  // as a direct `#root > div` child too, and the `!important` rule
  // stretched it to the full screen, breaking fixed positioning.
  // Portalling sidesteps the whole selector match.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={trayRef}
      data-dapp-bubble-host="true"
      data-testid="dapp-peek-tray"
      className="pointer-events-none fixed"
      style={{
        // Position the tray so its bottom edge sits 4pt above the top
        // of the footer — a clean visible gap without overlapping the
        // navbar pill.
        bottom: footerClearance + 4,
        right: EDGE_PADDING,
        width: stackWidth,
        height: CARD_HEIGHT,
        zIndex: 65
      }}
      aria-hidden={visible.length === 0}
    >
      <div className="relative h-full w-full">
        <AnimatePresence>
          {visible.map((session, index) => (
            <DappPeekCard
              key={session.id}
              session={session}
              snapshot={getSnapshot(session.id) ?? undefined}
              stackIndex={index}
              // Pass the overflow count to the FRONT card only (index 0).
              // The front card is the most prominent and always fully
              // visible, so a "+N more" badge there reads cleanly. Back
              // cards only peek ~30pt so they're too cramped to host
              // additional chrome.
              overflowCount={index === 0 ? overflowCount : 0}
              // Under a collapsing page the card is already in place, its chrome back once the page hands over;
              // under an expanding one it leaves at once when the page has covered it.
              isShrinking={motion?.id === session.id && motion.target === 'collapsed'}
              chromeVisible={motion?.id !== session.id}
              exitInstantly={motion?.id === session.id && motion.target === 'expanded'}
              onCommitRestore={(rect, velocity) => handleCommitRestore(session, rect, velocity)}
              onClose={() => void close(session.id)}
              onShowAll={openSwitcher}
              // Only the front card (index 0) gets onNavigate. Back
              // cards can't reliably host a drag handler anyway because
              // the front card overlays their position. Disable nav
              // entirely when there's only one session — nothing to
              // rotate to.
              onNavigate={index === 0 && orderedAll.length > 1 ? handleNavigate : undefined}
            />
          ))}
        </AnimatePresence>
      </div>
      {coldExpand && (
        <DappExpanderOverlay
          key={coldExpand.session.id}
          sourceRect={coldExpand.sourceRect}
          snapshot={coldExpand.snapshot}
          origin={coldExpand.session.origin}
          targetRect={coldExpand.targetRect}
          onDone={() => setColdExpand(null)}
        />
      )}
    </div>,
    document.body
  );
};
