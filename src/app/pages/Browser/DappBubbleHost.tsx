/**
 * Fixed-position overlay that hosts the floating bubble(s) for parked dApps.
 *
 * Lives at z-65 in the Z-index landscape (above the capsule 60, below
 * the dApp confirmation modal 70). Mounted by `<DappBrowserProvider>`
 * so it survives tab navigation — a parked dApp's bubble stays
 * interactive from any tab.
 *
 * PR-4 chunk 7: renders one `<DappBubble>` per parked session. PR-5 adds
 * the long-press radial menu and stacking polish; for now the bubbles
 * just float side-by-side and each manages its own drag + snap-to-corner
 * state independently.
 */

import React, { type FC, useEffect, useState } from 'react';

import { AnimatePresence } from 'framer-motion';

import { useDappBrowser } from 'app/providers/DappBrowserProvider';
import { getSnapshot, subscribeSnapshots } from 'lib/dapp-browser/snapshot-store';

import { DappBubble } from './DappBubble';

const FOOTER_HEIGHT_FALLBACK = 88;

export const DappBubbleHost: FC = () => {
  const { parkedSessions, restore } = useDappBrowser();
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

  return (
    <div className="pointer-events-none fixed inset-0" style={{ zIndex: 65 }} aria-hidden={parkedSessions.length === 0}>
      <AnimatePresence>
        {parkedSessions.map(state => {
          const snapshot = getSnapshot(state.session.id);
          return (
            <div className="pointer-events-auto" key={`bubble-${state.session.id}-${snapshotTick}`}>
              <DappBubble
                session={state.session}
                snapshot={snapshot}
                footerHeight={footerHeight}
                onTap={() => void restore(state.session.id)}
              />
            </div>
          );
        })}
      </AnimatePresence>
    </div>
  );
};
