/**
 * Standard animation durations (in seconds).
 *
 * Use these for tween/CSS transitions where a spring isn't appropriate
 * (e.g. opacity fades, color crossfades, layout-only transitions).
 */

export const durations = {
  fast: 0.18,
  normal: 0.28,
  slow: 0.42,
  extraSlow: 0.6,
  /** A stacked page sliding in or out, and the page beneath moving with it (`presets.page`) */
  page: 0.34,
  /** A step swap inside one page: the `Navigator` flows and onboarding (`pageStepTransition`) */
  pageStep: 0.15,
  /**
   * A displayed number travelling from its old value to its new one (`presets.count`). Longer than
   * `normal` on purpose: the whole point of the count is that the reader sees which way the number
   * moved, and much under half a second reads as a flash rather than a climb.
   */
  count: 0.6,
  /** One pass of a looping shimmer (`presets.shimmer`) */
  shimmer: 1.2
} as const;

export type DurationName = keyof typeof durations;
