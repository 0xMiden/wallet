import React, { FC, memo, ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useReducedMotion } from 'framer-motion';

import { setHomePagerPreview } from 'app/layouts/home-pager-preview';
import { PageActiveContext, usePageActive, useTabShownAgain } from 'app/layouts/page-active';
import Earn from 'app/pages/Earn';
import Explore from 'app/pages/Explore';
import { Receive } from 'app/pages/Receive';
import { pagerMotion, pagerTapDurationMs } from 'lib/animation';
import { isSwapEnabled } from 'lib/feature-flags';
import { hapticSelection } from 'lib/mobile/haptics';
import { boostRefreshRate } from 'lib/mobile/high-refresh-rate';
import { useNavbarHidden } from 'lib/mobile/useNavbarHidden';
import { beginInteraction } from 'lib/ui/interaction-priority';
import { navigate, useLocation } from 'lib/woozie';
import { SendFlow } from 'screens/send-flow/SendManager';
import { SwapFlow } from 'screens/swap-flow/SwapManager';

/**
 * Pager that mounts the home-group pages (Overview / Send / Receive / Earn / Swap) side by side in a
 * native horizontal scroller with mandatory scroll snap, on every platform. The engine tracks the
 * finger, flings and snaps (UIKit on iOS, the compositor on Chromium), so a swipe never waits on the
 * main thread; this component only reads where the scroller came to rest and commits that page.
 *
 * Pathname is the source of truth for which page is selected: a settle navigates, and a route change
 * from anywhere else (the SegmentedActionBar, back, a deep link) moves the scroller with an instant
 * `scrollTo` plus a compositor FLIP on the track, so a tap slides the same way a swipe does.
 *
 * Earn ships unconditionally; only the Swap (isSwapEnabled) pane is feature-gated. Track length,
 * pane widths and the index math all derive from the same `pages` array.
 */

interface HomePage {
  id: string;
  path: string;
  node: ReactNode;
}

function buildPages(swapEnabled: boolean): HomePage[] {
  return [
    { id: 'overview', path: '/', node: <Explore /> },
    { id: 'send', path: '/send', node: <SendFlow isLoading={false} /> },
    { id: 'receive', path: '/receive', node: <Receive /> },
    { id: 'earn', path: '/earn', node: <Earn /> },
    ...(swapEnabled ? [{ id: 'swap', path: '/swap', node: <SwapFlow /> }] : [])
  ];
}

// A scroll event this recent means the scroller is still coasting, so a tap has to stop it before
// jumping, or the momentum carries on from the new position.
const MOMENTUM_WINDOW_MS = 50;

const SNAP_TYPE = 'x mandatory';

const TEXT_INPUT_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (TEXT_INPUT_TAGS.has(target.tagName) || target.isContentEditable);
}

/**
 * A touch that stops a slide means "stop", and should not also focus the field under it: the fields
 * are still moving, so which one the finger is over is accidental, and the keyboard would interrupt
 * the slide it just stopped. Attached only while a FLIP runs.
 */
function blockFieldFocus(event: PointerEvent) {
  if (isTextInput(event.target)) event.preventDefault();
}

/** Where a FLIP has the track right now. Forces a style recalc, so only on discrete events. */
function readTranslateX(el: HTMLElement): number {
  const { transform } = getComputedStyle(el);
  if (!transform || transform === 'none') return 0;
  return new DOMMatrixReadOnly(transform).m41;
}

interface PaneProps {
  id: string;
  share: string;
  active: boolean;
  inert: boolean;
  node: ReactNode;
}

/** One page of the track. Memoized so a route change re-renders only the panes whose flags changed. */
const Pane = memo(function Pane({ id, share, active, inert, node }: PaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  // React 18 has no `inert` prop. Off-screen panes are inert so focus, find-in-page and assistive
  // tech cannot reach a page the user cannot see.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (inert) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [inert]);
  return (
    <div
      ref={ref}
      data-home-page={id}
      className="h-full shrink-0"
      style={{ width: share, scrollSnapAlign: 'start', scrollSnapStop: 'always' }}
    >
      <PageActiveContext.Provider value={active}>{node}</PageActiveContext.Provider>
    </div>
  );
});

