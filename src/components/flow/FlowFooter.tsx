import React, { useRef } from 'react';

import clsx from 'clsx';

import { stepFooterCushionClass } from './footer-cushion';
import { useSlideOnReflow } from './useSlideOnReflow';

export interface FlowFooterProps {
  /**
   * The page has the docked tab bar under it (a tab root: Send's recipient step, the swap amounts
   * page), so the CTA keeps a cushion that clears the bar. Every other flow page is pushed or
   * full-screen, with no bar to clear, and sits at the bottom.
   */
  tabBarBelow?: boolean;
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
 */
export const FlowFooter: React.FC<FlowFooterProps> = ({ tabBarBelow = false, children }) => {
  // The keyboard and the tab bar move the CTA by snapping layout; slide it there instead.
  const ref = useRef<HTMLDivElement>(null);
  useSlideOnReflow(ref);

  return (
    <div ref={ref} className={clsx('shrink-0 pt-3', tabBarBelow ? stepFooterCushionClass() : 'pb-4')}>
      {children}
    </div>
  );
};
