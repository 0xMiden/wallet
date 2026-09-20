import { RefObject, useEffect } from 'react';

import { useReducedMotion } from 'framer-motion';

import { springToLinearEasing, springs } from 'lib/animation';
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
 * The curve is `springs.standard` solved into a `linear()` easing, so the slide runs on the
 * compositor at the display's rate rather than through `requestAnimationFrame`, which WKWebView
 * caps at 60Hz (see lib/animation/spring-easing). The spring is all but critically damped: a CTA
 * riding the keyboard must not overshoot past the keyboard's edge on the way up.
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
      if (reduceMotion) return;
      const spring = springToLinearEasing(springs.standard, { distance: delta });
      if (!spring) return;
      running = el.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], {
        duration: spring.duration,
        easing: spring.easing
      });
      running.onfinish = () => {
        running = undefined;
      };
    };

    const observer = new ResizeObserver(onReflow);
    observer.observe(container);
    observer.observe(el);
    return () => {
      observer.disconnect();
      running?.cancel();
    };
  }, [ref, reduceMotion]);
}
