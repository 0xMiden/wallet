import React, { useRef } from 'react';

import clsx from 'clsx';

import { stepFooterCushionClass } from './footer-cushion';
import { useSlideOnReflow } from './useSlideOnReflow';

export interface FlowFooterProps {
  children: React.ReactNode;
}

/**
 * The pinned CTA at the bottom of a flow page.
 *
 * Its resting place is one expression of `--keyboard-height` (footer-cushion.ts), deliberately NOT
 * a React read of the `data-hide-navbar` flag: the keyboard raises that flag too, but only after a
 * round trip through two components' state, so the cushion collapsed a frame or two AFTER the
 * keyboard inset had already moved the page. That was two reflows, and two slides — the CTA rode
 * the keyboard down and then hopped back up by the cushion's height. Keyed off the var, the inset
 * and the cushion resolve in the same frame, so there is one move and one slide.
 *
 * The cushion is unconditional, and `data-navbar-cushion` is what drops it. The docked bar draws
 * OVER the page (`z-60`, screen edge), so the only safe rule is that the CTA clears the bar
 * whenever the bar is actually up, and `body[data-hide-navbar]` is the one fact that says it is
 * not. A page-shape guess in its place ("a pushed step has no bar under it") is really a guess
 * about a flag some OTHER component raises: a send sub-step is pushed but still lives inside
 * TabLayout, so on the frames where that flag failed to land, the bar sat on top of the CTA and
 * swallowed every click on it — a visible, enabled, stable button that could not be clicked.
 * Collapsed, this cushion is the same 1rem the guess resolved to, so nothing moves in the normal
 * case; it moves only when the bar is genuinely there, which is exactly when it must.
 */
export const FlowFooter: React.FC<FlowFooterProps> = ({ children }) => {
  // The keyboard and the tab bar move the CTA by snapping layout; slide it there instead.
  const ref = useRef<HTMLDivElement>(null);
  useSlideOnReflow(ref);

  return (
    <div ref={ref} data-navbar-cushion="true" className={clsx('shrink-0 pt-3', stepFooterCushionClass())}>
      {children}
    </div>
  );
};
