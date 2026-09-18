import type { Transition } from 'framer-motion';

import { durations } from './durations';
import { easings } from './easings';
import { resolveTransition } from './use-motion';

export const pageAppearance: Transition = {
  type: 'tween',
  duration: 0.12,
  ease: 'easeOut'
};

// Stacked page slide. The page that comes in moves from the right edge.
// The page below it moves a quarter of its width to the left and gets a
// light dim, so the two pages read as one stack. A pop plays the same
// motion in reverse. These values match the activity-claim-flow mock.
export const pageSlideEntrance: Transition = {
  type: 'tween',
  duration: durations.page,
  ease: easings.standard
};

// Horizontal offset of the page that sits under a slid-in page.
export const pageSlideParallax = '-24%';

// Opacity of the black dim over the page that sits under a slid-in page.
export const pageSlideDim = 0.08;

// A step swap inside one page: the `Navigator` flows (send, swap, wallet file,
// bridge deposit) and onboarding. Their AnimatePresence runs in `mode="wait"`,
// so the leaving step is gone before the next one mounts: two steps are never
// on screen together and there is no page beneath to park at
// `pageSlideParallax`. A step keeps the page model's direction and curve
// instead: going forward it comes in from the right, going back from the side
// the page beneath sits on, over a short nudge rather than the full width.
export const pageStepTransition: Transition = {
  type: 'tween',
  duration: durations.pageStep,
  ease: easings.standard
};

// How far a `Navigator` step comes in from. Negated going back.
export const pageStepOffset = '8%';

// How far an onboarding step drifts while it fades. Negated going back.
export const pageStepFadeOffset = '1vw';

/**
 * The step transition for this platform and motion preference. Steps animate
 * only where `animate` is true (mobile): elsewhere they swap at once, and under
 * reduced motion they are instant everywhere.
 */
export function resolvePageStepTransition(
  reduceMotion: boolean | null,
  animate: boolean,
  duration: number = durations.pageStep
): Transition {
  if (reduceMotion) return resolveTransition(true, pageStepTransition);
  return { ...pageStepTransition, duration: animate ? duration : 0 };
}
