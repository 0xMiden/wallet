/**
 * Fixed-position overlay that hosts the floating bubble(s) for parked dApps.
 *
 * Lives at z-65 in the Z-index landscape (above the capsule 60, below
 * the dApp confirmation modal 70). Mounted by `<DappBrowserProvider>`
 * so it survives tab navigation — a parked dApp's bubble stays
 * interactive from any tab.
 *
 * Layout strategy:
 *  - 1–3 parked sessions: render each bubble with a diagonal cascade.
 *  - 4+ parked sessions: render only the most-recent bubble with a
 *    "+N" count badge. Tapping it opens the card switcher (where every
 *    parked session is browsable). This prevents the bottom-right from
 *    turning into an indecipherable pile of overlapping circles once
 *    the user has more than a handful of dApps open.
 */

import React, { type FC, useEffect, useState } from 'react';

import { AnimatePresence } from 'framer-motion';

import { useDappBrowser } from 'app/providers/DappBrowserProvider';
import { getSnapshot, subscribeSnapshots } from 'lib/dapp-browser/snapshot-store';

import { DappBubble } from './DappBubble';

// Bumped from 88 → 110 (+22) so the bubbles sit flush above the
// native navbar pill with a 4pt visible gap. The pill is 76pt tall
// and sits 12pt above the home-indicator safe area, plus the typical
// safe area inset of ~34pt — the 22pt bump pushes the bubble up by
// the difference so its bottom edge sits cleanly at the pill's top
// edge instead of overlapping the upper portion of the pill (which
// the previous 88 value did, hiding ~18pt of the bubble behind the
// native navbar UIWindow).
const FOOTER_HEIGHT_FALLBACK = 110;
const MAX_VISIBLE_BUBBLES = 3;

export const DappBubbleHost: FC = () => {
  const { parkedSessions, restore, openSwitcher } = useDappBrowser();
  const [snapshotTick, setSnapshotTick] = useState(0);
  const [footerHeight, setFooterHeight] = useState(FOOTER_HEIGHT_FALLBACK);

  // Re-render when the snapshot store updates so a freshly captured
  // snapshot replaces the favicon-color tile without remounting the bubble.
  useEffect(() => subscribeSnapshots(() => setSnapshotTick(tick => tick + 1)), []);

  // Measure the footer overlay so the bubble corners clear it. The footer
  // sits at the bottom of the viewport at z-20; we read its bounding rect
  // once on mount and on resize.
  useEffect(() => {
    const measure = () => {
      const footer = document.querySelector('[data-tabbar-footer="true"]') as HTMLElement | null;
      if (footer) {
        setFooterHeight(footer.offsetHeight || FOOTER_HEIGHT_FALLBACK);
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Decide what to render. For ≤ MAX_VISIBLE_BUBBLES parked sessions we
  // render every bubble with a diagonal cascade. For more, we render
  // only the topmost bubble with an overflow badge — tapping it opens
  // the switcher rather than restoring the single visible session.
  const overflowCount = Math.max(0, parkedSessions.length - 1);
  const visibleBubbles = parkedSessions.length <= MAX_VISIBLE_BUBBLES ? parkedSessions : parkedSessions.slice(0, 1);

  return (
    <div
      data-dapp-bubble-host="true"
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: 65 }}
      aria-hidden={parkedSessions.length === 0}
    >
      <AnimatePresence>
        {visibleBubbles.map((state, index) => {
          const snapshot = getSnapshot(state.session.id);
          const isOverflowRoot = parkedSessions.length > MAX_VISIBLE_BUBBLES;
          return (
            <div className="pointer-events-auto" key={`bubble-${state.session.id}-${snapshotTick}`}>
              <DappBubble
                session={state.session}
                snapshot={snapshot}
                footerHeight={footerHeight}
                stackIndex={index}
                // When overflowing, the single visible bubble becomes
                // the "tabs" entry point — tap opens the switcher so
                // the user can pick any of their open dApps. Otherwise
                // tap restores this specific bubble.
                onTap={() => {
                  if (isOverflowRoot) {
                    openSwitcher();
                  } else {
                    void restore(state.session.id);
                  }
                }}
                overflowCount={isOverflowRoot ? overflowCount : 0}
              />
            </div>
          );
        })}
      </AnimatePresence>
    </div>
  );
};
