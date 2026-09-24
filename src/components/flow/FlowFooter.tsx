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
 * Its resting place is one expression of `--keyboard-height` (footer-cushion.ts) plus the
 * `body[data-hide-navbar]` collapse, and the keyboard listener (lib/mobile/keyboard-inset) writes
 * both in the same task. So on iOS the inset, the cushion and the bar change together and the CTA
 * makes one move on open and on close. On Android the native resize moves the page before that
 * listener runs, so the CTA takes two slides there. The cushion snaps (`data-flow-footer` exempts it
 * from main.css's padding transition) and `useSlideOnReflow` animates the move from where the CTA
 * was drawn.
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
    <div
      ref={ref}
      data-navbar-cushion="true"
      data-flow-footer=""
      className={clsx('shrink-0 pt-3', stepFooterCushionClass())}
    >
      {children}
    </div>
  );
};
