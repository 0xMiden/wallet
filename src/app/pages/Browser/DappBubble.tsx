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

import { motion, useAnimationControls, useReducedMotion } from 'framer-motion';

import { resolveTransition, springs } from 'lib/animation';
import { type DappSession, getFallbackColor, getFallbackLetter } from 'lib/dapp-browser';
import { hapticBubbleAttach, hapticLight } from 'lib/mobile/haptics';

interface DappBubbleProps {
  session: DappSession;
  /** Snapshot data URL captured at park time, or undefined to use the fallback. */
  snapshot?: string;
  /** Footer height in CSS pixels — used to compute the bottom safe-corner offset. */
  footerHeight: number;
  /**
   * PR-5 multi-bubble polish: zero-based index within a corner stack. Used
   * to offset the initial position so multiple bubbles are visually
   * distinguishable rather than overlapping perfectly. The user can still
   * drag any bubble independently — the offset only determines the
   * starting layout. Defaults to 0 (no offset) for single-bubble cases.
   */
  stackIndex?: number;
  onTap: () => void;
}

const SIZE = 64;
const EDGE_PADDING = 16;
/**
 * PR-5 multi-bubble polish: when N bubbles share a corner, each gets a
 * 12px diagonal offset from the next so they're all visible. The drag
 * gesture is unaffected — once a bubble is dragged it snaps to whichever
 * corner it ends up nearest.
 */
const STACK_OFFSET = 12;

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

/**
 * PR-5 multi-bubble polish: compute the initial position for a bubble at
 * a given stack index. The bottom-right corner is the default; each
 * stack index shifts the bubble STACK_OFFSET pixels toward the upper-left
 * (away from the corner) so a stack of N bubbles cascades visibly.
 */
function computeStackedInitialPosition(footerHeight: number, stackIndex: number): Corner {
  const corners = computeCorners(footerHeight);
  const base = corners[3] ?? { x: 0, y: 0 }; // bottom-right
  const offset = stackIndex * STACK_OFFSET;
  return {
    x: base.x - offset,
    y: base.y - offset
  };
}

export const DappBubble: FC<DappBubbleProps> = ({ session, snapshot, footerHeight, stackIndex = 0, onTap }) => {
  const controls = useAnimationControls();
  const [iconBroken, setIconBroken] = useState(false);
  const dragStartedAt = useRef<{ x: number; y: number; time: number } | null>(null);
  const movedDuringDrag = useRef(false);
  // PR-7: cache the reduce-motion preference in a ref so event handlers
  // (which can't call hooks) can still reach the current value. Each
  // `controls.start({ transition })` call below routes through
  // `resolveTransition` to collapse springs to instant tweens when the
  // user has reduced motion on.
  const reduceMotion = useReducedMotion();
  const reduceMotionRef = useRef(reduceMotion);
  useEffect(() => {
    reduceMotionRef.current = reduceMotion;
  }, [reduceMotion]);
  // Anchor in CSS pixels (top-left of the bubble). Default corner is
  // bottom-right; the stackIndex shifts the initial position diagonally
  // toward the screen center so multiple bubbles in the same corner are
  // all visible.
  const positionRef = useRef<Corner>(computeStackedInitialPosition(footerHeight, stackIndex));

  // Pop-in animation: scale 0 → 1 with overshoot.
  useEffect(() => {
    const initial = computeStackedInitialPosition(footerHeight, stackIndex);
    positionRef.current = initial;
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
        transition: resolveTransition(reduceMotionRef.current, springs.magnetic)
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
      controls
        .start({
          x: snap.x,
          y: snap.y,
          transition: resolveTransition(reduceMotionRef.current, springs.standard)
        })
        .catch(() => {});
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
          transition: resolveTransition(reduceMotionRef.current, springs.magnetic)
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

  // PR-7: aria-label reads better as an affordance description. Screen
  // reader users map "activate" (double-tap) to the button role
  // automatically, so we just state what the button does.
  const displayName = session.title || session.origin;
  const ariaLabel = `${displayName}, parked dApp. Activate to restore.`;

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
      tabIndex={0}
      aria-label={ariaLabel}
      aria-roledescription="draggable bubble"
      onKeyDown={e => {
        // Keyboard activation for external-keyboard users + screen reader
        // shortcut keys that don't synthesize click events.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
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
