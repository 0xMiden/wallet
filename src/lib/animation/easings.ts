/**
 * Standard easing curves for tween animations.
 *
 * These cubic-bezier tuples are framer-motion compatible.
 * Use a spring from `springs.ts` when possible — easings are for
 * cases where you specifically need a tween (e.g. opacity-only transitions).
 */

export const easings = {
  /** iOS soft-out — feels right for entering content */
  easeOutCubic: [0.16, 1, 0.3, 1] as const,
  /** Symmetrical, balanced */
  easeInOut: [0.65, 0, 0.35, 1] as const,
  /** Slight overshoot — used for the bubble pop-in on park */
  easeOutBack: [0.34, 1.56, 0.64, 1] as const
};

export type EasingName = keyof typeof easings;
