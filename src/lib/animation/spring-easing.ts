/**
 * Turns a spring preset from `springs.ts` into a fixed-duration curve that CSS or the Web
 * Animations API can play without framer stepping it.
 *
 * Framer Motion computes springs on the main thread: it steps the physics every
 * `requestAnimationFrame` and writes the result to an element's inline style.
 * That is the right default - it is interruptible, composable, and driven by the
 * same clock as the rest of the app. Inside `WKWebView` it can only ever be as
 * fast as `requestAnimationFrame`, whose cap is WebKit's
 * `PreferPageRenderingUpdatesNear60FPSEnabled` preference (WebKit bug 294338).
 * `AppViewController` turns it off (#1864).
 *
 * Measured on an iPhone 17 Pro Max (iOS 26.5, #1841), WebKit runs a `linear()`
 * timing function at 60Hz too, like rAF. Keyframes sampled from the spring with
 * linear segments between them (`springKeyframeStops`), and `cubic-bezier`
 * timing, run at 120Hz on the compositor. So a spring that has to run at the
 * display's rate is solved analytically and handed over as sampled keyframes;
 * `springToLinearEasing` remains for callers that need a single timing function.
 *
 * Use this only where those properties are worth losing framer's
 * interruptibility - a gesture release that must not hitch is the motivating
 * case. Everything else should keep using `useMotion` / `useSprings`.
 */

import type { Transition } from 'framer-motion';

/** Sampling interval for the emitted curve. */
const SAMPLE_STEP_MS = 4;
/** Keyframe stride. Two solver samples, so a stop still lands every 8 ms. */
const KEYFRAME_STEP_MS = 8;
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

export interface SpringSamples {
  /** Duration in milliseconds, i.e. when the spring has settled. */
  duration: number;
  /** Progress every `SAMPLE_STEP_MS`, from 0 to exactly 1; overshoot is above 1. */
  progress: number[];
}

export interface SpringKeyframeStop {
  /** Position in the animation, 0..1. */
  offset: number;
  progress: number;
}

export interface SpringKeyframeStops {
  duration: number;
  stops: SpringKeyframeStop[];
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
 * Solves `transition` as a damped harmonic oscillator and samples it every
 * `SAMPLE_STEP_MS`. `progress` is how far along the travel the spring is, so
 * values outside 0..1 are the overshoot; it starts at 0 and ends on exactly 1.
 *
 * Returns null when the transition is not a spring (a reduced-motion instant
 * tween, say) or the distance is too small to be worth animating, so callers can
 * fall back to setting the final value directly.
 */
export function sampleSpring(
  transition: Transition,
  { distance, velocity = 0, restDelta = 0.5 }: SpringEasingOptions
): SpringSamples | null {
  const { stiffness, damping, mass } = transition as {
    stiffness?: number;
    damping?: number;
    mass?: number;
  };
  if (typeof stiffness !== 'number' || typeof damping !== 'number') return null;
  if (Math.abs(distance) < MIN_DISTANCE_PX) return null;

  const physics = { stiffness, damping, mass: mass ?? 1 };
  const displacement = (t: number) => solveSpring(physics, distance, velocity, t).displacement;

  // Settle time is where the spring stops moving perceptibly, not where the
  // analytical solution reaches zero — it never does. Keep scanning past the
  // first quiet sample, because an underdamped spring crosses the target and
  // comes back, and stopping at the first crossing would truncate the overshoot.
  let duration = SAMPLE_STEP_MS;
  for (let t = SAMPLE_STEP_MS; t <= MAX_DURATION_MS; t += SAMPLE_STEP_MS) {
    if (Math.abs(displacement(t / 1000)) > restDelta) duration = t + SAMPLE_STEP_MS;
  }

  const progress: number[] = [];
  for (let t = 0; t <= duration; t += SAMPLE_STEP_MS) {
    progress.push(1 - displacement(t / 1000) / distance);
  }
  // Land exactly on target rather than wherever the last sample happened to be.
  progress[progress.length - 1] = 1;

  return { duration, progress };
}

/**
 * Solves `transition` and formats it as a `linear()` easing. Null under the same
 * conditions as `sampleSpring`.
 */
export function springToLinearEasing(transition: Transition, options: SpringEasingOptions): CompositorSpring | null {
  const samples = sampleSpring(transition, options);
  if (!samples) return null;
  // Progress, not position, since `linear()` drives keyframe interpolation.
  // Values outside 0..1 are legal and are what preserves any overshoot.
  return { duration: samples.duration, easing: `linear(${samples.progress.map(round).join(',')})` };
}

/**
 * The same spring as explicit keyframe stops. WebKit runs a `linear()` easing at
 * 60 Hz but samples keyframes at the display rate, so a spring that has to track
 * a 120 Hz panel goes through offsets instead. Every `KEYFRAME_STEP_MS / SAMPLE_STEP_MS`-th
 * sample is kept, plus the final one.
 */
export function springKeyframeStops(transition: Transition, options: SpringEasingOptions): SpringKeyframeStops | null {
  const samples = sampleSpring(transition, options);
  if (!samples) return null;

  const stride = Math.max(1, Math.round(KEYFRAME_STEP_MS / SAMPLE_STEP_MS));
  const last = samples.progress.length - 1;
  const stops: SpringKeyframeStop[] = [];
  samples.progress.forEach((progress, i) => {
    if (i < last && i % stride === 0) stops.push({ offset: (i * SAMPLE_STEP_MS) / samples.duration, progress });
  });
  stops.push({ offset: 1, progress: 1 });

  return { duration: samples.duration, stops };
}

let linearEasingSupported: boolean | undefined;

/**
 * Whether the engine parses `linear()` easing. WebKit does only from Safari 17.2, and
 * `Element.animate` throws on an easing it cannot parse, so every caller of
 * `springToLinearEasing` checks this first. Computed once; false where `CSS.supports` is missing.
 */
export function supportsLinearEasing(): boolean {
  linearEasingSupported ??=
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('transition-timing-function', 'linear(0, 1)');
  return linearEasingSupported;
}

/**
 * Displacement from the target and its rate after `t` seconds, from an initial
 * displacement and rate. `t` is in seconds.
 */
export function solveSpring(
  { stiffness, damping, mass }: { stiffness: number; damping: number; mass: number },
  from: number,
  velocity: number,
  t: number
): { displacement: number; rate: number } {
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (zeta < 1) {
    const omegaDamped = omega * Math.sqrt(1 - zeta * zeta);
    const c = (velocity + zeta * omega * from) / omegaDamped;
    const decay = Math.exp(-zeta * omega * t);
    const cos = Math.cos(omegaDamped * t);
    const sin = Math.sin(omegaDamped * t);
    return {
      displacement: decay * (from * cos + c * sin),
      rate: decay * ((c * omegaDamped - zeta * omega * from) * cos - (from * omegaDamped + zeta * omega * c) * sin)
    };
  }

  if (zeta === 1) {
    const decay = Math.exp(-omega * t);
    const slope = velocity + omega * from;
    return { displacement: decay * (from + slope * t), rate: decay * (velocity - omega * slope * t) };
  }

  const spread = omega * Math.sqrt(zeta * zeta - 1);
  const fast = -zeta * omega + spread;
  const slow = -zeta * omega - spread;
  const fastPart = (velocity - slow * from) / (fast - slow);
  const slowPart = from - fastPart;
  return {
    displacement: fastPart * Math.exp(fast * t) + slowPart * Math.exp(slow * t),
    rate: fastPart * fast * Math.exp(fast * t) + slowPart * slow * Math.exp(slow * t)
  };
}

function round(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}
