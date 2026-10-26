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

import { type PanInfo, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import type { MorphVelocity } from '@miden/dapp-browser';
import { Icon, IconName } from 'app/icons/v2';
import { MORPH_TIMING, springs } from 'lib/animation';
import { type DappSession, getDappDisplayName, getFallbackColor, getFallbackLetter } from 'lib/dapp-browser';
import { prepareMorph } from 'lib/dapp-browser/morph-boost';
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
  /**
   * Whether a collapsing page is landing on this card: it skips its entry animation and rests under the page, so it is
   * already in place when the page hides.
   */
  isShrinking?: boolean;
  /**
   * Called when a restore gesture commits (tap or swipe up) with the card's current DOM rect, where the native morph
   * starts, and the release velocity in CSS px per second (zero for a tap).
   */
  onCommitRestore: (sourceRect: DOMRect, velocity: MorphVelocity) => void;
  /** False while the native page covers this card; its chrome fades in when this turns true. */
  chromeVisible?: boolean;
  /** Leave without the exit animation: the native page has already taken the card's place. */
  exitInstantly?: boolean;
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
  isShrinking = false,
  chromeVisible = true,
  exitInstantly = false,
  onCommitRestore,
  onClose,
  onShowAll,
  onNavigate
}) => {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion() === true;
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

  const commitRestore = (velocity: MorphVelocity) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      onCommitRestore(rect, velocity);
    }
  };
  // The card's gradient, label, buttons and outer shadow layers; the contact shadow the native morph lands with stays.
  const chromeStyle: React.CSSProperties = {
    opacity: chromeVisible ? 1 : 0,
    transition: chromeVisible && !reduceMotion ? `opacity ${MORPH_TIMING.chromeFadeMs}ms ease-out` : 'none',
    pointerEvents: chromeVisible ? undefined : 'none'
  };
  // Hidden controls also leave the focus order and the accessibility tree; React 18 drops a boolean `inert`.
  const inertWhen = (hidden: boolean) => (hidden ? { 'aria-hidden': true, inert: '' } : {});
  const hiddenChromeControl = inertWhen(!chromeVisible);
  // Once its page has taken its place the card takes no input until it unmounts. Under a collapse it stays live:
  // a restore then reverses the collapse.
  const prepareRestore = () => {
    if (!exitInstantly) void prepareMorph(session.id);
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
    if (exitInstantly) return;
    hapticLight();
    setExitMode('close');
    // Defer the parent state mutation so React has a chance to flush
    // the setExitMode update into the next render — without this, the
    // component can unmount with the previous (default) exit variant.
    setTimeout(onClose, 0);
  };

  const handleShowAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (exitInstantly) return;
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
    if (exitInstantly) return;
    // The restore's morph command goes to native first; the haptic does not have to precede it.
    commitRestore({ x: 0, y: 0 });
    hapticLight();
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
    if (exitInstantly) {
      setTimeout(() => {
        wasDraggedRef.current = false;
      }, 100);
      return;
    }
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
      // Up: restore, handing the release velocity to the native morph.
      if (dy < -SWIPE_OFFSET_THRESHOLD || vy < -SWIPE_VELOCITY_THRESHOLD) {
        commitRestore({ x: vx, y: vy });
        hapticMedium();
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
  const exitVariant = exitInstantly
    ? { opacity: 0, transition: { duration: 0 } }
    : exitMode === 'close'
      ? {
          opacity: 0,
          y: 180,
          scale: scale * 0.85,
          transition: { duration: 0.32, ease: [0.4, 0, 1, 1] as [number, number, number, number] }
        }
      : { opacity: 0, y: 40, scale: scale * 0.9 };

  return (
    <motion.div
      ref={rootRef}
      // Animate layout so cards reflow smoothly when siblings are added
      // or removed (e.g. park a new dApp → existing cards slide left to
      // make room for the new frontmost card on the right).
      layout
      // A collapsing page covers its landing card for the whole morph, so the card skips its bounce-in
      // (`initial={false}` starts at the animate values) and is at rest when the page hides over it.
      initial={isShrinking ? false : { opacity: 0, y: 40, scale: scale * 0.9 }}
      animate={{ opacity, x: xOffset, y: 0, scale }}
      exit={exitVariant}
      transition={springs.sheetPresent}
      // Front card is draggable in 2D with direction lock:
      //   - Vertical drag: up = restore, down = close (existing behavior).
      //   - Horizontal drag: left/right = navigate the deck (rotate
      //     which card is active).
      // `dragDirectionLock` commits to one axis after the first ~3pt
      // of motion so diagonal drags don't fire both handlers. Zero-
      // sized constraints + elastic pull mean the card springs back
      // to origin on release-below-threshold in either axis.
      drag={isFront && !isShrinking && !exitInstantly}
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
      {...inertWhen(exitInstantly)}
    >
      {/* Layered shadow: tight contact + wide soft halo with a subtle brand-color tint picked from the dApp's
          fallback color, a faint aura that hints at identity. The middle layer is the button's own: it is the
          shadow the native morph draws, so only these two fade in after the handoff. */}
      <div
        data-peek-chrome=""
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{ ...chromeStyle, boxShadow: `0 1px 2px rgba(15,23,42,0.18), 0 14px 36px ${fallbackColor}40` }}
      />
      <button
        type="button"
        // A tap or a swipe up can restore, so the frame rate rises with the finger, and again on a slow drag's release.
        onPointerDown={prepareRestore}
        onPointerUp={prepareRestore}
        onClick={handleTap}
        aria-label={t('restoreDappCard', { name: displayName })}
        data-testid="dapp-peek-card"
        data-dapp-id={session.id}
        data-dapp-url={session.url}
        className="group relative block h-full w-full overflow-hidden rounded-2xl bg-white"
        style={{ boxShadow: '0 10px 28px rgba(15,23,42,0.2)' }}
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
        <div
          data-peek-chrome=""
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-pure-black/85 via-pure-black/40 to-transparent"
          style={chromeStyle}
        />

        {/* Label row — favicon + display name docked at the bottom-left. */}
        <div
          data-peek-chrome=""
          className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 px-2 pb-2"
          style={chromeStyle}
        >
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
          <span className="min-w-0 truncate text-[11px] font-semibold leading-tight text-pure-white [filter:drop-shadow(0_1px_2px_rgb(0_0_0_/_0.1))_drop-shadow(0_1px_1px_rgb(0_0_0_/_0.06))]">
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
          aria-label={t('closeDappCard', { name: displayName })}
          data-testid="dapp-peek-card-close"
          data-peek-chrome=""
          style={chromeStyle}
          {...hiddenChromeControl}
          className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-pure-black/55 [backdrop-filter:blur(8px)] [-webkit-backdrop-filter:blur(8px)] transition-transform active:scale-90"
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
          aria-label={t('showAllDapps', { count: overflowCount })}
          data-testid="dapp-peek-show-all"
          data-peek-chrome=""
          style={chromeStyle}
          {...hiddenChromeControl}
          className="absolute left-1.5 top-1.5 flex h-6 items-center rounded-full bg-pure-black/60 px-2 [backdrop-filter:blur(8px)] [-webkit-backdrop-filter:blur(8px)] transition-transform active:scale-95"
        >
          <span className="text-[10px] font-bold text-pure-white">
            {t('dappPeekCardOverflowBadge', { count: overflowCount })}
          </span>
        </button>
      )}
    </motion.div>
  );
};
