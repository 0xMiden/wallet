/**
 * Timings and spring math for the native dApp morph (#1817).
 *
 * The plugin moves the live dApp page itself, on one progress value p (0 at the peek card, 1 at the
 * browser slot), with the `morph*` springs in `springs.ts`. The app sends one command per transition and
 * learns the rest from `presentationMorph` events. Between events it still has to know where the spring
 * is, and when it crosses a threshold, for the host companions (capsule, launcher) that move alongside
 * the page, so it solves the same spring analytically here.
 */

import type { Transition } from 'framer-motion';

/** Design timings of the morph (research section 3). Durations in ms, progress values in p units. */
export interface MorphTiming {
  /** Expand: the snapshot proxy fades into the live page once the paint fence passes. */
  expandCrossfadeMs: number;
  /** Collapse: the live page fades into the snapshot proxy. */
  collapseCrossfadeMs: number;
  /** Collapse: p at which that crossfade starts. */
  collapseCrossfadeProgress: number;
  /** The capsule fading out (and back in) around the morph. */
  capsuleFadeMs: number;
  /** How far the capsule lifts while it fades out, in CSS px. */
  capsuleLiftPx: number;
  /** Expand: p at which the capsule starts fading back in. */
  capsuleFadeInProgress: number;
  /** The landing card's chrome fading in after the handoff. */
  chromeFadeMs: number;
  /** Reduced motion: the alpha fade that replaces the morph. */
  reducedFadeMs: number;
  /** Longest wait for two frames before a settled collapse is acknowledged with a hide. */
  ackTimeoutMs: number;
  /** A motion with no event for this long is resolved by the provider's watchdog. */
  eventTimeoutMs: number;
  /** The launcher's scale at the start of a collapse. */
  launcherScaleFrom: number;
}

export const MORPH_TIMING: Readonly<MorphTiming> = Object.freeze({
  expandCrossfadeMs: 120,
  collapseCrossfadeMs: 100,
  collapseCrossfadeProgress: 0.35,
  capsuleFadeMs: 160,
  capsuleLiftPx: 8,
  capsuleFadeInProgress: 0.6,
  chromeFadeMs: 150,
  reducedFadeMs: 200,
  ackTimeoutMs: 300,
  eventTimeoutMs: 2000,
  launcherScaleFrom: 0.97
});

/** A spring's position and its time derivative at one instant. */
export interface SpringSample {
  value: number;
  /** Units per second. */
  velocity: number;
}

interface SpringPhysics {
  stiffness: number;
  damping: number;
  mass: number;
}

const SAMPLE_STEP_MS = 1;
const MAX_DURATION_MS = 2000;

/**
 * Where a spring from `from` to `to`, starting with `velocity` (units per second), is after `seconds`.
 * A transition without spring physics (a reduced-motion tween) has already arrived.
 */
export function springProgressAt(
  transition: Transition,
  seconds: number,
  from: number,
  to: number,
  velocity: number
): SpringSample {
  const physics = springPhysics(transition);
  if (!physics) return { value: to, velocity: 0 };
  const { displacement, rate } = solveSpring(physics, from - to, velocity, seconds);
  return { value: to + displacement, velocity: rate };
}

/**
 * The first time, in seconds, the spring reaches `value`, or null when it does not within 2 s or the
 * transition is not a spring. Sampled every millisecond and interpolated between samples.
 */
export function springTimeToReach(
  transition: Transition,
  from: number,
  to: number,
  velocity: number,
  value: number
): number | null {
  if (!springPhysics(transition)) return null;
  let previous = from - value;
  if (previous === 0) return 0;
  // Only a crossing toward the side the spring arrives on counts: a reversal that first carries the
  // spring back across the value has not reached it yet. A value past the target is reached on the way out.
  const travel = Math.sign(to - from) || Math.sign(velocity);
  const side = (value - to) * travel > 0 ? Math.sign(value - to) : Math.sign(to - value);
  for (let ms = SAMPLE_STEP_MS; ms <= MAX_DURATION_MS; ms += SAMPLE_STEP_MS) {
    const current = springProgressAt(transition, ms / 1000, from, to, velocity).value - value;
    const arrives = side === 0 || Math.sign(current) === side || (current === 0 && Math.sign(previous) === -side);
    if (Math.sign(current) !== Math.sign(previous) && arrives) {
      // The crossing lies between this sample and the last; interpolating keeps it well inside 1 ms.
      return (ms - (SAMPLE_STEP_MS * current) / (current - previous)) / 1000;
    }
    previous = current;
  }
  return null;
}

function springPhysics({ stiffness, damping, mass }: Transition): SpringPhysics | null {
  if (typeof stiffness !== 'number' || typeof damping !== 'number') return null;
  return { stiffness, damping, mass: mass ?? 1 };
}

// The damped oscillator of `spring-easing.ts`, with its derivative: displacement from the target and
// its rate after `t` seconds, from an initial displacement and rate.
function solveSpring(
  { stiffness, damping, mass }: SpringPhysics,
  from: number,
  velocity: number,
  t: number
): { displacement: number; rate: number } {
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  // Every morph spring is underdamped (damping ratio 0.82 to 0.90); the other branches keep the port whole.
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
