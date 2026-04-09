/**
 * Right-anchored tray of "peek cards" representing every parked dApp.
 *
 * This replaces the original bottom-right bubble stack. The new tray is
 * modeled after the iOS App Switcher / Android Recents "peek" — portrait
 * mini-cards with snapshot backgrounds that cascade from the right edge
 * of the screen, just above the floating navbar pill.
 *
 * Why a tray instead of the old bubbles:
 *  - Bubbles carried no context beyond a cropped circle — users couldn't
 *    tell three dApps apart at a glance.
 *  - Stacked bubbles became an unreadable pile once 3+ were parked,
 *    forcing a "+N" escape hatch that hid most of the state.
 *  - Cards show the name and a usable snapshot thumbnail, so "which dApp
 *    is this?" is answerable without tapping anything.
 *
 * Layout:
 *  - Fixed to the bottom of the viewport, sitting directly above the
 *    floating native navbar. Positioning is driven by a live measurement
 *    of the React footer overlay (`[data-tabbar-footer="true"]`) so the
 *    tray adapts if the navbar gets taller or shorter.
 *  - Up to `MAX_VISIBLE_CARDS` cards render inline. Each card behind the
 *    front one is offset CARD_STACK_OFFSET pixels to the left and
 *    scaled down slightly; the rightmost (frontmost) card is fully
 *    visible and bears the close + overflow buttons.
 *  - When more than `MAX_VISIBLE_CARDS` sessions are parked, the card at
 *    index MAX_VISIBLE_CARDS-1 carries a "+N" badge that opens the
 *    fullscreen switcher as a browse-all escape hatch.
 *
 * `data-dapp-bubble-host="true"` on the outer element keeps the existing
 * `body[data-drawer-open]` CSS morph working — no main.css edits needed.
 * The tray slides down out of sight whenever a Settings drawer or the
 * new dApp actions sheet takes over the bottom of the screen.
 */

import React, { type FC, useCallback, useEffect, useRef, useState } from 'react';

import { AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';

import { useDappBrowser } from 'app/providers/DappBrowserProvider';
import { type DappSession } from 'lib/dapp-browser';
import { getSnapshot, subscribeSnapshots } from 'lib/dapp-browser/snapshot-store';

import { DappExpanderOverlay, EXPAND_TOTAL_DURATION_MS } from './DappExpanderOverlay';
import { CARD_HEIGHT, CARD_STACK_OFFSET, CARD_WIDTH, DappPeekCard } from './DappPeekCard';

// Fallback anchor distance from the bottom of the viewport. This
// accounts for the native navbar pill (~76pt) + its bottom gutter
// (~12pt) + the iPhone's home-indicator safe area inset (~34pt).
// Bumped above the old 110 so the tray clears the navbar pill
// comfortably; the old value sat with the card's bottom edge
// overlapping the top of the pill by ~10pt.
const FOOTER_HEIGHT_FALLBACK = 130;
// Minimum footer height we'll accept from a measurement. Below this
// we're almost certainly measuring the React footer DURING its brief
// pre-overlay render (it's 97pt at that moment before `display:none`
// kicks in), which would leave the tray too close to the navbar.
const MIN_MEASURED_FOOTER = 110;
const MAX_VISIBLE_CARDS = 3;
// Side padding from the right edge of the screen. 16pt matches the
// wallet's standard content gutter so the tray aligns with everything
// else visually.
const EDGE_PADDING = 16;

type MorphMode = 'expand' | 'shrink';

interface MorphingState {
  /**
   * `expand` = restore (card → slot rect, borderRadius 16→0).
   * `shrink` = minimize (slot rect → card position, borderRadius 0→16).
   * The ExpanderOverlay handles both by parametrizing its initial /
   * animate rects and border radii.
   */
  mode: MorphMode;
  session: DappSession;
  snapshot: string | null;
  sourceRect: { x: number; y: number; width: number; height: number };
  /**
   * Where the morph finishes. For expand this is the webview slot
   * rect; for shrink this is the frontmost peek card's final
   * position. Aspect ratios matter: the snapshot is captured from
   * the slot rect, so animating to any other aspect ratio makes
   * `background-size: cover` scale by the larger dimension and
   * crop, producing the "text shrinks at handoff" artifact.
   */
  targetRect: { x: number; y: number; width: number; height: number };
}

// Restore is called partway through the expand animation so the native
// webview rises at roughly the same moment the overlay reaches full
// size. Too early → the webview covers the mid-expand overlay and the
// illusion breaks. Too late → the overlay sits at full size waiting,
// showing a still snapshot while the user waits for the webview.
// 215ms (of a 390ms total, ~55%) lands the restore call near the point
// where the expander has covered ~70% of the screen.
const RESTORE_TRIGGER_DELAY_MS = 215;

// When the live slot rect isn't available (no dApp has been foregrounded
// this session yet AND nothing is cached), fall back to a computed slot
// that matches DappActive's layout. This needs three numbers:
//   - FALLBACK_CAPSULE_HEIGHT (145): safe-area-inset-top (~62) + the
//     capsule's drag handle + content row (83).
//   - FALLBACK_BOTTOM_GUTTER (34): safe-area-inset-bottom on devices
//     with a home indicator. The React footer gutter (88pt extra)
//     does NOT apply in the post-foreground state — that gets reset
//     by `body[data-native-navbar][data-dapp-foreground]` in main.css
//     — but at the moment we're computing the fallback, that attr
//     isn't set yet, so `document.body.clientHeight` still includes
//     the 88pt gutter. Subtract the bottom safe area directly as a
//     constant instead of trying to derive it from live CSS.
// These defaults are iPhone 17-class. Other devices differ slightly
// but the cache (populated the moment a dApp is foregrounded) covers
// every case after the first restore.
const FALLBACK_CAPSULE_HEIGHT = 145;
const FALLBACK_BOTTOM_GUTTER = 34;

function resolveTargetRect(liveSlotRect: { x: number; y: number; width: number; height: number } | null): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (liveSlotRect && liveSlotRect.width > 0 && liveSlotRect.height > 0) {
    return liveSlotRect;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: 0,
    y: FALLBACK_CAPSULE_HEIGHT,
    width: vw,
    height: vh - FALLBACK_CAPSULE_HEIGHT - FALLBACK_BOTTOM_GUTTER
  };
}

