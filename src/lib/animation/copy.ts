/**
 * Motion for the copy confirmation, shared by every copy control (`CopyButton`, `CopyChip` and the
 * seed-phrase copy actions through `AnimatedCopyIcon` and `CopyLabel`).
 *
 * The copy glyph morphs into a check: the outgoing glyph shrinks, turns and blurs away while the
 * incoming one grows, straightens and sharpens in its place, both on the tab bar's `tabSwitch`
 * spring (one small overshoot). A text action rolls its label instead: "Copy" rises out of the
 * slot as "Copied" rises in from below. The check and the "Copied" label hold for
 * `COPY_FEEDBACK_MS`, then the same motion runs back.
 *
 * Modelled on Animate UI's Copy Button (scale + blur crossfade under `AnimatePresence
 * mode="popLayout"`) and the shadcn.io Copy Text roll. Under reduced motion the components skip
 * `AnimatePresence` altogether, so the swap is instant: no scale, blur, rotation or travel.
 */

import type { TargetAndTransition, Transition } from 'framer-motion';

import { durations } from './durations';
import { easings } from './easings';
import { springs } from './springs';

export interface CopySwapMotion {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
  transition: Transition;
}

export interface CopyMotion {
  /** The copy glyph ↔ check morph. */
  icon: CopySwapMotion;
  /** The "Copy" ↔ "Copied" label roll. */
  label: CopySwapMotion;
}

/** How long the check (or "Copied") holds before morphing back. */
export const COPY_FEEDBACK_MS = 1500;

// Geometry (scale, rotate, travel) rides the spring and may overshoot; opacity and blur must not —
// a blur that overshoots past 0 is an invalid filter, and an opacity past 1 is clamped anyway — so
// they fade on a short tween alongside it.
const swapTransition: Transition = {
  ...springs.tabSwitch,
  opacity: { type: 'tween', duration: durations.fast, ease: easings.easeOutCubic },
  filter: { type: 'tween', duration: durations.fast, ease: easings.easeOutCubic }
};

export const copyMotion: CopyMotion = {
  icon: {
    initial: { opacity: 0, scale: 0.6, rotate: -25, filter: 'blur(4px)' },
    animate: { opacity: 1, scale: 1, rotate: 0, filter: 'blur(0px)' },
    exit: { opacity: 0, scale: 0.6, rotate: 25, filter: 'blur(4px)' },
    transition: swapTransition
  },
  label: {
    initial: { opacity: 0, y: '100%', filter: 'blur(2px)' },
    animate: { opacity: 1, y: '0%', filter: 'blur(0px)' },
    exit: { opacity: 0, y: '-100%', filter: 'blur(2px)' },
    transition: swapTransition
  }
};
