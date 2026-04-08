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
 *    floating native navbar. Positioning is driven by a live measurement
 *    of the React footer overlay (`[data-tabbar-footer="true"]`) so the
 *    tray adapts if the navbar gets taller or shorter.
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
 * The tray slides down out of sight whenever a Settings drawer or the
 * new dApp actions sheet takes over the bottom of the screen.
 */

import React, { type FC, useEffect, useState } from 'react';

import { AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';

import { useDappBrowser } from 'app/providers/DappBrowserProvider';
import { getSnapshot, subscribeSnapshots } from 'lib/dapp-browser/snapshot-store';

import { CARD_HEIGHT, CARD_STACK_OFFSET, CARD_WIDTH, DappPeekCard } from './DappPeekCard';

// Fallback anchor distance from the bottom of the viewport. This
// accounts for the native navbar pill (~76pt) + its bottom gutter
// (~12pt) + the iPhone's home-indicator safe area inset (~34pt).
// Bumped above the old 110 so the tray clears the navbar pill
// comfortably; the old value sat with the card's bottom edge
// overlapping the top of the pill by ~10pt.
const FOOTER_HEIGHT_FALLBACK = 130;
// Minimum footer height we'll accept from a measurement. Below this
// we're almost certainly measuring the React footer DURING its brief
// pre-overlay render (it's 97pt at that moment before `display:none`
// kicks in), which would leave the tray too close to the navbar.
const MIN_MEASURED_FOOTER = 110;
const MAX_VISIBLE_CARDS = 3;
// Side padding from the right edge of the screen. 16pt matches the
// wallet's standard content gutter so the tray aligns with everything
// else visually.
const EDGE_PADDING = 16;

export const DappPeekTray: FC = () => {
  const { parkedSessions, restore, close, openSwitcher } = useDappBrowser();
  const [snapshotTick, setSnapshotTick] = useState(0);
  const [footerHeight, setFooterHeight] = useState(FOOTER_HEIGHT_FALLBACK);

  // Re-render when the snapshot store updates so freshly-captured
  // snapshots swap in without unmounting their card.
  useEffect(() => subscribeSnapshots(() => setSnapshotTick(tick => tick + 1)), []);

  // Measure the footer overlay so the tray sits just above it. On
  // mobile the React footer is hidden (display:none) as soon as the
  // native navbar UIWindow takes over, so the measured offsetHeight
  // is 0 during steady state — we fall back to FOOTER_HEIGHT_FALLBACK
  // in that case. We also reject any measurement below
  // MIN_MEASURED_FOOTER because the React footer briefly renders at
  // ~97pt before `display:none` kicks in, and that measurement would
  // otherwise stick and leave the tray overlapping the native pill.
  useEffect(() => {
    const measure = () => {
      const footer = document.querySelector('[data-tabbar-footer="true"]') as HTMLElement | null;
      const measured = footer?.offsetHeight ?? 0;
      const next = measured >= MIN_MEASURED_FOOTER ? measured : FOOTER_HEIGHT_FALLBACK;
      setFooterHeight(next);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Cards render newest-first so the dApp the user most recently
  // minimized is the frontmost card (closest to their thumb, unobscured,
  // obvious tap target). `parkedSessions` is kept in session-creation
  // order by the provider, so we reverse it here — the last-added
  // parked session lands at index 0 and becomes the front-of-deck.
  // We then slice to MAX_VISIBLE_CARDS and pass the overflow count to
  // the last visible card as a "+N" badge.
  const ordered = [...parkedSessions].reverse();
  const visible = ordered.slice(0, MAX_VISIBLE_CARDS);
  const overflowCount = Math.max(0, ordered.length - MAX_VISIBLE_CARDS);

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
      data-dapp-bubble-host="true"
      className="pointer-events-none fixed"
      style={{
        // Position the tray so its bottom edge sits 4pt above the top
        // of the footer — a clean visible gap without overlapping the
        // navbar pill.
        bottom: footerHeight + 4,
        right: EDGE_PADDING,
        width: stackWidth,
        height: CARD_HEIGHT,
        zIndex: 65
      }}
      aria-hidden={parkedSessions.length === 0}
    >
      <div className="relative h-full w-full">
        <AnimatePresence>
          {visible.map((state, index) => (
            <DappPeekCard
              key={`peek-card-${state.session.id}-${snapshotTick}`}
              session={state.session}
              snapshot={getSnapshot(state.session.id) ?? undefined}
              stackIndex={index}
              // Pass the overflow count to the FRONT card only (index 0).
              // The front card is the most prominent and always fully
              // visible, so a "+N more" badge there reads cleanly. Back
              // cards only peek ~30pt so they're too cramped to host
              // additional chrome.
              overflowCount={index === 0 ? overflowCount : 0}
              onTap={() => void restore(state.session.id)}
              onClose={() => void close(state.session.id)}
              onShowAll={openSwitcher}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>,
    document.body
  );
};
