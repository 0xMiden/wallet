/**
 * Host companions of the native dApp morph (#1817): the capsule and the launcher move alongside the page.
 *
 * The page itself moves natively; the host only hears where it is from `presentationMorph` events. So each event
 * starts compositor-only Web Animations (opacity and transform) from the values the elements show now, the launcher
 * on the page's own spring sampled into a `linear()` easing, the capsule on a short fade. Nothing runs on the main
 * thread between events.
 */

import type { MorphTarget } from '@miden/dapp-browser';
import { MORPH_TIMING, springTimeToReach, springToLinearEasing, springs, supportsLinearEasing } from 'lib/animation';

export interface CompanionElements {
  capsule: HTMLElement | null;
  launcher: HTMLElement | null;
}

/** Where the page was at the event that starts the companions: its end, p (0 card, 1 slot) and dp/dt per second. */
export interface CompanionMotion {
  target: MorphTarget;
  progress: number;
  velocity: number;
}

// The launcher's spring is solved in thousandths of its path, so the settle threshold (half a unit) is 0.05%.
const PATH_UNITS = 1000;
const running = new WeakMap<HTMLElement, Animation[]>();

/**
 * Animates the capsule and the launcher toward `motion.target`, replacing the set a previous event started. Returns
 * the stop, which puts both back to their own styles; a set a later event replaced is already stopped.
 */
export function startMorphCompanions(
  elements: CompanionElements,
  motion: CompanionMotion,
  reduceMotion: boolean
): () => void {
  const { capsule, launcher } = elements;
  const collapsing = motion.target === 'collapsed';
  const capsuleFrom = capsule ? readCapsule(capsule) : null;
  const animations: Animation[] = [];
  // 'both': a delayed fade must hold its sampled start, or the element shows its own style until the delay ends.
  const play = (element: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    const animation = element.animate(keyframes, { fill: 'both', ...options });
    animations.push(animation);
    running.set(element, [...(running.get(element) ?? []), animation]);
  };
  for (const element of [capsule, launcher]) if (element) stopRunning(element);

  // How much of the launcher shows: none while the page fills the slot, all once it rests on its card.
  const shown = 1 - Math.min(1, Math.max(0, motion.progress));
  const shownTo = collapsing ? 1 : 0;
  const capsuleTo = collapsing ? { opacity: 0, lift: -MORPH_TIMING.capsuleLiftPx } : { opacity: 1, lift: 0 };
  if (capsule && capsuleFrom) {
    // Inert while the page moves either way: an expand holds it invisible through its delay. The stop gives it back.
    capsule.style.pointerEvents = 'none';
    const delay = collapsing || reduceMotion ? 0 : capsuleFadeInDelay(motion);
    const duration = reduceMotion
      ? MORPH_TIMING.reducedFadeMs
      : MORPH_TIMING.capsuleFadeMs * Math.abs(capsuleTo.opacity - capsuleFrom.opacity);
    const keyframes = reduceMotion
      ? [{ opacity: capsuleFrom.opacity }, { opacity: capsuleTo.opacity }]
      : [capsuleFrame(capsuleFrom), capsuleFrame(capsuleTo)];
    const snap = !reduceMotion && !supportsLinearEasing();
    play(capsule, keyframes, snap ? { duration: 0 } : { duration, delay, easing: 'ease-out' });
  }

  if (launcher) {
    const spring =
      reduceMotion || !supportsLinearEasing()
        ? null
        : springToLinearEasing(collapsing ? springs.morphCollapse : springs.morphExpand, {
            distance: (shown - shownTo) * PATH_UNITS,
            velocity: -motion.velocity * PATH_UNITS
          });
    if (reduceMotion) {
      play(launcher, [{ opacity: shown }, { opacity: shownTo }], {
        duration: MORPH_TIMING.reducedFadeMs,
        easing: 'ease-out'
      });
    } else {
      play(launcher, [launcherFrame(shown), launcherFrame(shownTo)], spring ? spring : { duration: 0 });
    }
  }

  return () => {
    for (const element of [capsule, launcher]) {
      if (!element) continue;
      const mine = running.get(element)?.filter(animation => animations.includes(animation)) ?? [];
      if (mine.length === 0) continue;
      mine.forEach(animation => animation.cancel());
      running.delete(element);
      if (element === capsule) capsule.style.pointerEvents = '';
    }
  };
}

function stopRunning(element: HTMLElement): void {
  running.get(element)?.forEach(animation => animation.cancel());
  running.delete(element);
}

// On the way back the capsule returns once the page has passed 0.6, when it starts to read as the browser again.
function capsuleFadeInDelay({ progress, velocity }: CompanionMotion): number {
  const seconds = springTimeToReach(springs.morphExpand, progress, 1, velocity, MORPH_TIMING.capsuleFadeInProgress);
  return seconds === null ? 0 : seconds * 1000;
}

function capsuleFrame({ opacity, lift }: { opacity: number; lift: number }): Keyframe {
  return { opacity, transform: `translateY(${lift}px)` };
}

function launcherFrame(shown: number): Keyframe {
  const scale = MORPH_TIMING.launcherScaleFrom + (1 - MORPH_TIMING.launcherScaleFrom) * shown;
  return { opacity: shown, transform: `scale(${Math.round(scale * 10000) / 10000})` };
}

/** The capsule's opacity and lift as drawn now, a fade a previous event started included. */
function readCapsule(capsule: HTMLElement): { opacity: number; lift: number } {
  const style = window.getComputedStyle(capsule);
  const opacity = parseFloat(style.opacity);
  return { opacity: Number.isFinite(opacity) ? opacity : 1, lift: verticalOffset(style.transform) };
}

function verticalOffset(transform: string): number {
  if (!transform || transform === 'none') return 0;
  return new DOMMatrixReadOnly(transform).m42;
}
