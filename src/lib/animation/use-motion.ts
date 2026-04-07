/**
 * Reduced-motion-aware transition wrapper.
 *
 * In PR-0 this is stubbed to a passthrough. PR-7 plumbs the actual
 * `prefers-reduced-motion` behavior: when reduced motion is requested,
 * spring transitions become `{ duration: 0.001 }` (effectively instant)
 * but drag-to-minimize still works — it just snaps without animation.
 *
 * Every animated component in the new browser stack should call its
 * transitions through this hook instead of inlining the spring directly,
 * so PR-7's reduce-motion sweep can apply uniformly.
 */

import { useReducedMotion, type Transition } from 'framer-motion';

/**
 * Returns the given transition unchanged unless the user has requested
 * reduced motion, in which case it returns an instant tween.
 */
export function useMotion(transition: Transition): Transition {
  const reduce = useReducedMotion();
  if (reduce) {
    return { duration: 0.001 };
  }
  return transition;
}
