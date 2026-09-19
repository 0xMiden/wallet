import React, { useContext } from 'react';

import { motion, PresenceContext, Transition, Variants } from 'framer-motion';

import { pageSlideDim, pageSlideParallax, presets } from 'lib/animation';

export type OnboardingStepDirection = 'forward' | 'backward';

// Every x here is the `page` preset's: a new page comes in from, and a popped one leaves to, its
// `initial`/`exit` x (the right edge); the page beneath parks at `pageSlideParallax`.
const offscreenX = presets.page.initial?.x ?? '100%';

/** The step itself: in from the right going forward, uncovered from beneath going back. */
export const onboardingStepVariants: Variants = {
  enter: (direction: OnboardingStepDirection) => ({ x: direction === 'forward' ? offscreenX : pageSlideParallax }),
  center: { x: 0 },
  exit: (direction: OnboardingStepDirection) => ({ x: direction === 'forward' ? pageSlideParallax : offscreenX })
};

/** The dim over a step while it sits beneath another, as over the page beneath a pushed page. */
export const onboardingStepDimVariants: Variants = {
  enter: (direction: OnboardingStepDirection) => ({ opacity: direction === 'forward' ? 0 : pageSlideDim }),
  center: { opacity: 0 },
  exit: (direction: OnboardingStepDirection) => ({ opacity: direction === 'forward' ? pageSlideDim : 0 })
};

export interface OnboardingStepLayerProps {
  /** The direction of the move that brought this step in. */
  direction: OnboardingStepDirection;
  transition: Transition;
  children: React.ReactNode;
}

/**
 * One onboarding step as a page layer: the step and its dim, in the grid cell every step shares, so
 * the step leaving and the step arriving cross like a pushed page and the page beneath it. While
 * leaving it is out of reach (no pointer, hidden from assistive tech) and sits under the step
 * arriving going forward, over it going back. The direction comes from `AnimatePresence`'s `custom`
 * once the step is leaving, since a leaving child never re-renders with new props.
 */
export const OnboardingStepLayer: React.FC<OnboardingStepLayerProps> = ({ direction, transition, children }) => {
  const presence = useContext(PresenceContext);
  const isPresent = presence?.isPresent ?? true;
  const leavingDirection: OnboardingStepDirection = presence?.custom === 'backward' ? 'backward' : 'forward';
  const zIndex = isPresent ? 2 : leavingDirection === 'forward' ? 1 : 3;

  return (
    <motion.div
      data-onboarding-step-layer={isPresent ? 'present' : 'leaving'}
      aria-hidden={isPresent ? undefined : true}
      className="relative col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col bg-app-bg"
      style={{ zIndex, pointerEvents: isPresent ? 'auto' : 'none' }}
      custom={direction}
      variants={onboardingStepVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={transition}
    >
      {children}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-pure-black"
        custom={direction}
        variants={onboardingStepDimVariants}
        initial="enter"
        animate="center"
        exit="exit"
        transition={transition}
      />
    </motion.div>
  );
};

export default OnboardingStepLayer;
