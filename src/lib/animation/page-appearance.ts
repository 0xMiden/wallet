import type { Transition } from 'framer-motion';

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
  duration: 0.34,
  ease: [0.4, 0, 0.2, 1]
};

// Horizontal offset of the page that sits under a slid-in page.
export const pageSlideParallax = '-24%';

// Opacity of the black dim over the page that sits under a slid-in page.
export const pageSlideDim = 0.08;
