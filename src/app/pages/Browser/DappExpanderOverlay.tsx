/**
 * The "shuffled out of the deck" expand animation.
 *
 * Rendered transiently by `<DappPeekTray>` the moment a restore gesture
 * commits on a peek card. This element is the visual bridge between the
 * small card (at the bottom-right of the tray) and the full-screen dApp
 * webview that's about to take over: a fixed-position div that starts
 * at exactly the card's bounding rect and animates out to fill the
 * viewport, with the parked snapshot displayed as an object-cover
 * background so the user sees the same image zoom from chip to
 * full-screen.
 *
 * By the time the overlay reaches its final size, the provider has
 * called `restore()` on the underlying session and the native WKWebView
 * is already rising in its UIWindow behind us. The overlay then fades
 * out over a short tail and unmounts, revealing the real webview. The
 * whole sequence feels like the card was lifted off the deck and
 * slammed to full focus.
 *
 * Why a dedicated overlay vs. animating the card itself:
 *  - The card lives inside a fixed-width positioning box in the tray.
 *    Scaling it up inside that box clips against the parent rect.
 *  - Using transforms to grow the card distorts the snapshot because
 *    card and viewport have different aspect ratios — object-cover on
 *    the inner img only works when the container's width/height are
 *    actually animated (not faked via scale).
 *  - A separate overlay with explicit left/top/width/height animation
 *    lets the aspect ratio morph continuously from the card's 104×132
 *    to the viewport's 402×874 while the img stays crisp.
 */

import React, { type FC } from 'react';

import { motion } from 'framer-motion';
import { createPortal } from 'react-dom';

import { getFallbackColor } from 'lib/dapp-browser';

interface DappExpanderOverlayProps {
  /**
   * The rect the overlay animates FROM. For a restore (expand), this is
   * the source card's DOMRect captured at the moment the gesture
   * committed. For a minimize (shrink), this is the DappActive slot rect
   * (where the live webview was rendered). Using an absolute rect type
   * (not DOMRect) lets the caller pass either.
   */
  sourceRect: { x: number; y: number; width: number; height: number } | DOMRect;
  /** The parked snapshot data URL, or null if we never captured one. */
  snapshot: string | null;
  /** Origin for the fallback brand-color background (used if no snapshot). */
  origin: string;
  /**
   * The rect the overlay animates TO. For a restore, this is the slot
   * rect where the webview will render. For a minimize, this is the
   * frontmost peek card's final position in the tray.
   *
   * The aspect ratio of the non-card endpoint matters a LOT: the
   * snapshot is captured from the slot rect, so animating to any other
   * aspect ratio makes `background-size: cover` scale the image by
   * the larger dimension and crop, which is what causes the infamous
   * "text shrinks/grows at handoff" artifact. Pass the measured slot
   * rect here, not the viewport, for a clean handoff.
   */
  targetRect: { x: number; y: number; width: number; height: number };
  /**
   * Border radius the overlay starts at. Defaults to 16pt (matches the
   * peek card's 2xl rounded corners) for the expand case. Pass 0 for
   * a shrink so the overlay starts as a hard rect matching the
   * webview's (unrounded) slot.
   */
  initialBorderRadius?: number;
  /**
   * Border radius the overlay ends at. Defaults to 0 for expand
   * (becoming the hard-edged webview). Pass 16 for shrink (becoming
   * a rounded peek card).
   */
  finalBorderRadius?: number;
}

// Duration tuning:
//  - The whole expand takes ~390ms with a snappy ease-out curve so it
//    feels propelled (user gesture → response is immediate, settles
//    into position). Tightened from an earlier 580ms value that read
//    as sluggish; 390ms keeps all the morph readable but gets the
//    user to the live webview faster.
//  - Border radius morphs from 16pt (rounded card) to 0 (hard rect)
//    over the same duration, so the "card becomes app" illusion sells.
const EXPAND_DURATION_MS = 390;
const EXPAND_EASE = [0.2, 0.85, 0.25, 1] as const;

export const EXPAND_TOTAL_DURATION_MS = EXPAND_DURATION_MS;

export const DappExpanderOverlay: FC<DappExpanderOverlayProps> = ({
  sourceRect,
  snapshot,
  origin,
  targetRect,
  initialBorderRadius = 16,
  finalBorderRadius = 0
}) => {
  const fallbackColor = getFallbackColor(origin);
  // Normalize DOMRect → plain rect. DOMRect has `left/top`, plain rect
  // has `x/y`; accept both.
  const srcLeft = 'left' in sourceRect ? sourceRect.left : sourceRect.x;
  const srcTop = 'top' in sourceRect ? sourceRect.top : sourceRect.y;

  return createPortal(
    <motion.div
      className="pointer-events-none fixed overflow-hidden"
      initial={{
        left: srcLeft,
        top: srcTop,
        width: sourceRect.width,
        height: sourceRect.height,
        borderRadius: initialBorderRadius,
        opacity: 1
      }}
      animate={{
        left: targetRect.x,
        top: targetRect.y,
        width: targetRect.width,
        height: targetRect.height,
        borderRadius: finalBorderRadius,
        opacity: 1
      }}
      exit={{ opacity: 0 }}
      transition={{
        // left/top/width/height/borderRadius all ride the same ease-out
        // curve so the morph feels like one cohesive gesture. The tail
        // opacity fade is a shorter linear handoff during the last
        // ~80ms of the animation — too abrupt and you see a hard cut
        // to the webview; too slow and the overlay lingers visibly on
        // top of the already-loaded dApp.
        duration: EXPAND_DURATION_MS / 1000,
        ease: EXPAND_EASE
      }}
      style={{
        zIndex: 200,
        // Grow the drop shadow with the element so the card feels like
        // it's rising off the deck into focus. Slightly over-saturated
        // brand tint at the tail gives the expand a subtle glow.
        boxShadow: `0 20px 60px rgba(15,23,42,0.35), 0 0 120px ${fallbackColor}30`,
        // Display the snapshot as the background so the user sees the
        // same pixels they were looking at on the card, zooming from
        // card size to full-screen. object-cover with top alignment
        // matches the card's snapshot treatment — no visual seam.
        backgroundImage: snapshot ? `url(${snapshot})` : undefined,
        backgroundColor: snapshot ? undefined : fallbackColor,
        backgroundSize: 'cover',
        backgroundPosition: 'top center'
      }}
    />,
    document.body
  );
};
