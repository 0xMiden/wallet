/**
 * A single peek card in the parked-dApps tray.
 *
 * Replaces the old 72pt floating bubble with a portrait mini-card that
 * looks like a shrunken phone screen — much closer to the iOS App
 * Switcher aesthetic. The card renders:
 *  - The parked session's snapshot filling the background (object-cover,
 *    top-aligned so the viewport the user last saw is what shows).
 *  - A dark bottom gradient for text contrast on any page color.
 *  - A favicon + truncated display name docked at the bottom-left.
 *  - A small × close button at the top-right (frontmost card only).
 *  - An optional "+N" badge at the top-left when there are more parked
 *    sessions than the tray can show at once. Tapping the badge opens
 *    the fullscreen switcher.
 *
 * The card is positioned by its parent (`<DappPeekTray>`), which
 * cascades siblings from the right edge with diminishing scale so the
 * stack looks like a real deck.
 *
 * Gestures (front card only):
 *  - Tap: restore this session (delegates to onTap).
 *  - Swipe UP (offset < -60 or velocity < -450): restore with a
 *    "shuffled out of the deck" exit animation — the card scales up
 *    ~4× and flies toward the center while the native webview takes
 *    over behind it. Feels like pulling a card off a deck and fanning
 *    it to full size.
 *  - Swipe DOWN (offset > 60 or velocity > 450): close this session.
 *    Matches the minimize gesture's downward direction so "park" and
 *    "dismiss from tray" share a visual language.
 *  - Drag then release below the threshold: spring back to origin.
 */

import React, { type FC, useRef, useState } from 'react';

