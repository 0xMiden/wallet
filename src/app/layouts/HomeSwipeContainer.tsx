import React, { FC, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { animate, motion, PanInfo, useMotionValue } from 'framer-motion';

import Explore from 'app/pages/Explore';
import { Receive } from 'app/pages/Receive';
import { springs } from 'lib/animation';
import { navigate, useLocation } from 'lib/woozie';
import { SendFlow } from 'screens/send-flow/SendManager';

/**
 * Carousel container that mounts all four home-group pages (Overview /
 * Send / Receive / Swap) in a horizontal track and lets the user drag
 * between them with their finger. The page tracks the finger in real
 * time and snaps to the next/previous index on release if dragged or
 * flicked past a threshold; otherwise it snaps back.
 *
 * Pathname is the source of truth for which page is centered — the
 * SegmentedActionBar in TabLayout reads the same path and stays in sync
 * via its framer-motion layoutId pill.
 */

interface HomePage {
  id: string;
  path: string;
}

const PAGES: HomePage[] = [
  { id: 'overview', path: '/' },
  { id: 'send', path: '/send' },
  { id: 'receive', path: '/receive' },
  { id: 'swap', path: '/swap' }
];

// Commit threshold: how far (as a fraction of the page width) the user
// has to drag — accounting for fling velocity — to snap to the adjacent
// page. Anything short of this snaps back.
const COMMIT_THRESHOLD = 0.3;
// Velocity projection factor — how many milliseconds of post-release
// momentum to extrapolate when deciding whether to commit. Higher feels
// flickier; lower feels stickier.
const VELOCITY_PROJECTION_MS = 300;

const SwapPlaceholder: FC = () => (
  <div className="h-full flex flex-col items-center justify-center gap-2 bg-white">
    <span className="text-2xl font-bold text-text-primary-token">Swap</span>
    <span className="text-sm text-text-tertiary-token">Coming soon</span>
  </div>
);

const HomeSwipeContainer: FC = () => {
  const { pathname } = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const [width, setWidth] = useState(0);

  const activeIdx = (() => {
    const exact = PAGES.findIndex(p => p.path === pathname);
    if (exact !== -1) return exact;
    // Match by prefix for nested routes (e.g. /send/sub-step).
    const prefix = PAGES.findIndex(p => p.path !== '/' && pathname.startsWith(`${p.path}/`));
    return prefix === -1 ? 0 : prefix;
  })();

  // Measure container width — drives both the snap positions and the
  // drag constraints. Set synchronously on mount so the first render
  // can place the active page correctly without a flash.
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    setWidth(containerRef.current.clientWidth);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Animate to the active page's resting position whenever activeIdx or
  // width changes. Uses the standard spring so this matches the rest of
  // the wallet's motion vocabulary.
  useEffect(() => {
    if (!width) {
      x.set(-activeIdx * (containerRef.current?.clientWidth ?? 0));
      return;
    }
    const controls = animate(x, -activeIdx * width, springs.standard);
    return () => controls.stop();
  }, [activeIdx, width, x]);

  const handleDragEnd = (_e: unknown, info: PanInfo) => {
    if (!width) return;
    const projected = info.offset.x + info.velocity.x * (VELOCITY_PROJECTION_MS / 1000);

    let newIdx = activeIdx;
    if (projected < -width * COMMIT_THRESHOLD && activeIdx < PAGES.length - 1) {
      newIdx = activeIdx + 1;
    } else if (projected > width * COMMIT_THRESHOLD && activeIdx > 0) {
      newIdx = activeIdx - 1;
    }

    if (newIdx !== activeIdx) {
      const target = PAGES[newIdx];
      if (target) navigate(target.path);
      // The activeIdx-driven useEffect above will animate to the new
      // resting position once the route commit causes a re-render.
    } else {
      animate(x, -activeIdx * width, springs.standard);
    }
  };

  // Drag constraints clamp the track to its valid x-range, with a small
  // elastic overshoot for that rubber-band feel at the ends.
  const dragMaxLeft = width ? -(PAGES.length - 1) * width : 0;

  return (
    <div ref={containerRef} className="h-full w-full overflow-hidden touch-pan-y">
      <motion.div
        className="h-full flex"
        style={{ x, width: `${PAGES.length * 100}%` }}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: dragMaxLeft, right: 0 }}
        dragElastic={0.15}
        dragMomentum={false}
        onDragEnd={handleDragEnd}
      >
        <div className="h-full shrink-0" style={{ width: `${100 / PAGES.length}%` }}>
          <Explore />
        </div>
        <div className="h-full shrink-0" style={{ width: `${100 / PAGES.length}%` }}>
          <SendFlow isLoading={false} />
        </div>
        <div className="h-full shrink-0" style={{ width: `${100 / PAGES.length}%` }}>
          <Receive />
        </div>
        <div className="h-full shrink-0" style={{ width: `${100 / PAGES.length}%` }}>
          <SwapPlaceholder />
        </div>
      </motion.div>
    </div>
  );
};

export default HomeSwipeContainer;
