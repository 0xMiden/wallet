/**
 * Fixed-position overlay that hosts the floating bubble(s) for parked dApps.
 *
 * Lives at z-65 in the Z-index landscape (above the capsule 60, below
 * the dApp confirmation modal 70). Mounted by `<DappBrowserProvider>`
 * so it survives tab navigation — a parked dApp's bubble stays
 * interactive from any tab.
 *
 * PR-3 ships single-bubble support (length 0 or 1). PR-5 generalizes
 * to multi-bubble stacking with a long-press radial menu.
 */

import React, { type FC, useEffect, useState } from 'react';

import { AnimatePresence } from 'framer-motion';

import { useDappBrowser } from 'app/providers/DappBrowserProvider';
import { getSnapshot, subscribeSnapshots } from 'lib/dapp-browser/snapshot-store';

import { DappBubble } from './DappBubble';

const FOOTER_HEIGHT_FALLBACK = 88;

export const DappBubbleHost: FC = () => {
  const { session, mode, restore } = useDappBrowser();
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

  const visible = mode === 'parked' && session != null;
  const snapshot = visible ? getSnapshot(session.id) : undefined;

  return (
    <div className="pointer-events-none fixed inset-0" style={{ zIndex: 65 }} aria-hidden={!visible}>
      <AnimatePresence>
        {visible && (
          <div className="pointer-events-auto" key={`bubble-${session.id}-${snapshotTick}`}>
            <DappBubble
              session={session}
              snapshot={snapshot}
              footerHeight={footerHeight}
              onTap={() => void restore()}
            />
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