import { type PanInfo, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { springs } from 'lib/animation';
import { type DappSession, getDappDisplayName, getFallbackColor, getFallbackLetter } from 'lib/dapp-browser';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';

export const CARD_WIDTH = 104;
export const CARD_HEIGHT = 132;
/**
 * Per-step horizontal offset between stacked cards. With CARD_WIDTH=104 and
 * a 30pt offset, each card behind the front one shows about 30pt of its
 * right edge — enough to read the favicon + a truncated word.
 */
export const CARD_STACK_OFFSET = 30;

// Swipe thresholds: release the drag with offset OR velocity past either
// number to commit the gesture. The velocity floor lets a quick flick
// commit even if the finger didn't travel far.
const SWIPE_OFFSET_THRESHOLD = 60;
const SWIPE_VELOCITY_THRESHOLD = 450;

interface DappPeekCardProps {
  session: DappSession;
  snapshot?: string;
  /** 0 = frontmost (rightmost), higher = further back in the stack. */
  stackIndex: number;
  /** Overflow count rendered as "+N" on the frontmost card only. */
  overflowCount?: number;
  /** Whether this specific card is being restored and should fade out
   *  in-place while the ExpanderOverlay takes over. */
  isExpanding?: boolean;
  /**
   * Whether this card is the landing target of a minimize-shrink
   * animation in progress. When true, the card skips its entry
   * animation and snaps directly to its steady state — it sits
   * invisible (covered by the shrinking overlay above it) until the
   * overlay unmounts, at which point the user sees the card already
   * in position with no bounce-in jank.
   */
  isShrinking?: boolean;
  /**
   * Called when a restore gesture commits (tap or swipe up). The callback
   * receives the card's current DOM rect so the tray can render an
   * `ExpanderOverlay` that flies from exactly the card's position to
   * fullscreen. Also called for back-card taps (where `sourceRect` is
   * still meaningful since the tap originates from their visible slice).
   */
  onCommitRestore: (sourceRect: DOMRect) => void;
  onClose: () => void;
  onShowAll: () => void;
  /**
   * Called when a horizontal swipe gesture commits on the front card.
   * 'left' → advance to next card in the deck (rotate forward).
   * 'right' → retreat to previous card (rotate backward). Only wired
   * up on the frontmost card since back cards are partially hidden
   * and can't reliably hit their own drag handler.
   */
  onNavigate?: (direction: 'left' | 'right') => void;
}

export const DappPeekCard: FC<DappPeekCardProps> = ({
  session,
  snapshot,
  stackIndex,
  overflowCount = 0,
  isExpanding = false,
  isShrinking = false,
  onCommitRestore,
  onClose,
  onShowAll,
  onNavigate
}) => {
  const { t } = useTranslation();
  const [faviconBroken, setFaviconBroken] = useState(false);
  // `exitMode` drives which exit animation AnimatePresence plays when
  // this card unmounts. We set it synchronously on commit inside the
  // swipe handlers so that the next render (triggered by the parent
  // state change a microtask later) captures the right exit variant.
  //   - 'default': regular park/unmount exit (drop down + fade, used
  //     when a card silently leaves the tray, e.g. the user closed it
  //     from the fullscreen switcher).
  //   - 'close': downward dismissal. Card continues its drag motion
  //     further down and fades.
  // (Restore is no longer an exit variant — the tray's ExpanderOverlay
  // takes over as the card fades out in-place.)
  const [exitMode, setExitMode] = useState<'default' | 'close'>('default');
  // Ref so the tap handler can distinguish a real tap from a click
  // event that fires at the end of a drag gesture. framer-motion's
  // drag events don't automatically suppress the synthesized click on
  // the underlying <button>, so we track movement ourselves.
  const wasDraggedRef = useRef(false);
  // The outer motion.div. We need its current bounding rect at the
  // moment a restore gesture commits so the ExpanderOverlay can start
  // at exactly the card's position — otherwise there's a visible jump
  // between where the user was touching and where the expand begins.
  const rootRef = useRef<HTMLDivElement>(null);

  const commitRestore = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      onCommitRestore(rect);
    }
  };

  const displayName = getDappDisplayName(session);
  const fallbackColor = getFallbackColor(session.origin);
  const fallbackLetter = getFallbackLetter(session.origin);
  const showFavicon = !!session.favicon && !faviconBroken;
  const isFront = stackIndex === 0;

  // Stack tuning: each card behind the front one slides LEFT and scales
  // DOWN slightly, producing a cascading deck look. The scale falloff is
  // gentle (6% per step) so back cards remain recognizable as cards, not
  // just edge slivers.
  const xOffset = -stackIndex * CARD_STACK_OFFSET;
  const scale = 1 - stackIndex * 0.06;
  const opacity = 1 - stackIndex * 0.12;

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    hapticLight();
    setExitMode('close');
    // Defer the parent state mutation so React has a chance to flush
    // the setExitMode update into the next render — without this, the
    // component can unmount with the previous (default) exit variant.
    setTimeout(onClose, 0);
  };

  const handleShowAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    hapticLight();
    onShowAll();
  };

  const handleTap = () => {
    if (wasDraggedRef.current) {
      // Synthesized click at the end of a drag — ignore so the tap
      // doesn't double-fire the restore that the swipe handler
      // already committed.
      wasDraggedRef.current = false;
      return;
    }
    hapticLight();
    commitRestore();
  };

  // Only the front card is draggable. Back cards are partially hidden
  // behind the front one, so drag interactions on them would be
  // confusing (which card is the user dragging?) and they can't
  // reliably hit their own tap target anyway.
  const handleDragStart = () => {
    wasDraggedRef.current = false;
  };

  const handleDrag = (_: unknown, info: PanInfo) => {
    // Any non-trivial motion counts as a drag so the post-drag click
    // event is suppressed. 4pt tolerance absorbs tap jitter.
    if (Math.abs(info.offset.x) + Math.abs(info.offset.y) > 4) {
      wasDraggedRef.current = true;
    }
  };

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    const dx = info.offset.x;
    const dy = info.offset.y;
    const vx = info.velocity.x;
    const vy = info.velocity.y;
    // framer-motion's `dragDirectionLock` zeroes the non-dominant axis
    // once a lock is established, so at drag end only one of {dx, dy}
    // has meaningful motion. We still fall back to comparing absolute
    // values in case the lock never triggered (extremely short drag).
    const isVerticalDrag = Math.abs(dy) >= Math.abs(dx);
    if (isVerticalDrag) {
      // Up: restore via the ExpanderOverlay fly-out.
      if (dy < -SWIPE_OFFSET_THRESHOLD || vy < -SWIPE_VELOCITY_THRESHOLD) {
        hapticMedium();
        commitRestore();
        return;
      }
      // Down: close with a continuation-of-drag fade.
      if (dy > SWIPE_OFFSET_THRESHOLD || vy > SWIPE_VELOCITY_THRESHOLD) {
        hapticMedium();
        setExitMode('close');
        setTimeout(onClose, 0);
        return;
      }
    } else {
      // Left/right: navigate the deck (rotate which card is active).
      // Only the front card has onNavigate wired; back cards don't.
      if (onNavigate && (dx < -SWIPE_OFFSET_THRESHOLD || vx < -SWIPE_VELOCITY_THRESHOLD)) {
        hapticLight();
        onNavigate('left');
        setTimeout(() => {
          wasDraggedRef.current = false;
        }, 100);
        return;
      }
      if (onNavigate && (dx > SWIPE_OFFSET_THRESHOLD || vx > SWIPE_VELOCITY_THRESHOLD)) {
        hapticLight();
        onNavigate('right');
        setTimeout(() => {
          wasDraggedRef.current = false;
        }, 100);
        return;
      }
    }
    // Below threshold — framer-motion's drag constraints (top/bottom/
    // left/right = 0) spring the card back to its resting position
    // automatically. Clear the drag flag after a short delay so the
    // tap-vs-click discriminator lets a subsequent real click through.
    setTimeout(() => {
      wasDraggedRef.current = false;
    }, 100);
  };

  // Exit variant resolver. The default (non-gesture) exit just drops
  // the card down a bit and fades — used when the parked-sessions
  // array shrinks from somewhere other than this card's own gesture.
  // For a swipe-down close, the card continues its downward motion.
  const exitVariant =
    exitMode === 'close'
      ? {
          opacity: 0,
          y: 180,
          scale: scale * 0.85,
          transition: { duration: 0.32, ease: [0.4, 0, 1, 1] as [number, number, number, number] }
        }
      : { opacity: 0, y: 40, scale: scale * 0.9 };

  // When this card is the one being restored, the tray's ExpanderOverlay
  // is growing from its position to fullscreen. We fade the card to 0
  // opacity in-place so it doesn't visually collide with the expander,
  // while keeping the motion.div mounted until the parent filters it
  // out (a tick later, once `restore()` removes it from parkedSessions).
  const animatedOpacity = isExpanding ? 0 : opacity;

  return (
    <motion.div
      ref={rootRef}
      // Animate layout so cards reflow smoothly when siblings are added
      // or removed (e.g. park a new dApp → existing cards slide left to
      // make room for the new frontmost card on the right).
      layout
      // When this card is the landing target of a shrink animation, skip
      // the entry animation entirely (`initial={false}` tells framer-
      // motion to start at the animate values). The shrinking overlay
      // sits on top of the card throughout the morph, so the card would
      // otherwise play its bounce-in under the overlay and be caught
      // mid-spring the moment the overlay fades out. Skipping entry
      // means when the overlay lands the card is already at its
      // resting pose, producing a seamless handoff.
      initial={isShrinking ? false : { opacity: 0, y: 40, scale: scale * 0.9 }}
      animate={{ opacity: animatedOpacity, x: xOffset, y: 0, scale }}
      exit={exitVariant}
      transition={isExpanding ? { duration: 0.15 } : springs.sheetPresent}
      // Front card is draggable in 2D with direction lock:
      //   - Vertical drag: up = restore, down = close (existing behavior).
      //   - Horizontal drag: left/right = navigate the deck (rotate
      //     which card is active).
      // `dragDirectionLock` commits to one axis after the first ~3pt
      // of motion so diagonal drags don't fire both handlers. Zero-
      // sized constraints + elastic pull mean the card springs back
      // to origin on release-below-threshold in either axis.
      drag={isFront && !isExpanding && !isShrinking ? true : false}
      dragDirectionLock
      dragConstraints={{ top: 0, bottom: 0, left: 0, right: 0 }}
      dragElastic={0.5}
      dragMomentum={false}
      onDragStart={handleDragStart}
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
      // Each card sits at the right edge; the negative x from animate()
      // stacks the back cards leftward.
      className="pointer-events-auto absolute bottom-0 right-0 origin-bottom-right"
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        // Back cards render below front cards so the front overlaps.
        zIndex: 100 - stackIndex
      }}
    >
      <button
        type="button"
        onClick={handleTap}
        aria-label={t('restoreDappCard', { name: displayName }) ?? `Restore ${displayName}`}
        className="group relative block h-full w-full overflow-hidden rounded-2xl bg-white"
        style={{
          // Layered shadow: tight contact + wide soft halo with a subtle
          // brand-color tint picked from the dApp's fallback color. Gives
          // each card a faint aura that hints at identity even before
          // the user reads the label.
          boxShadow: `0 1px 2px rgba(15,23,42,0.18), 0 10px 28px rgba(15,23,42,0.2), 0 14px 36px ${fallbackColor}40`
        }}
      >
        {/* Snapshot layer — top-anchored so the frozen preview shows
            the viewport the user was last looking at. Falls back to a
            colored tile with the dApp's first letter when no snapshot
            exists yet (fresh cold session or first park before the
            snapshot store has settled). */}
        {snapshot ? (
          <img
            src={snapshot}
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top"
            draggable={false}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: fallbackColor }}>
            <span className="text-3xl font-bold text-pure-white">{fallbackLetter}</span>
          </div>
        )}

        {/* Subtle top highlight + bottom gradient for contrast. The
            bottom gradient is tall enough (40% of card height) to
            guarantee legible white text on any page color. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-black/85 via-black/40 to-transparent" />

        {/* Label row — favicon + display name docked at the bottom-left. */}
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 px-2 pb-2">
          <div className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-[3px] bg-pure-white/95">
            {showFavicon ? (
              <img
                src={session.favicon ?? undefined}
                alt=""
                className="h-full w-full object-contain"
                onError={() => setFaviconBroken(true)}
              />
            ) : (
              <span className="text-[8px] font-bold" style={{ color: fallbackColor }}>
                {fallbackLetter}
              </span>
            )}
          </div>
          <span className="min-w-0 truncate text-[11px] font-semibold leading-tight text-pure-white drop-shadow">
            {displayName}
          </span>
        </div>
      </button>

      {/* Close — top right. Front card only so back cards aren't
          littered with tiny tap targets the user can't hit reliably. */}
      {isFront && (
        <button
          type="button"
          onClick={handleClose}
          aria-label={t('closeDappCard', { name: displayName }) ?? `Close ${displayName}`}
          className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm transition-transform active:scale-90"
        >
          <Icon name={IconName.Close} size="xs" className="text-pure-white" fill="currentColor" />
        </button>
      )}

      {/* Overflow "+N" — front card only, top-left. Tapping opens the
          fullscreen switcher where every parked session is browsable. */}
      {isFront && overflowCount > 0 && (
        <button
          type="button"
          onClick={handleShowAll}
          aria-label={t('showAllDapps', { count: overflowCount }) ?? `+${overflowCount} more`}
          className="absolute left-1.5 top-1.5 flex h-6 items-center rounded-full bg-black/60 px-2 backdrop-blur-sm transition-transform active:scale-95"
        >
          <span className="text-[10px] font-bold text-pure-white">+{overflowCount}</span>
        </button>
      )}
    </motion.div>
  );
};
