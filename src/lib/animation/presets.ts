/**
 * The design system's motion presets (skills/miden-wallet-frontend/references/design-system.md,
 * "Motion"). Each preset is a set of framer-motion props to spread onto a `motion.*` element:
 *
 *   const pop = usePreset('pop');
 *   <motion.div {...pop} />
 *
 * Every value comes from `springs`, `durations` and `easings`, so the whole app is tuned from
 * `lib/animation`. Read presets through `usePreset` (or `resolvePreset` where a hook can't be
 * called): under reduced motion every transition collapses to an instant tween, and `shimmer`
 * holds still instead of looping.
 *
 * - `fade`: opacity. Also the backdrop behind a `sheet`.
 * - `reveal`: height 0 <-> auto plus opacity, for disclosure content.
 * - `pop`: a small element appearing or leaving (badges, heroes, toasts).
 * - `sheet`: an overlay card rising in (dApp confirm, switcher, peek card).
 * - `page`: the incoming page of a stack. The page beneath moves to `pageSlideParallax` under a
 *   `pageSlideDim` black dim on the same transition (`page-appearance.ts`).
 * - `press`: tap feedback for a tappable surface.
 * - `indicator`: a selection indicator shared across options through a `layoutId` the caller sets.
 * - `count`: a displayed number travelling to a new value (`components/ui/AnimatedNumber`). A tween,
 *   never a spring: a spring overshoots, and a balance that overshoots shows a figure the account
 *   never held. The curve is `standard` rather than the sharper `easeOutCubic`, which spends most
 *   of a count in its first few frames and so reads as a flash with a tail.
 * - `shimmer`: a pending runner moving across its track.
 * - `shake`: a horizontal shake that says "wrong" (a rejected passcode). It has no end state
 *   to jump to, so under reduced motion it does not run at all.
 */

import { useMemo } from 'react';

import { useReducedMotion, type TargetAndTransition, type Transition } from 'framer-motion';

import { durations } from './durations';
import { easings } from './easings';
import { pageSlideEntrance } from './page-appearance';
import { springs } from './springs';
import { resolveTransition } from './use-motion';

export interface MotionPreset {
  initial?: TargetAndTransition;
  animate?: TargetAndTransition;
  exit?: TargetAndTransition;
  whileTap?: TargetAndTransition;
  transition: Transition;
}

export const presetNames = [
  'fade',
  'reveal',
  'pop',
  'sheet',
  'page',
  'press',
  'indicator',
  'count',
  'shimmer',
  'shake'
] as const;

export type PresetName = (typeof presetNames)[number];

export const presets: Record<PresetName, MotionPreset> = {
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { type: 'tween', duration: durations.fast, ease: easings.easeOutCubic }
  },
  reveal: {
    initial: { height: 0, opacity: 0 },
    animate: { height: 'auto', opacity: 1 },
    exit: { height: 0, opacity: 0 },
    transition: springs.standard
  },
  pop: {
    initial: { opacity: 0, scale: 0.92 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.96 },
    transition: springs.snappy
  },
  sheet: {
    initial: { opacity: 0, y: 24, scale: 0.96 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: 24, scale: 0.96 },
    transition: springs.sheetPresent
  },
  page: {
    initial: { x: '100%' },
    animate: { x: 0 },
    exit: { x: '100%' },
    transition: pageSlideEntrance
  },
  press: {
    whileTap: { scale: 0.96 },
    transition: springs.snappy
  },
  indicator: {
    transition: springs.pill
  },
  count: {
    transition: { type: 'tween', duration: durations.count, ease: easings.standard }
  },
  shimmer: {
    initial: { x: '-100%' },
    animate: { x: '100%' },
    transition: { type: 'tween', duration: durations.shimmer, ease: 'linear', repeat: Infinity }
  },
  shake: {
    animate: { x: [0, -10, 10, -8, 8, -4, 4, 0] },
    transition: { type: 'tween', duration: durations.slow, ease: easings.easeInOut }
  }
};

const reducedPresets: Record<PresetName, MotionPreset> = {
  fade: reduce(presets.fade),
  reveal: reduce(presets.reveal),
  pop: reduce(presets.pop),
  sheet: reduce(presets.sheet),
  page: reduce(presets.page),
  press: reduce(presets.press),
  indicator: reduce(presets.indicator),
  count: reduce(presets.count),
  // A loop has no end state to jump to, so it simply does not run.
  shimmer: { transition: resolveTransition(true, presets.shimmer.transition) },
  // Nor does a shake: it starts and ends at rest, so an instant one is no motion at all.
  shake: { transition: resolveTransition(true, presets.shake.transition) }
};

/**
 * The preset with reduced motion applied. For event handlers and other places a hook can't be
 * called: read `useReducedMotion()` at component scope and pass it here.
 */
export function resolvePreset(reduceMotion: boolean | null, name: PresetName): MotionPreset {
  return reduceMotion ? reducedPresets[name] : presets[name];
}

/** The named preset, reduced-motion aware. Spread the result onto a `motion.*` element. */
export function usePreset(name: PresetName): MotionPreset {
  const reduceMotion = useReducedMotion();
  return useMemo(() => resolvePreset(reduceMotion, name), [reduceMotion, name]);
}

function reduce(preset: MotionPreset): MotionPreset {
  return { ...preset, transition: resolveTransition(true, preset.transition) };
}
