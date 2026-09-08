import type { Transition } from 'framer-motion';

export const pageAppearance: Transition = {
  type: 'tween',
  duration: 0.12,
  ease: 'easeOut'
};

export const pageSlideEntrance: Transition = {
  type: 'tween',
  duration: 0.34,
  ease: [0.4, 0, 0.2, 1]
};