interface Flip {
  animation: Animation;
  targetLeft: number;
  endInteraction: () => void;
}

const HomeSwipeContainer: FC = () => {
  const { pathname } = useLocation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // #481: no swiping while a focused sub-surface is up (keyboard, or the send flow past its recipient
  // step; both raise `data-hide-navbar`). The nested send steps keep `pathname === '/send'`, so
  // without this a horizontal swipe on Select Amount drags an adjacent pane over the amount field.
  // Programmatic moves still work: `overflow: hidden` blocks only user scrolling.
  const navbarHidden = useNavbarHidden();
  const reduceMotion = useReducedMotion();
  const swapEnabled = isSwapEnabled();
  const pages = useMemo(() => buildPages(swapEnabled), [swapEnabled]);

  // The home page the route names, or -1 when it names none.
  const routeIdx = (() => {
    const exact = pages.findIndex(p => p.path === pathname);
    if (exact !== -1) return exact;
    // Match by prefix for nested routes (e.g. /send/sub-step).
    return pages.findIndex(p => p.path !== '/' && pathname.startsWith(`${p.path}/`));
  })();
  // TabLayout keeps this pane mounted, hidden, while another tab shows, and the route then names no
  // home page. The pager holds the page it was on rather than sliding to Overview out of sight.
  const onHome = routeIdx !== -1;
  const selectedPageId = pages[routeIdx]?.id;
  const lastHomeIdxRef = useRef(0);
  const shownAgain = useTabShownAgain();
  const activeIdx = onHome ? routeIdx : lastHomeIdxRef.current;
  // Every page stays mounted, so only the selected one, on a shown and uncovered tab, is on screen;
  // the others pause their display-only work as a hidden tab's pages do.
  const parentActive = usePageActive();

  // Latest values for the scroller's native listeners, which are attached once.
  const widthRef = useRef(0);
  const pagesRef = useRef(pages);
  const lockedRef = useRef(navbarHidden);
  // The page the route is on, or the one a settle has just navigated to, so a second settle report
  // for the same rest (scrollend plus the idle check) never buzzes or navigates twice. Re-read from
  // the route on every commit, so a navigation that was refused or redirected cannot leave it stale.
  const committedIdxRef = useRef(activeIdx);
  const placedWidthRef = useRef(0);
  const flipRef = useRef<Flip | null>(null);
  const programmaticRef = useRef(0);
  const lastScrollAtRef = useRef(0);
  // A touch caught a slide and is still down: snapping stays off until it lifts, even if another
  // slide starts and ends under it.
  const catchHeldRef = useRef(false);
  // The scroll effect's finger and rest check, refreshed every time that effect runs. A slide
  // that finishes off its target calls it; a cancel, a catch and a finger still down do not settle.
  const checkRestRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    widthRef.current = width;
    pagesRef.current = pages;
    lockedRef.current = navbarHidden;
    committedIdxRef.current = activeIdx;
  });

  // A page can keep its focused input after it moves out of view because the pager keeps every page
  // mounted. Release that focus when the route selects another page so the mobile keyboard closes and
  // its navbar hold can end.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return;
    const focusedPage = focused.closest('[data-home-page]');
    if (!focusedPage || focusedPage.getAttribute('data-home-page') === selectedPageId) return;
    focused.blur();
  }, [selectedPageId]);

  // Measured before the first paint so the selected page is placed without a flash.
  useLayoutEffect(() => {
    const w = scrollerRef.current?.getBoundingClientRect().width ?? 0;
    if (w > 0) setWidth(w);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * Moves the scroller without it counting as the user's scroll. The flag covers the scroll events
   * the move fires, which arrive in the next rendering step, before that frame's callbacks run.
   */
  const scrollProgrammatically = useCallback((move: (scroller: HTMLDivElement) => void) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const token = ++programmaticRef.current;
    move(scroller);
    requestAnimationFrame(() => {
      if (programmaticRef.current === token) programmaticRef.current = 0;
    });
  }, []);

  const scrollInstantly = useCallback(
    (left: number) => scrollProgrammatically(s => s.scrollTo({ left, behavior: 'auto' })),
    [scrollProgrammatically]
  );

  const endFlip = useCallback((flip: Flip, cancel: boolean) => {
    if (flipRef.current !== flip) return;
    flipRef.current = null;
    if (cancel) flip.animation.cancel();
    // Snap moves nothing when the scroller already sits on a boundary, including a boundary other
    // than the slide's target.
    const scroller = scrollerRef.current;
    if (scroller && !catchHeldRef.current) scroller.style.scrollSnapType = SNAP_TYPE;
    const track = trackRef.current;
    if (track) track.style.willChange = '';
    scrollerRef.current?.removeEventListener('pointerdown', blockFieldFocus, true);
    flip.endInteraction();
    // The transform is gone, so scrollLeft is the page on screen. Cancel and a held catch place
    // the scroller themselves; on the slide's target there is nothing to settle.
    if (
      cancel ||
      catchHeldRef.current ||
      !scroller ||
      Math.abs(scroller.scrollLeft - flip.targetLeft) <= pagerMotion.alignTolerancePx
    ) {
      return;
    }
    checkRestRef.current?.();
  }, []);

  /**
   * A tap's slide: the scroller jumps to the page at once, and the track is animated from where the
   * content was back to rest, on the compositor. The scroller is already at its destination for the
   * whole slide, so a settle, a resize or a second tap never has to work out where it was going.
   */
  const startFlip = useCallback(
    (currentLeft: number, targetLeft: number, pageWidth: number) => {
      const scroller = scrollerRef.current;
      const track = trackRef.current;
      if (!scroller || !track) return;
      const endInteraction = beginInteraction();
      if (Date.now() - lastScrollAtRef.current < MOMENTUM_WINDOW_MS) {
        scroller.style.overflowX = 'hidden';
        // Two frames: a callback of the next frame runs before that frame's style and commit, so a
        // single one would undo the stop before the compositor ever saw it.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            scroller.style.overflowX = lockedRef.current ? 'hidden' : 'auto';
          })
        );
      }
      // Snap areas follow the track's transform, so a mandatory scroller would re-snap under the
      // slide every frame, hiding it and reporting each re-snap as a scroll. Off until endFlip.
      scroller.style.scrollSnapType = 'none';
      scrollInstantly(targetLeft);
      const duration = pagerTapDurationMs(Math.round(Math.abs(targetLeft - currentLeft) / pageWidth));
      // Scoped to the slide: holding the display at its top rate on a mostly static screen costs
      // battery for nothing.
      boostRefreshRate(duration);
      track.style.willChange = 'transform';
      const animation = track.animate(
        [{ transform: `translateX(${targetLeft - currentLeft}px)` }, { transform: 'none' }],
        { duration, easing: pagerMotion.tapEasing }
      );
      const flip: Flip = { animation, targetLeft, endInteraction };
      flipRef.current = flip;
      scroller.addEventListener('pointerdown', blockFieldFocus, true);
      animation.onfinish = () => endFlip(flip, false);
      animation.oncancel = () => endFlip(flip, false);
    },
    [endFlip, scrollInstantly]
  );

  // Route-driven moves. A settle's own navigate lands here too, already aligned, and does nothing.
  useLayoutEffect(() => {
    if (onHome) lastHomeIdxRef.current = activeIdx;
    // The route names the page now, so the swipe's preview is done.
    setHomePagerPreview(null);
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (!scroller || !track || !width) return;
    const targetLeft = activeIdx * width;
    const resized = placedWidthRef.current !== width;
    placedWidthRef.current = width;
    const flip = flipRef.current;
    if (flip && flip.targetLeft === targetLeft && !resized) return;
    // A slide interrupted by another route change starts the next one from where it is on screen.
    const currentLeft = flip ? scroller.scrollLeft - readTranslateX(track) : scroller.scrollLeft;
    if (flip) endFlip(flip, true);
    if (Math.abs(currentLeft - targetLeft) <= pagerMotion.alignTolerancePx) {
      if (Math.abs(scroller.scrollLeft - targetLeft) > pagerMotion.alignTolerancePx) scrollInstantly(targetLeft);
      return;
    }
    // The first placement and a resize realign; a tab shown again swaps, which is what a tab change
    // does, rather than sliding across every page in between. `shownAgain` is read, not a trigger:
    // the commit that shows the pane again also raises `onHome`, which runs this effect.
    if (resized || shownAgain || reduceMotion) {
      scrollInstantly(targetLeft);
      return;
    }
    startFlip(currentLeft, targetLeft, width);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shownAgain and reduceMotion are read, not triggers (above)
  }, [activeIdx, onHome, width, endFlip, scrollInstantly, startFlip]);

  // Settle detection and the gesture signal, on passive native listeners so the scroller never
  // waits on this thread.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const supportsScrollEnd = 'onscrollend' in window;
    let endGesture: (() => void) | null = null;
    let touchDown = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const releaseCatch = () => {
      if (!catchHeldRef.current) return;
      catchHeldRef.current = false;
      if (!flipRef.current) scroller.style.scrollSnapType = SNAP_TYPE;
    };
    // The pager's own moves, and a slide nobody is touching, are never the user's scroll.
    const ignoreScroll = () => programmaticRef.current !== 0 || (flipRef.current !== null && !touchDown);

    const beginGesture = () => {
      if (!endGesture) endGesture = beginInteraction();
    };
    const finishGesture = () => {
      endGesture?.();
      endGesture = null;
    };

    const settle = (k: number) => {
      finishGesture();
      const page = pagesRef.current[k];
      if (!page || k === committedIdxRef.current) {
        // The swipe came back to the page it started on: no navigation clears the preview.
        setHomePagerPreview(null);
        return;
      }
      committedIdxRef.current = k;
      // A swipe that lands on another page is a tab switch, so it buzzes once, at the landing, like a
      // tap on the bar does; the bar buzzes only for taps, so the two never double up.
      hapticSelection();
      navigate(page.path);
    };

    const checkRest = () => {
      const w = widthRef.current;
      if (!w) {
        finishGesture();
        return;
      }
      const left = scroller.scrollLeft;
      const k = Math.min(pagesRef.current.length - 1, Math.max(0, Math.round(left / w)));
      if (Math.abs(left - k * w) <= pagerMotion.alignTolerancePx) {
        settle(k);
        return;
      }
      // At rest between two pages: a touch stopped a slide and lifted without dragging. Snap to the
      // nearest page; that scroll's own end settles it.
      scroller.scrollTo({ left: k * w, behavior: 'smooth' });
    };
    // Refreshed each run so it closes over this effect's finger and rest check. endFlip calls it
    // only once a slide has finished off its target, after the flip is cleared and snap is back.
    checkRestRef.current = () => {
      if (touchDown) return;
      checkRest();
    };

    const onIdle = () => {
      // A slide owns the scroller until endFlip, which settles it if it ends off target.
      if (touchDown || ignoreScroll()) return;
      const quiet = Date.now() - lastScrollAtRef.current;
      if (quiet < pagerMotion.settleIdleMs) {
        idleTimer = setTimeout(onIdle, pagerMotion.settleIdleMs - quiet);
        return;
      }
      checkRest();
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, pagerMotion.settleIdleMs);
    };

    const onScroll = () => {
      if (ignoreScroll()) return;
      lastScrollAtRef.current = Date.now();
      beginGesture();
      // The action bar follows the page nearest the scroll position during the swipe, so its pill
      // moves when the page crosses half way, not after the swipe settles and navigates.
      const w = widthRef.current;
      if (w) {
        const k = Math.min(pagesRef.current.length - 1, Math.max(0, Math.round(scroller.scrollLeft / w)));
        setHomePagerPreview(pagesRef.current[k]?.id ?? null);
      }
      if (!supportsScrollEnd) armIdle();
    };
    // Ignored while a finger is down: a finger held still mid-drag must never commit.
    const onScrollEnd = () => {
      if (touchDown || ignoreScroll()) return;
      checkRest();
    };
    const passive = { passive: true };
    // A touch keeps targeting the node it started on even after that node leaves the document, and
    // a detached node's events reach no ancestor, so the end is heard on each touch's own target.
    const endTargets = new Set<EventTarget>();
    const releaseEndTargets = () => {
      for (const target of endTargets) {
        target.removeEventListener('touchend', onTouchEnd);
        target.removeEventListener('touchcancel', onTouchEnd);
      }
      endTargets.clear();
    };
    // Also covers a touch that never scrolled (a tap on content), which fires no scrollend.
    const onTouchEnd = (event: Event) => {
      // Only fingers that started on the pager hold it: a release outside it is never heard here.
      touchDown = event instanceof TouchEvent && Array.from(event.touches).some(touch => endTargets.has(touch.target));
      if (touchDown) return;
      releaseEndTargets();
      releaseCatch();
      armIdle();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchDown = true;
      const { target } = event;
      if (target && !endTargets.has(target)) {
        endTargets.add(target);
        target.addEventListener('touchend', onTouchEnd, passive);
        target.addEventListener('touchcancel', onTouchEnd, passive);
      }
      beginGesture();
      const flip = flipRef.current;
      const track = trackRef.current;
      if (!flip || !track) return;
      // Catch the slide where it is on screen and hand it to the native scroll. Read before the
      // cancel, which drops the animated value.
      const tx = readTranslateX(track);
      // A mandatory snap container re-snaps a programmatic scroll, which would jump the caught slide
      // to a page edge. Held before the cancel, so ending the slide leaves snapping off; it resumes
      // when the finger lifts, which lands the scroller on the nearest page.
      catchHeldRef.current = true;
      endFlip(flip, true);
      const left = flip.targetLeft - tx;
      scrollProgrammatically(s => {
        s.scrollLeft = left;
      });
    };

    scroller.addEventListener('scroll', onScroll, passive);
    scroller.addEventListener('scrollend', onScrollEnd, passive);
    scroller.addEventListener('touchstart', onTouchStart, passive);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('scrollend', onScrollEnd);
      scroller.removeEventListener('touchstart', onTouchStart);
      releaseEndTargets();
      clearTimeout(idleTimer);
      const flip = flipRef.current;
      if (flip) endFlip(flip, true);
      catchHeldRef.current = false;
      scroller.style.scrollSnapType = SNAP_TYPE;
      finishGesture();
      setHomePagerPreview(null);
    };
  }, [endFlip, scrollProgrammatically]);

  const share = `${100 / pages.length}%`;

  return (
    <div
      data-home-pager
      ref={scrollerRef}
      className="no-scrollbar h-full w-full bg-app-bg"
      style={{
        overflowX: navbarHidden ? 'hidden' : 'auto',
        overflowY: 'hidden',
        scrollSnapType: SNAP_TYPE,
        overscrollBehaviorX: 'contain',
        direction: 'ltr',
        touchAction: 'pan-x pan-y'
      }}
    >
      <div data-home-track ref={trackRef} className="flex h-full" style={{ width: `${pages.length * 100}%` }}>
        {pages.map((page, index) => (
          <Pane
            key={page.id}
            id={page.id}
            share={share}
            active={parentActive && index === activeIdx}
            inert={index !== activeIdx}
            node={page.node}
          />
        ))}
      </div>
    </div>
  );
};

export default HomeSwipeContainer;
