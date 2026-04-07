/**
 * The 64×64 floating bubble that represents a parked dApp.
 *
 * PR-3 ships a single-bubble version. The bubble:
 *  - Shows the dApp's snapshot if one was captured at park time
 *    (`snapshot-store.ts`); otherwise falls back to the favicon-color
 *    tile with the favicon centered
 *  - Pops in with `springs.magnetic` (overshoot) on first mount
 *  - Is draggable in 2D — releasing snaps to the nearest screen corner
 *  - Tap restores the parked session via `useDappBrowser().restore()`
 *
 * PR-5 adds long-press radial actions, multi-bubble stacking, and the
 * status badge dot.
 */

import React, { type FC, useCallback, useEffect, useRef, useState } from 'react';

import { motion, useAnimationControls } from 'framer-motion';

import { springs } from 'lib/animation';
import { type DappSession, getFallbackColor, getFallbackLetter } from 'lib/dapp-browser';
import { hapticBubbleAttach, hapticLight } from 'lib/mobile/haptics';

interface DappBubbleProps {
  session: DappSession;
  /** Snapshot data URL captured at park time, or undefined to use the fallback. */
  snapshot?: string;
  /** Footer height in CSS pixels — used to compute the bottom safe-corner offset. */
  footerHeight: number;
  onTap: () => void;
}

const SIZE = 64;
const EDGE_PADDING = 16;

interface Corner {
  x: number;
  y: number;
}

function computeCorners(footerHeight: number): Corner[] {
  if (typeof window === 'undefined') return [];
  const w = window.innerWidth;
  const h = window.innerHeight;
  // We assume `env(safe-area-inset-*)` is already factored into innerHeight
  // by the host. The footer overlay sits at the bottom of innerHeight, so
  // bottom-corner positions need to clear it.
  return [
    { x: EDGE_PADDING, y: EDGE_PADDING },
    { x: w - SIZE - EDGE_PADDING, y: EDGE_PADDING },
    { x: EDGE_PADDING, y: h - SIZE - EDGE_PADDING - footerHeight },
    { x: w - SIZE - EDGE_PADDING, y: h - SIZE - EDGE_PADDING - footerHeight }
  ];
}

function nearestCorner(corners: Corner[], x: number, y: number): Corner {
  let best = corners[0];
  let bestDist = Infinity;
  for (const c of corners) {
    const dx = c.x - x;
    const dy = c.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

export const DappBubble: FC<DappBubbleProps> = ({ session, snapshot, footerHeight, onTap }) => {
  const controls = useAnimationControls();
  const [iconBroken, setIconBroken] = useState(false);
  const dragStartedAt = useRef<{ x: number; y: number; time: number } | null>(null);
  const movedDuringDrag = useRef(false);
  // Anchor in CSS pixels (top-left of the bubble).
  const positionRef = useRef<Corner>(computeCorners(footerHeight)[3] ?? { x: 0, y: 0 });

  // Pop-in animation: scale 0 → 1 with overshoot.
  useEffect(() => {
    const initial = computeCorners(footerHeight)[3];
    if (initial) positionRef.current = initial;
    controls.set({
      x: positionRef.current.x,
      y: positionRef.current.y,
      scale: 0,
      opacity: 0
    });
    controls
      .start({
        scale: 1,
        opacity: 1,
        transition: springs.magnetic
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recompute corners when footerHeight or window changes; clamp current
  // position into the new bounds (e.g. on rotation).
  useEffect(() => {
    const onResize = () => {
      const corners = computeCorners(footerHeight);
      const snap = nearestCorner(corners, positionRef.current.x, positionRef.current.y);
      positionRef.current = snap;
      controls.start({ x: snap.x, y: snap.y, transition: springs.standard }).catch(() => {});
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [footerHeight, controls]);

  const handleDragStart = useCallback(() => {
    movedDuringDrag.current = false;
    dragStartedAt.current = { x: positionRef.current.x, y: positionRef.current.y, time: Date.now() };
  }, []);

  const handleDrag = useCallback((_: unknown, info: { delta: { x: number; y: number } }) => {
    if (Math.abs(info.delta.x) + Math.abs(info.delta.y) > 2) {
      movedDuringDrag.current = true;
    }
  }, []);

  const handleDragEnd = useCallback(
    (_: unknown, info: { point: { x: number; y: number } }) => {
      const corners = computeCorners(footerHeight);
      // info.point is the page coordinate of the release; subtract half the
      // bubble size so we snap by the bubble's center.
      const target = nearestCorner(corners, info.point.x - SIZE / 2, info.point.y - SIZE / 2);
      positionRef.current = target;
      hapticBubbleAttach();
      controls
        .start({
          x: target.x,
          y: target.y,
          transition: springs.magnetic
        })
        .catch(() => {});
    },
    [footerHeight, controls]
  );

  const handleClick = useCallback(() => {
    if (movedDuringDrag.current) return;
    hapticLight();
    onTap();
  }, [onTap]);

  const fallbackColor = getFallbackColor(session.origin);
  const fallbackLetter = getFallbackLetter(session.origin);
  const showFavicon = !!session.favicon && !iconBroken;
  const hasSnapshot = !!snapshot;

  return (
    <motion.div
      animate={controls}
      drag
      dragMomentum={false}
      dragElastic={0.2}
      onDragStart={handleDragStart}
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
      onClick={handleClick}
      role="button"
      aria-label={`${session.title} dApp, double-tap to restore`}
      className="absolute left-0 top-0 flex h-16 w-16 cursor-grab items-center justify-center overflow-hidden rounded-full bg-pure-white shadow-[0_8px_24px_rgba(15,23,42,0.18),_0_2px_4px_rgba(15,23,42,0.08)] active:cursor-grabbing"
      style={{
        background: hasSnapshot ? `center/cover no-repeat url(${snapshot})` : fallbackColor,
        touchAction: 'none',
        WebkitTouchCallout: 'none',
        userSelect: 'none'
      }}
    >
      {!hasSnapshot && (
        <>
          {showFavicon ? (
            <img
              src={session.favicon ?? undefined}
              alt=""
              className="h-7 w-7 object-contain"
              onError={() => setIconBroken(true)}
              draggable={false}
            />
          ) : (
            <span className="text-xl font-semibold text-pure-white">{fallbackLetter}</span>
          )}
        </>
      )}
    </motion.div>
  );
};
