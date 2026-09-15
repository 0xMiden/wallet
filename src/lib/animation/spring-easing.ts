/**
 * Converts a spring preset from `springs.ts` into a `linear()` easing that the
 * compositor can run on its own.
 *
 * Framer Motion computes springs on the main thread: it steps the physics every
 * `requestAnimationFrame` and writes the result to an element's inline style.
 * That is the right default — it is interruptible, composable, and driven by the
 * same clock as the rest of the app. It also means the animation can only be as
 * smooth as the main thread is idle, and inside `WKWebView` it can only ever be
 * as fast as `requestAnimationFrame`, which Apple caps at 60Hz regardless of the
 * display (WebKit bug 294338).
 *
 * A Web Animations API animation over `transform` alone escapes both limits: it
 * is handed to the compositor, so it neither blocks on main-thread work nor
 * samples at the `rAF` rate. The cost is that it has to be described up front as
 * a fixed duration plus an easing curve, which a spring is not. So we solve the
 * spring analytically, sample it, and hand the samples over as `linear()`.
 *
 * Use this only where those two properties are worth losing framer's
 * interruptibility — a gesture release that must not hitch is the motivating
 * case. Everything else should keep using `useMotion` / `useSprings`.
 */

import type { Transition } from 'framer-motion';

/** Sampling interval for the emitted curve. */
const SAMPLE_STEP_MS = 4;
/** Hard ceiling so a pathological spring can't emit an enormous easing string. */
const MAX_DURATION_MS = 2000;
/** Distances below this are not worth animating. */
const MIN_DISTANCE_PX = 0.5;

export interface CompositorSpring {
  /** Duration in milliseconds, i.e. when the spring has settled. */
  duration: number;
  /** A CSS `linear()` easing function tracing the spring's path. */
  easing: string;
}

interface SpringEasingOptions {
  /** Signed distance still to travel: `from - to`. */
  distance: number;
  /** Velocity at the start, in px/s, positive in the direction of increasing value. */
  velocity?: number;
  /** How close counts as arrived. Matches framer's own default. */
  restDelta?: number;
}

/**
 * Solves `transition` as a damped harmonic oscillator and samples it.
 *
 * Returns null when the transition is not a spring (a reduced-motion instant
 * tween, say) or the distance is too small to be worth animating, so callers can
 * fall back to setting the final value directly.
 */
export function springToLinearEasing(
  transition: Transition,
  { distance, velocity = 0, restDelta = 0.5 }: SpringEasingOptions
): CompositorSpring | null {
  const { stiffness, damping, mass } = transition as {
    stiffness?: number;
    damping?: number;
    mass?: number;
  };
  if (typeof stiffness !== 'number' || typeof damping !== 'number') return null;
  if (Math.abs(distance) < MIN_DISTANCE_PX) return null;

  const displacement = solveSpring(stiffness, damping, mass ?? 1, distance, velocity);

  // Settle time is where the spring stops moving perceptibly, not where the
  // analytical solution reaches zero — it never does. Keep scanning past the
  // first quiet sample, because an underdamped spring crosses the target and
  // comes back, and stopping at the first crossing would truncate the overshoot.
  let duration = SAMPLE_STEP_MS;
  for (let t = SAMPLE_STEP_MS; t <= MAX_DURATION_MS; t += SAMPLE_STEP_MS) {
    if (Math.abs(displacement(t / 1000)) > restDelta) duration = t + SAMPLE_STEP_MS;
  }

  const points: string[] = [];
  for (let t = 0; t <= duration; t += SAMPLE_STEP_MS) {
    // Progress, not position, since `linear()` drives keyframe interpolation.
    // Values outside 0..1 are legal and are what preserves any overshoot.
    points.push(round(1 - displacement(t / 1000) / distance));
  }
  // Land exactly on target rather than wherever the last sample happened to be.
  points[points.length - 1] = '1';

  return { duration, easing: `linear(${points.join(',')})` };
}

/**
 * Returns displacement from the target over time, in the spring's own units.
 * `t` is in seconds.
 */
function solveSpring(
  stiffness: number,
  damping: number,
  mass: number,
  from: number,
  velocity: number
): (t: number) => number {
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (zeta < 1) {
    const omegaDamped = omega * Math.sqrt(1 - zeta * zeta);
    const c = (velocity + zeta * omega * from) / omegaDamped;
    return t => Math.exp(-zeta * omega * t) * (from * Math.cos(omegaDamped * t) + c * Math.sin(omegaDamped * t));
  }

  if (zeta === 1) {
    return t => Math.exp(-omega * t) * (from + (velocity + omega * from) * t);
  }

  const rate = omega * Math.sqrt(zeta * zeta - 1);
  const fast = -zeta * omega + rate;
  const slow = -zeta * omega - rate;
  const fastPart = (velocity - slow * from) / (fast - slow);
  const slowPart = from - fastPart;
  return t => fastPart * Math.exp(fast * t) + slowPart * Math.exp(slow * t);
}

function round(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}
