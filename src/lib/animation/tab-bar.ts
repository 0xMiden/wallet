/**
 * Motion shared by the two tab bars: the bottom nav and the home action bar.
 *
 * A tab switch should feel like one: the highlight slides over on `springs.tabSwitch` with a single
 * visible overshoot, the newly active icon pops (up to `iconPopScale`, then back to rest on the same
 * bouncy spring), and a pressed tab dips to `pressScale`. Components read these through
 * `useTabBarMotion` and `useTabIconPop`, so reduced motion is handled here once: the highlight
 * moves instantly, the icon does not pop and a press does not scale.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useReducedMotion, type TargetAndTransition, type Transition } from 'framer-motion';

import { easings } from './easings';
import { springs } from './springs';
import { reducedMotionTransition, resolveTransition } from './use-motion';

const labelReveal: Transition = { type: 'tween', duration: 0.12, delay: 0.1, ease: easings.easeInOut };

export const tabBarMotion = {
  /** The highlight sliding to the new tab, and the action bar's segments resizing with it. */
  highlight: springs.tabSwitch,
  /** The scale a newly active tab's icon pops up to. */
  iconPopScale: 1.12,
  /** The icon rising to `iconPopScale`. */
  iconPopUp: springs.tabIconPop,
  /** The icon coming back to rest, with the same overshoot as the highlight. */
  iconPopSettle: springs.tabSwitch,
  /** The scale of a tab while it is pressed. */
  pressScale: 0.92,
  /** The press itself: quick and damped, so the dip reads as a tap, not a wobble. */
  press: springs.snappy,
  /** The action bar's label fading in once its segment has started to open. */
  label: labelReveal
};

/**
 * The instant move for whatever a retained tab pane draws in the commit `useTabShownAgain` reports
 * (the one rule: the tab bars, the filter row, the Home carousel's track, the Activity list): that
 * pane changed out of sight, so it shows its new state at once rather than sliding or popping from
 * the one it left. The reduced-motion instant (not `duration: 0`, so completion callbacks still fire),
 * named for the swap so a pane swap never reads as the user's motion preference.
 */
export const tabBarSwap: Transition = { ...reducedMotionTransition };

export interface TabBarMotion {
  /** Transition for the sliding highlight and the segments' `layout` resize. */
  highlight: Transition;
  /** Transition for the action bar's label fade. */
  label: Transition;
  /** Spread onto a tab's motion element. Empty under reduced motion. */
  press: { whileTap?: TargetAndTransition };
}

const fullMotion: TabBarMotion = {
  highlight: tabBarMotion.highlight,
  label: tabBarMotion.label,
  press: { whileTap: { scale: tabBarMotion.pressScale, transition: tabBarMotion.press } }
};

const reducedMotion: TabBarMotion = {
  highlight: resolveTransition(true, tabBarMotion.highlight),
  label: resolveTransition(true, tabBarMotion.label),
  press: {}
};

/** The tab-bar motion for a reduced-motion preference, for code that cannot call a hook. */
export function resolveTabBarMotion(reduceMotion: boolean | null): TabBarMotion {
  return reduceMotion ? reducedMotion : fullMotion;
}

/** The tab-bar motion, reduced-motion aware. */
export function useTabBarMotion(): TabBarMotion {
  const reduceMotion = useReducedMotion();
  return useMemo(() => resolveTabBarMotion(reduceMotion), [reduceMotion]);
}

export type TabIconPopPhase = 'rest' | 'pop';

export interface TabIconPop {
  /** `pop` while the icon rises to `iconPopScale`; `rest` otherwise. */
  phase: TabIconPopPhase;
  /** Motion props for the icon's wrapper. */
  animate: TargetAndTransition;
  transition: Transition;
  onAnimationComplete: () => void;
}

/**
 * The icon pop of a tab that becomes active: up to `iconPopScale`, then back to 1 once the rise
 * completes. A spring can only run between two values, so the pop is two phases rather than one
 * keyframed animation. Nothing pops on mount (the tab was already active), under reduced motion, or
 * for a tab that is inactive.
 *
 * A tab made active by a swap (its pane shown again, by a tab tap or by a link, as the filter row is;
 * see `tabBarSwap`) rests too: it only shows the state it would have had all along.
 */
export function useTabIconPop(active: boolean, swap = false): TabIconPop {
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = useState<TabIconPopPhase>('rest');
  const wasActive = useRef(active);

  useEffect(() => {
    const becameActive = active && !wasActive.current;
    wasActive.current = active;
    if (!active || reduceMotion) setPhase('rest');
    else if (becameActive && !swap) setPhase('pop');
  }, [active, reduceMotion, swap]);

  const onAnimationComplete = useCallback(() => setPhase('rest'), []);
  const popping = phase === 'pop';

  return {
    phase,
    animate: { scale: popping ? tabBarMotion.iconPopScale : 1 },
    transition: resolveTransition(reduceMotion, popping ? tabBarMotion.iconPopUp : tabBarMotion.iconPopSettle),
    onAnimationComplete
  };
}
