import React, { FC, ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { animate, motion, useDragControls, useMotionValue, useReducedMotion } from 'framer-motion';

import Earn from 'app/pages/Earn';
import Explore from 'app/pages/Explore';
import { Receive } from 'app/pages/Receive';
import { resolveTransition, springToLinearEasing, springs } from 'lib/animation';
import { isSwapEnabled } from 'lib/feature-flags';
import { boostRefreshRate } from 'lib/mobile/high-refresh-rate';
import { useNavbarHidden } from 'lib/mobile/useNavbarHidden';
import { navigate, useLocation } from 'lib/woozie';
import { SendFlow } from 'screens/send-flow/SendManager';
import { SwapFlow } from 'screens/swap-flow/SwapManager';

/**
 * Carousel container that mounts the home-group pages (Overview / Send /
 * Receive / Earn / Swap) in a horizontal track and lets the user drag between
 * them with their finger. The page tracks the finger in real time and
 * snaps to the next/previous index on release if dragged or flicked past
 * a threshold; otherwise it snaps back.
 *
 * Pathname is the source of truth for which page is centered — the
 * SegmentedActionBar in TabLayout reads the same path and stays in sync
 * via its framer-motion layoutId pill.
 *
 * Earn ships unconditionally; only the Swap (isSwapEnabled) pane is
 * feature-gated and can be absent. Track length, page widths and the index
 * math all derive from the same filtered `pages` array, so the carousel stays
 * consistent no matter how many panes are present.
 */

interface HomePage {
  id: string;
  path: string;
  node: ReactNode;
}

// Commit threshold: how far (as a fraction of the page width) the user
// has to drag — accounting for fling velocity — to snap to the adjacent
// page. Anything short of this snaps back.
const COMMIT_THRESHOLD = 0.3;
// Velocity projection factor — how many milliseconds of post-release
// momentum to extrapolate when deciding whether to commit. Higher feels
// flickier; lower feels stickier.
const VELOCITY_PROJECTION_MS = 300;
// Momentum factor framer uses to project a release into a coasting distance
// (`origin + power * velocity`). Only the projection depends on it, since
// `modifyTarget` replaces that distance with a page boundary.
const DRAG_POWER = 0.8;

/**
 * Where the track actually is on screen right now.
 *
 * While a compositor release is running it owns the element's transform, and the
 * animated value only shows up in the computed style — the inline style still
 * holds whatever framer last wrote. Reading this forces a style recalc, so only
 * do it on discrete events (a release ending, a finger landing), never per frame.
 */
function readTranslateX(el: HTMLElement): number {
  const { transform } = getComputedStyle(el);
  if (!transform || transform === 'none') return 0;
  return new DOMMatrixReadOnly(transform).m41;
}

/**
 * Mirrors framer's own `isElementTextInput`, the predicate it uses to decide a
 * drag may not start. Kept in step with it deliberately: this file overrides
 * that decision for touch, and an override has to test the same thing.
 */
const TEXT_INPUT_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (TEXT_INPUT_TAGS.has(target.tagName) || target.isContentEditable);
}

