/**
 * Centralized spring physics presets for the wallet UI.
 *
 * Stiffness/damping values are derived from iOS UIKit (response, dampingRatio):
 *   stiffness = (2π/response)^2
 *   damping = 4π * dampingRatio / response
 *
 * Use these presets via framer-motion's `transition` prop instead of inlining
 * spring config in components. This keeps animation feel consistent across
 * the app and lets us tune the whole system from one place.
 *
 * Naming guide:
 * - `snappy`: button presses, taps, capsule chrome
 * - `standard`: default screen / sheet motion (response 0.4 / 0.85)
 * - `magnetic`: bubble fly-to-corner with overshoot
 * - `settle`: bubble final landing (no bounce)
 * - `sheetPresent`: bottom sheet present/dismiss
 * - `pill`: footer tabbar pill (existing precedent)
 * - `morph`: shared-element transitions (slow, soft)
 * - `dragRelease`: post-drag rebound
 */

import type { Transition } from 'framer-motion';

export const springs = {
  snappy: { type: 'spring', stiffness: 500, damping: 38, mass: 1 } as Transition,
  standard: { type: 'spring', stiffness: 322, damping: 32, mass: 1 } as Transition,
  magnetic: { type: 'spring', stiffness: 380, damping: 26, mass: 1 } as Transition,
  settle: { type: 'spring', stiffness: 260, damping: 30, mass: 1 } as Transition,
  sheetPresent: { type: 'spring', stiffness: 380, damping: 34, mass: 1 } as Transition,
  pill: { type: 'spring', stiffness: 320, damping: 30 } as Transition,
  // Critically damped: 2*sqrt(stiffness*mass) = 2*sqrt(220*1.2) = 32.5
  // damping 40 puts the ratio at ~1.23 — definitively over-damped, so
  // any layout-animation correction settles smoothly without overshoot.
  // The previous value (damping 30, ratio ~0.92) caused a visible bounce
  // at the end of TabLayout's mobile-page-enter slide-in on /browser
  // because framer-motion's layoutId machinery tried to "correct" the
  // children's bounding rects mid-transform.
  morph: { type: 'spring', stiffness: 220, damping: 40, mass: 1.2 } as Transition,
  dragRelease: { type: 'spring', stiffness: 420, damping: 40, mass: 1 } as Transition
};

export type SpringName = keyof typeof springs;
