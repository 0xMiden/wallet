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
 * - `tabSwitch`: a tab bar's highlight sliding to the new tab — one visible
 *   overshoot (~7%), settled within ~340ms even across three tabs
 * - `tabIconPop`: the newly active tab icon rising to its pop scale, quickly
 *   and without overshoot, before `tabSwitch` brings it back to rest
 */

import type { Transition } from 'framer-motion';

// Tuned against `springToLinearEasing` (lib/animation/tab-bar.test.ts pins it):
// damping ratio ≈ 0.64, a single ~7% overshoot, and quiet (under 0.5px) after
// ~230ms for a one-tab hop of 90px and ~340ms for a 270px jump.
const tabSwitch: Transition = { type: 'spring', stiffness: 680, damping: 30, mass: 0.8 };
// Damping ratio ≈ 0.87: reaches the pop scale in about a tenth of a second
// with no visible overshoot past it.
const tabIconPop: Transition = { type: 'spring', stiffness: 900, damping: 40, mass: 0.6 };

export const springs = {
  snappy: { type: 'spring', stiffness: 500, damping: 38, mass: 1 } as Transition,
  standard: { type: 'spring', stiffness: 322, damping: 32, mass: 1 } as Transition,
  magnetic: { type: 'spring', stiffness: 380, damping: 26, mass: 1 } as Transition,
  settle: { type: 'spring', stiffness: 260, damping: 30, mass: 1 } as Transition,
  sheetPresent: { type: 'spring', stiffness: 380, damping: 34, mass: 1 } as Transition,
  pill: { type: 'spring', stiffness: 320, damping: 30 } as Transition,
  morph: { type: 'spring', stiffness: 220, damping: 30, mass: 1.2 } as Transition,
  dragRelease: { type: 'spring', stiffness: 420, damping: 40, mass: 1 } as Transition,
  tabSwitch,
  tabIconPop
};

export type SpringName = keyof typeof springs;