export const DappPeekTray: FC = () => {
  const { session: foregroundSession, parkedSessions, restore, close, openSwitcher, slotRect } = useDappBrowser();
  const [snapshotTick, setSnapshotTick] = useState(0);
  const [footerHeight, setFooterHeight] = useState(FOOTER_HEIGHT_FALLBACK);
  // The currently-morphing session (either expanding-to-restore or
  // shrinking-to-minimize). Cleared once the animation completes.
  const [morphing, setMorphing] = useState<MorphingState | null>(null);
  // Cyclic rotation pointer into `orderedAll` (the reversed parked list).
  // The session at `orderedAll[activeIndex]` becomes the frontmost card.
  // Swiping the front card left increments this (mod length) to rotate
  // the next card forward; swiping right decrements to go back.
  // Reset to 0 whenever a new session is parked so the freshly-minimized
  // dApp is always the front on arrival (and the shrink animation
  // lands on the right card).
  const [activeIndex, setActiveIndex] = useState(0);
  // Active timers we started for the morph sequence, so an unmount
  // during an animation doesn't leave dangling setTimeouts pointing
  // at stale state.
  const restoreTriggerTimerRef = useRef<number | null>(null);
  const morphClearTimerRef = useRef<number | null>(null);
  // Remember the last ground-truth slot rect the provider reported, so
  // subsequent restore gestures animate to the right place even after
  // the current foreground dApp is parked (which nulls the provider's
  // `slotRect`). Without this cache, the second and subsequent restores
  // would fall through to `resolveTargetRect`'s pure-fallback branch,
  // which is only approximately correct. This is also what we use as
  // the SOURCE rect for the shrink animation.
  const lastKnownSlotRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  // Track the previous foreground session id so we can detect the
  // transition from "foreground" to "parked" (i.e. a minimize) and
  // trigger the shrink overlay. Reactive signal, no extra provider
  // plumbing needed.
  const prevForegroundIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!slotRect || slotRect.width <= 0 || slotRect.height <= 0) return;
    // Debounce the cache write by 350ms so mid-transition measurements
    // don't stick. When the Browser tab is sliding in, DappActive
    // mounts with its ancestors mid-translateX (the tab's ~150ms
    // slide-in). The first ResizeObserver measurement returns
    // coordinates offset by that transform (~32pt too far right).
    // Without the debounce, that transient value gets cached and the
    // NEXT restore animation (which reads the cache) targets the
    // wrong rect — user-visible jump at handoff. DappActive schedules
    // a re-measure at 200ms and 400ms post-mount to catch the
    // settled rect; our 350ms debounce ensures that at least one of
    // those settled values wins and is what ends up in the cache.
    const t = window.setTimeout(() => {
      lastKnownSlotRectRef.current = {
        x: slotRect.x,
        y: slotRect.y,
        width: slotRect.width,
        height: slotRect.height
      };
    }, 350);
    return () => window.clearTimeout(t);
  }, [slotRect]);

  // Re-render when the snapshot store updates so freshly-captured
  // snapshots swap in without unmounting their card.
  useEffect(() => subscribeSnapshots(() => setSnapshotTick(tick => tick + 1)), []);

  // Measure the footer overlay so the tray sits just above it. On
  // mobile the React footer is hidden (display:none) as soon as the
  // native navbar UIWindow takes over, so the measured offsetHeight
  // is 0 during steady state — we fall back to FOOTER_HEIGHT_FALLBACK
  // in that case. We also reject any measurement below
  // MIN_MEASURED_FOOTER because the React footer briefly renders at
  // ~97pt before `display:none` kicks in, and that measurement would
  // otherwise stick and leave the tray overlapping the native pill.
  useEffect(() => {
    const measure = () => {
      const footer = document.querySelector('[data-tabbar-footer="true"]') as HTMLElement | null;
      const measured = footer?.offsetHeight ?? 0;
      const next = measured >= MIN_MEASURED_FOOTER ? measured : FOOTER_HEIGHT_FALLBACK;
      setFooterHeight(next);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Clean up any running morph timers on unmount so the setState
  // calls below don't fire against a stale component.
  useEffect(() => {
    return () => {
      if (restoreTriggerTimerRef.current != null) window.clearTimeout(restoreTriggerTimerRef.current);
      if (morphClearTimerRef.current != null) window.clearTimeout(morphClearTimerRef.current);
    };
  }, []);

  // Commit a restore (expand): freeze the card's position in state,
  // render the ExpanderOverlay (which flies from the source rect to
  // the slot rect), trigger the actual provider restore partway
  // through so the native webview arrives as the overlay reaches full
  // size, and finally clear the overlay state once the whole animation
  // has played out.
  const handleCommitRestore = useCallback(
    (session: DappSession, sourceRect: DOMRect) => {
      const snap = getSnapshot(session.id) ?? null;
      // Prefer the live slot rect (the current foreground dApp's rect,
      // if any) over the cached one (set by a previous foreground) over
      // the pure computed fallback (if neither is available yet).
      const targetRect = resolveTargetRect(slotRect ?? lastKnownSlotRectRef.current);
      setMorphing({
        mode: 'expand',
        session,
        snapshot: snap,
        sourceRect: { x: sourceRect.left, y: sourceRect.top, width: sourceRect.width, height: sourceRect.height },
        targetRect
      });
      // Kick the provider restore partway through the expand so the
      // webview is ready by the time the overlay is at full size.
      restoreTriggerTimerRef.current = window.setTimeout(() => {
        void restore(session.id);
        restoreTriggerTimerRef.current = null;
      }, RESTORE_TRIGGER_DELAY_MS);
      // Tear down the overlay after the full expand animation + a
      // short tail for the fade-out. Leaves a little buffer so the
      // native webview has definitely arrived before we unmount the
      // React-side visual.
      if (morphClearTimerRef.current != null) window.clearTimeout(morphClearTimerRef.current);
      morphClearTimerRef.current = window.setTimeout(() => {
        setMorphing(null);
        morphClearTimerRef.current = null;
      }, EXPAND_TOTAL_DURATION_MS + 100);
    },
    [restore, slotRect]
  );

  // Cards render newest-first so the dApp the user most recently
  // minimized is the frontmost card (closest to their thumb, unobscured,
  // obvious tap target). `parkedSessions` is kept in session-creation
  // order by the provider, so we reverse it here — the last-added
  // parked session lands at index 0 and becomes the front-of-deck.
  // Then we CYCLICALLY ROTATE by `activeIndex` so the user-selected
  // active card is at the front. Finally, slice to MAX_VISIBLE_CARDS
  // and pass the overflow count to the front card as a "+N" badge.
  const orderedAll = [...parkedSessions].reverse();
  const rotated =
    orderedAll.length > 0 && activeIndex > 0
      ? [...orderedAll.slice(activeIndex), ...orderedAll.slice(0, activeIndex)]
      : orderedAll;
  const visible = rotated.slice(0, MAX_VISIBLE_CARDS);
  // Overflow count stays independent of activeIndex (it's just the
  // cards that don't fit in the visible slice at any given time).
  const overflowCount = Math.max(0, rotated.length - MAX_VISIBLE_CARDS);

  // Reset the rotation pointer whenever a new session is parked, so
  // the newly-minimized dApp is always the front card (matches the
  // shrink animation's landing position, and is what the user expects
  // after hitting Minimize). Also clamp `activeIndex` if the list
  // shrinks below it (e.g. a session was closed from the switcher).
  const prevParkedLenRef = useRef(parkedSessions.length);
  useEffect(() => {
    const len = parkedSessions.length;
    if (len > prevParkedLenRef.current) {
      setActiveIndex(0);
    } else if (activeIndex >= len && len > 0) {
      setActiveIndex(0);
    } else if (len === 0 && activeIndex !== 0) {
      setActiveIndex(0);
    }
    prevParkedLenRef.current = len;
  }, [parkedSessions.length, activeIndex]);

  const handleNavigate = useCallback(
    (direction: 'left' | 'right') => {
      setActiveIndex(prev => {
        const len = orderedAll.length;
        if (len <= 1) return prev;
        // Swipe RIGHT → the card behind/below the current one moves
        // forward to become active (activeIndex advances). Swipe LEFT
        // rewinds to the previous active card. This matches the
        // physical metaphor: the front card slides right under the
        // finger and the next card emerges to take its place.
        if (direction === 'right') return (prev + 1) % len;
        return (prev - 1 + len) % len;
      });
    },
    [orderedAll.length]
  );

  // Width of the positioning box: front card is fully visible plus each
  // behind-card contributes CARD_STACK_OFFSET of left-side peek. This
  // lets us right-anchor the container without the back cards getting
  // clipped off the left edge of the viewport.
  const stackWidth = CARD_WIDTH + Math.max(0, visible.length - 1) * CARD_STACK_OFFSET;

  // Detect the foreground-dApp → parked transition that happens when
  // the user minimizes, and trigger the reverse (shrink) animation so
  // the soon-to-be card appears to be sucked back into the tray.
  //
  // Signal: the previous render had a foreground session id X, the
  // current render has no foreground session, AND X now lives in
  // parkedSessions. That's the minimize path.
  //
  // We use the cached slot rect as the source (the live slotRect is
  // already null by this point because DappActive unmounted on park).
  // Target is computed from the tray's known layout: the frontmost
  // card lands at the right edge, offset up by the footer clearance.
  //
  // Deliberately only fires when `lastKnownSlotRectRef` has a value
  // and a snapshot exists in the store — otherwise there's no visual
  // continuity to animate and it's better to just let the card
  // appear normally.
  useEffect(() => {
    const prevId = prevForegroundIdRef.current;
    const currentId = foregroundSession?.id ?? null;
    prevForegroundIdRef.current = currentId;
    // Only care about the transition away from a foreground session.
    if (!prevId || prevId === currentId) return;
    // Was it parked (as opposed to closed or a switcher swap)?
    const nowParked = parkedSessions.find(s => s.session.id === prevId);
    if (!nowParked) return;
    // Don't stomp an in-flight expand morph (e.g. the user chained a
    // restore gesture with a minimize somehow).
    if (morphing && morphing.session.id === prevId) return;
    const snap = getSnapshot(prevId) ?? null;
    const source = lastKnownSlotRectRef.current;
    if (!snap || !source) return;
    // Target: the frontmost card's final position in the tray.
    // Because we just reversed parkedSessions above and the newly-
    // minimized session was appended to the end of sessionStates
    // (→ first in the reversed list), it'll be at stackIndex 0
    // which renders at (right: 0, bottom: 0) within the tray's
    // positioning box. Convert to absolute viewport coords.
    const viewportW = document.body.clientWidth || window.innerWidth;
    const viewportH = document.body.clientHeight || window.innerHeight;
    const cardLeft = viewportW - EDGE_PADDING - CARD_WIDTH;
    const cardTop = viewportH - (footerHeight + 4) - CARD_HEIGHT;
    setMorphing({
      mode: 'shrink',
      session: nowParked.session,
      snapshot: snap,
      sourceRect: { x: source.x, y: source.y, width: source.width, height: source.height },
      targetRect: { x: cardLeft, y: cardTop, width: CARD_WIDTH, height: CARD_HEIGHT }
    });
    // Tear down the overlay once the shrink has played out.
    if (morphClearTimerRef.current != null) window.clearTimeout(morphClearTimerRef.current);
    morphClearTimerRef.current = window.setTimeout(() => {
      setMorphing(null);
      morphClearTimerRef.current = null;
    }, EXPAND_TOTAL_DURATION_MS + 50);
  }, [foregroundSession, parkedSessions, footerHeight, morphing]);

  // Portal the tray into `document.body` rather than letting it render
  // inside the wallet's React tree. The app's global layout CSS in
  // main.css applies `width: 100% !important; height: 100% !important`
  // to every `#root > div` so the main layout container fills the
  // viewport — but because the provider mounts this tray as a sibling
  // of its children, React ended up placing the tray's outer element
  // as a direct `#root > div` child too, and the `!important` rule
  // stretched it to the full screen, breaking fixed positioning.
  // Portalling sidesteps the whole selector match.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      data-dapp-bubble-host="true"
      className="pointer-events-none fixed"
      style={{
        // Position the tray so its bottom edge sits 4pt above the top
        // of the footer — a clean visible gap without overlapping the
        // navbar pill.
        bottom: footerHeight + 4,
        right: EDGE_PADDING,
        width: stackWidth,
        height: CARD_HEIGHT,
        zIndex: 65
      }}
      aria-hidden={parkedSessions.length === 0}
    >
      <div className="relative h-full w-full">
        <AnimatePresence>
          {visible.map((state, index) => (
            <DappPeekCard
              key={`peek-card-${state.session.id}-${snapshotTick}`}
              session={state.session}
              snapshot={getSnapshot(state.session.id) ?? undefined}
              stackIndex={index}
              // Pass the overflow count to the FRONT card only (index 0).
              // The front card is the most prominent and always fully
              // visible, so a "+N more" badge there reads cleanly. Back
              // cards only peek ~30pt so they're too cramped to host
              // additional chrome.
              overflowCount={index === 0 ? overflowCount : 0}
              // During an EXPAND morph for this card: fade it in place
              // so the expander appears to grow out of it directly.
              isExpanding={morphing?.mode === 'expand' && morphing.session.id === state.session.id}
              // During a SHRINK morph landing on this card: skip the
              // entry animation so the card sits at its steady state
              // under the shrinking overlay. When the overlay unmounts
              // the card is already in position, no bounce-in catching.
              isShrinking={morphing?.mode === 'shrink' && morphing.session.id === state.session.id}
              onCommitRestore={sourceRect => handleCommitRestore(state.session, sourceRect)}
              onClose={() => void close(state.session.id)}
              onShowAll={openSwitcher}
              // Only the front card (index 0) gets onNavigate. Back
              // cards can't reliably host a drag handler anyway because
              // the front card overlays their position. Disable nav
              // entirely when there's only one session — nothing to
              // rotate to.
              onNavigate={index === 0 && orderedAll.length > 1 ? handleNavigate : undefined}
            />
          ))}
        </AnimatePresence>
      </div>
      {/* Shared morph overlay — handles BOTH the restore (expand) and
          minimize (shrink) paths. Fixed-position portal element that
          morphs from `sourceRect` to `targetRect` with a border-radius
          interpolation between `initialBorderRadius` and
          `finalBorderRadius`. For an expand we go card→slot with
          borderRadius 16→0; for a shrink we go slot→card with
          borderRadius 0→16. Separate element so its geometry animation
          (left/top/width/height) doesn't interfere with the cards'
          transform-based entry/exit animations. */}
      {morphing && (
        <DappExpanderOverlay
          sourceRect={morphing.sourceRect}
          snapshot={morphing.snapshot}
          origin={morphing.session.origin}
          targetRect={morphing.targetRect}
          initialBorderRadius={morphing.mode === 'expand' ? 16 : 0}
          finalBorderRadius={morphing.mode === 'expand' ? 0 : 16}
        />
      )}
    </div>,
    document.body
  );
};
