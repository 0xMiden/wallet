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
  extraSlow: 0.6
} as const;

export type DurationName = keyof typeof durations;
