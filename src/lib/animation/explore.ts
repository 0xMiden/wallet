/**
 * Motion for the Explore tab, tuned to feel like the tab bars.
 *
 * - Press: every tappable card, row and tile dips to the tab bars' `pressScale` on their quick
 *   press spring, and springs back on `springs.tabSwitch`, so it lands with the same single
 *   overshoot as the tab highlight.
 * - Reveal: on the page's first mount, sections come in once, each `revealOffset` below its place
 *   and transparent, staggered by `revealStagger`. The rise rides `tabSwitch`; the fade is a short
 *   tween, so the whole page has settled in under ~300ms.
 * - Filter: sections a chip hides fade out (`exit`) while the rest close the gap with a layout
 *   animation on `tabSwitch`; sections it shows rise in like the reveal, without the stagger.
 *
 * Read through `useExploreMotion` (or `resolveExploreMotion`), which handles reduced motion once:
 * no press scale, no reveal, and every change instant.
 */

import { useMemo } from 'react';

import { useReducedMotion, type TargetAndTransition, type Transition, type Variants } from 'framer-motion';

import { durations } from './durations';
import { easings } from './easings';
import { springs } from './springs';
import { tabBarMotion } from './tab-bar';
import { resolveTransition } from './use-motion';

const fadeIn: Transition = { type: 'tween', duration: durations.fast, ease: easings.easeOutCubic };

export const exploreMotion = {
  /** The scale a pressed card, row or tile dips to: the tab bars' press. */
  pressScale: tabBarMotion.pressScale,
  /** Into the press: quick and damped. */
  pressIn: tabBarMotion.press,
  /** Out of the press, and every layout move on the page: the tab switch's bounce. */
  settle: springs.tabSwitch,
  /** How far below its place a section starts its reveal, in px. */
  revealOffset: 12,
  /** Delay between one section's reveal and the next, in seconds. */
  revealStagger: 0.035,
  /** Sections past this index reveal together, so a long page still settles quickly. */
  revealMaxStagger: 4,
  /** A section's opacity coming in or going out. */
  fade: fadeIn
};

/** The variant names a section moves between. */
export const exploreSectionVariant = { hidden: 'hidden', shown: 'shown', gone: 'gone' } as const;

export interface ExploreMotion {
  /** Spread onto a tappable card, row or tile. Under reduced motion only the instant settle is left. */
  press: { whileTap?: TargetAndTransition; transition: Transition };
  /** Transition of a section's `layout` move. */
  layout: Transition;
  /** A section's variants; `shown` takes the section's index (`custom`) for its stagger. */
  section: Variants;
  /** Whether a section rises in at all. False under reduced motion. */
  reveal: boolean;
}

function sectionVariants(reduce: boolean): Variants {
  if (reduce) {
    const instant = resolveTransition(true, exploreMotion.fade);
    return {
      hidden: { opacity: 1, y: 0 },
      shown: { opacity: 1, y: 0, transition: instant },
      gone: { opacity: 0, transition: instant }
    };
  }
  return {
    hidden: { opacity: 0, y: exploreMotion.revealOffset },
    shown: (index: number) => ({
      opacity: 1,
      y: 0,
      transition: {
        default: exploreMotion.settle,
        opacity: exploreMotion.fade,
        delay: Math.min(Math.max(index, 0), exploreMotion.revealMaxStagger) * exploreMotion.revealStagger
      }
    }),
    gone: { opacity: 0, transition: exploreMotion.fade }
  };
}

const fullMotion: ExploreMotion = {
  press: {
    whileTap: { scale: exploreMotion.pressScale, transition: exploreMotion.pressIn },
    transition: exploreMotion.settle
  },
  layout: exploreMotion.settle,
  section: sectionVariants(false),
  reveal: true
};

const reducedMotion: ExploreMotion = {
  press: { transition: resolveTransition(true, exploreMotion.settle) },
  layout: resolveTransition(true, exploreMotion.settle),
  section: sectionVariants(true),
  reveal: false
};

/** Explore's motion for a reduced-motion preference, for code that cannot call a hook. */
export function resolveExploreMotion(reduceMotion: boolean | null): ExploreMotion {
  return reduceMotion ? reducedMotion : fullMotion;
}

/** Explore's motion, reduced-motion aware. */
export function useExploreMotion(): ExploreMotion {
  const reduceMotion = useReducedMotion();
  return useMemo(() => resolveExploreMotion(reduceMotion), [reduceMotion]);
}
