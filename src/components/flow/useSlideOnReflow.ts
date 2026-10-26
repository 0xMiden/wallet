import { RefObject, useEffect } from 'react';

import { useReducedMotion } from 'framer-motion';

import { springKeyframes, springs } from 'lib/animation';
import { isMobile } from 'lib/platform';

/**
 * Slide an element to its new position whenever layout moves it, instead of letting it jump.
 *
 * The keyboard inset snaps the page's bottom padding to the keyboard height in a single step on
 * purpose: animating padding reflows WebKit's page tree on every frame (see lib/mobile/keyboard-inset).
 * So layout still snaps, and this animates only what the user sees: after each reflow, and before it
 * paints, the element is offset back to where it was drawn and eased to its new place with a
 * transform, which costs no layout. It covers both directions (keyboard up and down, the tab bar
 * hiding and showing) and picks up from mid-flight when a move interrupts a slide.
 *
 * The curve is `springs.standard` sampled into keyframes with a `linear` easing between them. A
 * `linear()` easing would not do: WebKit runs it at 60Hz where sampled keyframes run at the display's
 * rate (measured on device: 60Hz against 120Hz), and it only parses `linear()` from Safari 17.2. The
 * spring is all but critically damped: a CTA riding the keyboard must not overshoot past the
 * keyboard's edge on the way up. The animation's start time is this frame: left unset, it waits for
 * the next one, and the footer paints at its new place for that gap.
 *
 * A reflow of an element out of sight (inside an `[inert]` ancestor: a hidden tab pane, a covered
 * page layer, an off-screen home pane) only records the new layout top, and a slide already running
 * is cancelled in the same turn that ancestor becomes inert. Nobody sees that slide, and the device
 * trace showed it holding the display at 60Hz through a page push.
 *
 * Observes the element and its parent, which is the page frame the keyboard inset resizes.
 */
export function useSlideOnReflow(ref: RefObject<HTMLElement | null>) {
  // Reactive, like every other motion site in the flow: sampling the preference once at mount left
  // the slide running for someone who turned Reduce Motion on while a flow page was open.
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    const container = el?.parentElement;
    if (!el || !container || typeof ResizeObserver === 'undefined' || typeof el.animate !== 'function') return;
    // The moves this exists for are the keyboard inset and the docked tab bar, both mobile and both
    // discrete. Off mobile the only thing that resizes the frame is a window or panel drag, which
    // arrives every frame and made the footer trail its own layout position.
    if (!isMobile()) return;

    let layoutTop = el.getBoundingClientRect().top;
    let running: Animation | undefined;

    const currentOffset = (): number => {
      if (!running) return 0;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return matrix.m42;
    };

    const onReflow = () => {
      const drawnAt = layoutTop + currentOffset();
      running?.cancel();
      running = undefined;
      const nextTop = el.getBoundingClientRect().top;
      layoutTop = nextTop;
      const delta = drawnAt - nextTop;
      if (reduceMotion || el.closest('[inert]')) return;
      const slide = springKeyframes(
        springs.standard,
        delta,
        0,
        value => ({ transform: `translateY(${value}px)` }),
        'px'
      );
      if (!slide) return;
      running = el.animate(slide.keyframes, { duration: slide.duration, easing: 'linear' });
      // Start on this frame's timeline. Left unset, the animation waits for the
      // next frame, so the footer paints at its new place for that gap.
      const now = document.timeline?.currentTime;
      if (typeof now === 'number') running.startTime = now;
      running.onfinish = () => {
        running = undefined;
      };
    };

    // Those layouts set `inert` from their own layout effects and do not resize this footer, so a
    // slide already running would otherwise keep the compositor busy until some later reflow.
    const onInert = () => {
      if (!running || !el.closest('[inert]')) return;
      running.cancel();
      running = undefined;
    };

    const observer = new ResizeObserver(onReflow);
    observer.observe(container);
    // Border box: a padding-only move (the cushion collapsing) changes no content box.
    observer.observe(el, { box: 'border-box' });
    let inertObserver: MutationObserver | undefined;
    if (typeof MutationObserver !== 'undefined') {
      inertObserver = new MutationObserver(onInert);
      inertObserver.observe(document.documentElement, { subtree: true, attributeFilter: ['inert'] });
    }
    return () => {
      observer.disconnect();
      inertObserver?.disconnect();
      running?.cancel();
    };
  }, [ref, reduceMotion]);
}