const HomeSwipeContainer: FC = () => {
  const { pathname } = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const [width, setWidth] = useState(0);
  // #481 — lock the horizontal carousel swipe whenever a focused sub-surface is
  // up (keyboard visible, or the send flow past its recipient step — both flip
  // `data-hide-navbar`). The nested send steps keep `pathname === '/send'`, so
  // the carousel otherwise stays draggable and a horizontal swipe on Select
  // Amount drags an adjacent pane over the amount field. Programmatic slides
  // (tapping Send/Receive) animate `x` directly and are unaffected.
  const navbarHidden = useNavbarHidden();
  const reduceMotion = useReducedMotion();
  const dragControls = useDragControls();
  // Index the release animation is already heading toward. The `navigate()` in
  // handleDragEnd re-runs the effect below on the next commit; without this
  // marker that effect would start a second, competing animation on `x`.
  const dragTargetIdxRef = useRef<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // The in-flight release. It runs on the compositor rather than through `x`, so
  // while it is set `x` is stale and the element's computed transform is the
  // only source of truth for where the track actually is.
  const releaseRef = useRef<Animation | null>(null);

  // Only the Swap pane is feature-gated (isSwapEnabled); every downstream
  // calculation reads `pages`, so dropping a pane can't desync the track
  // width / index math.
  const pages: HomePage[] = [
    { id: 'overview', path: '/', node: <Explore /> },
    { id: 'send', path: '/send', node: <SendFlow isLoading={false} /> },
    { id: 'receive', path: '/receive', node: <Receive /> },
    { id: 'earn', path: '/earn', node: <Earn /> },
    ...(isSwapEnabled() ? [{ id: 'swap', path: '/swap', node: <SwapFlow /> }] : [])
  ];

  const activeIdx = (() => {
    const exact = pages.findIndex(p => p.path === pathname);
    if (exact !== -1) return exact;
    // Match by prefix for nested routes (e.g. /send/sub-step).
    const prefix = pages.findIndex(p => p.path !== '/' && pathname.startsWith(`${p.path}/`));
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

  /**
   * Tears down the in-flight release, optionally adopting wherever it had got to.
   *
   * `x` is stale during a compositor release, so anything that takes control back
   * — a new drag, a route change from elsewhere — has to sync `x` to the real
   * on-screen position first or the track jumps back to where the finger left it.
   * The read has to happen before `cancel()`, which discards the animated value.
   */
  const endRelease = useCallback(
    (adoptPosition: boolean) => {
      const release = releaseRef.current;
      if (!release) return;
      releaseRef.current = null;
      const track = trackRef.current;
      if (adoptPosition && track) {
        const current = readTranslateX(track);
        // Write the transform synchronously, then hand the value to framer.
        // `x.set` only queues a write for framer's next render frame, whereas
        // `cancel()` drops the compositor's hold immediately — so setting only the
        // motion value leaves one frame showing the stale inline transform, the
        // spot the finger left. Measured as a 172px backward jump when grabbing a
        // release mid-flight.
        track.style.transform = `translateX(${current}px)`;
        x.set(current);
      }
      release.cancel();
    },
    [x]
  );

  // Animate to the active page's resting position whenever activeIdx or
  // width changes. Uses the standard spring so this matches the rest of
  // the wallet's motion vocabulary.
  useEffect(() => {
    const dragTargetIdx = dragTargetIdxRef.current;
    dragTargetIdxRef.current = null;
    if (!width) {
      x.set(-activeIdx * (containerRef.current?.clientWidth ?? 0));
      return;
    }
    // A release is already carrying the track to this exact index. Re-animating
    // would restart the motion from a standstill mid-flight.
    if (dragTargetIdx === activeIdx) return;
    // Any other route change outranks a release still in flight.
    endRelease(true);
    const controls = animate(x, -activeIdx * width, resolveTransition(reduceMotion, springs.standard));
    return () => controls.stop();
  }, [activeIdx, width, x, reduceMotion, endRelease]);

  useEffect(() => () => releaseRef.current?.cancel(), []);

  /**
   * Hands the release to the compositor as a single transform animation.
   *
   * `springs.dragRelease` is solved and sampled into a `linear()` easing up front
   * because the compositor needs a fixed curve; see `springToLinearEasing`. The
   * animation deliberately overrides framer's inline transform for its duration
   * (animations outrank inline styles in the cascade), which is what lets it run
   * without the main thread writing a frame.
   */
  const startRelease = (from: number, to: number, velocity: number) => {
    const track = trackRef.current;
    const spring =
      track && !reduceMotion ? springToLinearEasing(springs.dragRelease, { distance: from - to, velocity }) : null;
    if (!track || !spring) {
      x.set(to);
      return;
    }

    endRelease(false);
    // The snap is the one animation here that could use a rate above 60Hz, since
    // it runs on the compositor instead of through rAF. Scoped to the animation's
    // own duration: holding the display at 120Hz on a mostly-static wallet screen
    // would cost battery continuously for no benefit.
    boostRefreshRate(spring.duration);
    const release = track.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], {
      duration: spring.duration,
      easing: spring.easing,
      // Hold the landing position once the curve ends. Without this the transform
      // reverts to whatever framer last wrote — the spot the finger left — for the
      // frame between the animation ending and `onfinish` running.
      fill: 'forwards'
    });
    releaseRef.current = release;
    release.onfinish = () => {
      if (releaseRef.current !== release) return;
      // Deliberately no `cancel()` here. `x.set` only queues a write for framer's
      // next render frame, so releasing the compositor's hold now would leave one
      // frame where the transform falls back to the stale inline value — the spot
      // the finger left. Measured as a 244px round trip, once per release. The
      // hold is dropped later, by `endRelease`, once something else takes over.
      x.set(to);
    };
  };

  /**
   * Picks the page a release commits to and starts the animation toward it.
   *
   * Runs synchronously inside framer's pointer-up handling, before it defers
   * `onDragEnd` to `frame.postRender`. That ordering is the point: driving the
   * snap from `onDragEnd` — let alone from the `navigate()` round-trip through a
   * React commit — starts it a frame or more after the finger left, and nothing
   * moves the track in between. Mid-flick, at ~30px/frame, that gap reads as a
   * stutter, and it was measurably present on 22 of 24 flicks.
   */
  const snapToPage = (ideal: number) => {
    if (!width) return ideal;
    const origin = x.get();
    // framer passes the coasting target rather than the release velocity, but
    // that target is `origin + power * velocity`, so the velocity is recoverable
    // — and it is needed both to judge the flick and to seed the spring.
    const velocity = (ideal - origin) / DRAG_POWER;
    const offset = origin + activeIdx * width;
    const projected = offset + velocity * (VELOCITY_PROJECTION_MS / 1000);

    let newIdx = activeIdx;
    if (projected < -width * COMMIT_THRESHOLD && activeIdx < pages.length - 1) {
      newIdx = activeIdx + 1;
    } else if (projected > width * COMMIT_THRESHOLD && activeIdx > 0) {
      newIdx = activeIdx - 1;
    }

    dragTargetIdxRef.current = newIdx;
    startRelease(origin, -newIdx * width, velocity);
    // Park framer's own momentum animation on the spot the finger left, so it has
    // nothing to travel and cannot fight the compositor for the transform.
    return origin;
  };

  const handleDragEnd = () => {
    // snapToPage already chose the page and is already animating toward it; this
    // only syncs the route so pathname stays the source of truth for the
    // SegmentedActionBar pill and back handling.
    const newIdx = dragTargetIdxRef.current;
    if (newIdx === null || newIdx === activeIdx) return;
    const target = pages[newIdx];
    if (target) navigate(target.path);
  };

  // Drag constraints clamp the track to its valid x-range, with a small
  // elastic overshoot for that rubber-band feel at the ends.
  const dragMaxLeft = width ? -(pages.length - 1) * width : 0;
  const dragEnabled = !navbarHidden;

  /**
   * Runs before framer's own pointerdown listener on the track, for two reasons.
   *
   * It ends any in-flight release first, because framer reads the drag origin
   * from `x` — stale while the compositor owns the transform — and would snap the
   * track back to the spot the last finger left.
   *
   * Then it starts the drag itself when the finger landed on a text field.
   * Framer declines to in that case (its `isClickingTextInputChild` check), so
   * that dragging inside a field selects text rather than dragging the parent.
   * That trade is wrong for a full-screen carousel on touch: the swap screen's
   * two amount fields are full-width and ~64px tall, so most of that screen
   * silently refused to swipe. iOS selects text by long-press and double-tap,
   * neither of which a pan session interferes with — framer's drag never calls
   * `preventDefault`, and only claims the gesture once it passes a 3px
   * threshold, so a tap still focuses the field and opens the keyboard.
   *
   * Mouse and pen keep framer's behaviour, where dragging across a field to
   * select text is the expected thing. Nothing starts while `data-hide-navbar`
   * is up, so a focused field with the keyboard open is untouched by this (#481).
   */
  const handlePointerDownCapture = (event: React.PointerEvent) => {
    const interruptingRelease = releaseRef.current !== null;
    endRelease(true);
    // A touch that lands mid-transition means "stop", and shouldn't also land on
    // the control underneath: the fields are still moving, so which one the finger
    // is over is accidental, and the keyboard it would raise interrupts the
    // transition it just stopped. Cancelling the pointerdown suppresses the focus
    // without affecting the pan session, which framer starts regardless.
    if (interruptingRelease && isTextInput(event.target)) event.preventDefault();
    if (dragEnabled && event.pointerType === 'touch' && isTextInput(event.target)) {
      dragControls.start(event);
    }
  };

  /**
   * Lands the track on its page when a touch stopped a release without going on
   * to drag.
   *
   * The route is committed the moment the finger lifts, so by the time a release
   * is in flight nothing downstream is still waiting to move the track: framer
   * starts no drag for a tap, and the resting-position effect won't re-run for an
   * index that hasn't changed. Interrupting therefore used to leave the track
   * wherever the compositor had got to — stranded between two pages, showing
   * both at once.
   *
   * Deferred by a frame so framer's own release path has run first: if this
   * gesture was a drag, `snapToPage` has started a release by then and there is
   * nothing to recover. Phrased as "is the track off its resting position" rather
   * than tracked with a flag, so it also catches a second tap interrupting this
   * very animation, and any future path that leaves the track adrift.
   */
  const landAfterInterruptedRelease = () => {
    requestAnimationFrame(() => {
      if (releaseRef.current || !width) return;
      const resting = -activeIdx * width;
      if (Math.abs(x.get() - resting) < 0.5) return;
      animate(x, resting, resolveTransition(reduceMotion, springs.standard));
    });
  };

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden touch-pan-y bg-app-bg"
      onPointerDownCapture={handlePointerDownCapture}
      onPointerUpCapture={landAfterInterruptedRelease}
      onPointerCancelCapture={landAfterInterruptedRelease}
    >
      <motion.div
        ref={trackRef}
        className="h-full flex"
        // Pre-promote the track to its own compositor layer so a programmatic
        // slide (tapping Send/Receive) doesn't pay for layer creation — a full
        // repaint — on its first frame; a finger drag is already on a live
        // layer, which is why it feels smoother. Intentionally ALWAYS-on:
        // toggling `willChange` at tap time would create the layer on that
        // first frame, defeating the purpose. Caveat: the non-`none` transform
        // already makes this the containing block for `position: fixed`
        // descendants, so any future home-page child needing viewport-fixed
        // placement must portal out of the track (today's drawers/modals do).
        style={{ x, width: `${pages.length * 100}%`, willChange: 'transform' }}
        drag={dragEnabled ? 'x' : false}
        // Only used by `handlePointerDownCapture`, for the gestures framer's own
        // listener refuses to start. Everything else still goes through that
        // listener, so passing this doesn't change the ordinary path.
        dragControls={dragControls}
        dragDirectionLock
        dragConstraints={{ left: dragMaxLeft, right: 0 }}
        dragElastic={0.15}
        // Momentum stays ON purely so framer calls `modifyTarget` with a real
        // release velocity; with it off the velocity arrives as zero. The actual
        // snap is started from inside `snapToPage` and runs on the compositor.
        dragMomentum
        dragTransition={{ power: DRAG_POWER, modifyTarget: snapToPage }}
        onDragEnd={handleDragEnd}
      >
        {pages.map(page => (
          <div key={page.id} className="h-full shrink-0" style={{ width: `${100 / pages.length}%` }}>
            {page.node}
          </div>
        ))}
      </motion.div>
    </div>
  );
};

export default HomeSwipeContainer;
