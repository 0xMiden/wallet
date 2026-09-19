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
  /** One pass of a looping shimmer (`presets.shimmer`) */
  shimmer: 1.2,
  /** One breath of a looping status pulse (`presets.pulse`) */
  pulse: 1.6
} as const;

export type DurationName = keyof typeof durations;
