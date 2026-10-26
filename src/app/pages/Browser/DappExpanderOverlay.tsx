/**
 * The snapshot that carries a cold dApp from its peek card to the browser slot (#1817).
 *
 * A warm dApp's live page is moved by the native morph. A cold one has no page yet (it reloads on restore), and a
 * plugin that refused the morph shows the page without one, so here the parked snapshot makes the trip instead. The
 * element is slot-sized and moves only by transform and opacity, which the compositor runs off the main thread; it
 * unmounts on its own finish, onto DappActive's identical loading snapshot. Its spring is sampled keyframes with
 * linear timing between stops. Under reduced motion, or when the existing capability gate is closed, it renders
 * nothing.
 */

import React, { type FC, useLayoutEffect, useMemo, useRef } from 'react';

import { useReducedMotion } from 'framer-motion';
import { createPortal } from 'react-dom';

import { springKeyframeStops, springs, supportsLinearEasing } from 'lib/animation';
import { getFallbackColor } from 'lib/dapp-browser';
import { boostRefreshRate } from 'lib/mobile/high-refresh-rate';

import type { SlotRect } from './peek-target-rect';

interface DappExpanderOverlayProps {
  /** The card the restore started on, in viewport CSS px. */
  sourceRect: SlotRect;
  /** The slot the page will fill. */
  targetRect: SlotRect;
  /** The parked snapshot data URL, or null if none was captured. */
  snapshot: string | null;
  /** Origin for the fallback brand colour, used without a snapshot. */
  origin: string;
  /** The motion finished, or there is none to play. */
  onDone: () => void;
}

// The spring is solved in thousandths of the path, so its settle threshold (half a unit) sits at 0.05%.
const PATH_UNITS = 1000;

export const DappExpanderOverlay: FC<DappExpanderOverlayProps> = ({
  sourceRect,
  targetRect,
  snapshot,
  origin,
  onDone
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const reduceMotion = useReducedMotion();
  // The capability gate this path always had; the keyframes themselves do not need linear().
  const spring = useMemo(
    () =>
      reduceMotion || !supportsLinearEasing()
        ? null
        : springKeyframeStops(springs.morphExpand, { distance: -PATH_UNITS }),
    [reduceMotion]
  );

  useLayoutEffect(() => {
    const element = ref.current;
    if (!spring || !element) {
      onDoneRef.current();
      return;
    }
    boostRefreshRate(spring.duration);
    const dx = sourceRect.x - targetRect.x;
    const dy = sourceRect.y - targetRect.y;
    const scaleFrom = sourceRect.width / targetRect.width;
    // Scaled to the card's width the slot-shaped snapshot is taller than the card, so it fades in over the first
    // quarter of the path rather than showing its overhang.
    const animation = element.animate(
      spring.stops.map(({ offset, progress }) => {
        const scale = scaleFrom + (1 - scaleFrom) * progress;
        const transform =
          progress === 1 ? 'none' : `translate(${dx * (1 - progress)}px, ${dy * (1 - progress)}px) scale(${scale})`;
        return { transform, opacity: Math.min(1, Math.max(0, progress / 0.25)), offset };
      }),
      { duration: spring.duration, easing: 'linear', fill: 'forwards' }
    );
    animation.onfinish = () => onDoneRef.current();
    return () => animation.cancel();
    // Played once per mount: the rects are where this restore started and ended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!spring) return null;
  const fallbackColor = getFallbackColor(origin);
  return createPortal(
    <div
      ref={ref}
      data-testid="dapp-expander-overlay"
      className="pointer-events-none fixed overflow-hidden"
      style={{
        left: targetRect.x,
        top: targetRect.y,
        width: targetRect.width,
        height: targetRect.height,
        // Over the tray (65), under HOST_MODAL_LAYER (z-80): a confirmation must never hide beneath it.
        zIndex: 70,
        transformOrigin: '0 0',
        opacity: 0,
        backgroundImage: snapshot ? `url(${snapshot})` : undefined,
        backgroundColor: snapshot ? undefined : fallbackColor,
        backgroundSize: 'cover',
        backgroundPosition: 'top center'
      }}
    />,
    document.body
  );
};
