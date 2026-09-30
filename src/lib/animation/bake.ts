/**
 * Motion for the mainnet welcome: an oven bakes the "Testnet" dough into the "Mainnet" loaf, then
 * the welcome screen comes in (`components/MainnetWelcome`).
 *
 * The scene is a fixed sequence of phases. A timer moves it from one phase to the next, and each
 * part of the scene reads its target from the current phase:
 *
 *   enter   the dough comes in under the oven, with its "Testnet" label
 *   open    the oven door opens
 *   load    the dough goes into the oven
 *   close   the door closes
 *   bake    the oven glows, shakes and steams, and the dough turns into the loaf
 *   ding    the door opens again
 *   serve   the loaf comes out, larger, with its "Mainnet" label and sparkles
 *   welcome the oven goes away, the loaf moves to the centre, and the text and the button come in
 *
 * `welcome` is the last phase and has no timer. Under reduced motion the scene starts there, so
 * nothing moves: the user sees the loaf, the text and the button at once.
 */

import type { Transition } from 'framer-motion';

import { durations } from './durations';
import { easings } from './easings';
import { springs } from './springs';

export const BAKE_PHASES = ['enter', 'open', 'load', 'close', 'bake', 'ding', 'serve', 'welcome'] as const;

export type BakePhase = (typeof BAKE_PHASES)[number];

/** A phase that a timer ends. `welcome` stays until the user continues. */
export type TimedBakePhase = Exclude<BakePhase, 'welcome'>;

/** How long each phase stays before the subsequent one starts. The full sequence is 5.4 s. */
export const BAKE_PHASE_MS: Record<TimedBakePhase, number> = {
  enter: 700,
  open: 350,
  load: 650,
  close: 400,
  bake: 1800,
  ding: 400,
  serve: 1100
};

/** The phase after `phase`. `welcome` has no subsequent phase and returns itself. */
export function nextBakePhase(phase: BakePhase): BakePhase {
  const next = BAKE_PHASES[BAKE_PHASES.indexOf(phase) + 1];
  return next ?? 'welcome';
}

/** True when `phase` is `target` or a later phase. */
export function bakePhaseReached(phase: BakePhase, target: BakePhase): boolean {
  return BAKE_PHASES.indexOf(phase) >= BAKE_PHASES.indexOf(target);
}

/** A loop that goes to its target and back, for as long as its element shows. */
const mirrorLoop = (duration: number): Transition => ({
  type: 'tween',
  duration,
  ease: easings.easeInOut,
  repeat: Infinity,
  repeatType: 'mirror'
});

export const bakeMotion = {
  /** The door's swing on its bottom hinge. */
  door: springs.standard,
  /** The dough on its way to the oven and into it. */
  travel: springs.standard,
  /** The loaf on its way out: one visible overshoot, so it lands with a bounce. */
  serve: springs.magnetic,
  /** The dough turns into the loaf across the whole `bake` phase, so the change is gradual. */
  brown: { type: 'tween', duration: BAKE_PHASE_MS.bake / 1000, ease: 'linear' },
  /** Labels, the oven's exit and the glow's start and end. */
  fade: { type: 'tween', duration: durations.normal, ease: easings.easeOutCubic },
  /** The heat in the oven, brighter and dimmer. */
  glow: mirrorLoop(durations.extraSlow),
  /** The oven's small shake while it bakes. */
  wobble: mirrorLoop(durations.fast),
  /** One puff of steam from the bottom of its path to the top. */
  steam: { type: 'tween', duration: durations.shimmer, ease: easings.easeOutCubic, repeat: Infinity },
  /** A sparkle's first pop. */
  sparkle: springs.snappy,
  /** A sparkle's slow twinkle on the welcome screen. */
  twinkle: mirrorLoop(durations.shimmer),
  /** The welcome text and the button. */
  reveal: springs.standard
} satisfies Record<string, Transition>;

/** The delay between one steam puff, or one sparkle, and the subsequent one. */
export const BAKE_STAGGER_S = durations.fast;
