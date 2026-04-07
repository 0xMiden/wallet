/**
 * Reduced-motion-aware transition helpers.
 *
 * PR-7: when the OS reports `prefers-reduced-motion`, spring transitions
 * across the new dApp browser module collapse to an instant tween. The
 * goal is to kill any bouncy / spring motion but preserve the
 * *structural* transitions (tiles still "morph" into the capsule, the
 * switcher still animates in/out, etc.) so the information hierarchy
 * stays intact for users who can parse motion but find springs
 * overstimulating.
 *
 * Every animated component in the new browser stack should route its
 * transitions through these helpers instead of importing from
 * `springs.ts` directly — that way the reduce-motion switch flips
 * uniformly across the whole experience without a per-component audit.
 */

import { useMemo } from 'react';

import { useReducedMotion, type Transition } from 'framer-motion';

import { springs as rawSprings, type SpringName } from './springs';

/**
 * Returns the given transition unchanged unless the user has requested
 * reduced motion, in which case it returns an instant tween.
 *
 * Usage: `<motion.div transition={useMotion(springs.morph)} />`.
 */
export function useMotion(transition: Transition): Transition {
  const reduce = useReducedMotion();
  if (reduce) {
    return instantTransition();
  }
  return transition;
}

/**
 * Returns the full springs preset table with reduce-motion applied. Use
 * this when a component needs multiple named springs — you only call
 * the hook once and index into the returned object.
 *
 * Usage:
 *   const springs = useSprings();
 *   return <motion.div transition={springs.morph} />;
 */
export function useSprings(): typeof rawSprings {
  const reduce = useReducedMotion();
  return useMemo(() => {
    if (!reduce) return rawSprings;
    const reduced = instantTransition();
    const out = {} as typeof rawSprings;
    for (const key of Object.keys(rawSprings) as SpringName[]) {
      out[key] = reduced;
    }
    return out;
  }, [reduce]);
}

/**
 * Direct transition accessor for cases where a hook isn't feasible —
 * e.g. inside a `useAnimationControls().start({ transition })` call
 * from within an event handler, where the rules of hooks forbid
 * re-reading the reduce-motion preference.
 *
 * Consumers in that pattern should call `useReducedMotion()` at the
 * top of their component, store the boolean, and call
 * `resolveTransition(reduce, springs.standard)` from their handler.
 */
export function resolveTransition(reduce: boolean | null, transition: Transition): Transition {
  if (reduce) return instantTransition();
  return transition;
}

function instantTransition(): Transition {
  return { duration: 0.001 };
}
