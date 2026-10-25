/**
 * Springs played as Web Animations on the compositor.
 *
 * WKWebView runs everything framer-motion drives from `requestAnimationFrame` at 60 fps, and a
 * `linear()` easing too (see `spring-easing.ts`). A `transform` animation whose keyframes are the
 * sampled spring, `linear` between stops, runs at the display's rate. So a short, frequent motion
 * that must keep up with a 120 Hz panel (a tab switch, a press) is played here instead: the spring is
 * solved up front, the element is set to its end state, and the keyframes carry it there.
 *
 * One animation per element: playing a spring on an element cancels the one played on it before,
 * so a new motion takes over from the last. Callers read where the element is drawn
 * (`currentScale`, `currentTranslate`, a rect) before they play, to start from there.
 */

import { RefObject, useEffect, useMemo, useRef } from 'react';

import type { Transition } from 'framer-motion';

import { springKeyframeStops } from './spring-easing';

export interface SpringKeyframes {
  keyframes: Keyframe[];
  /** Milliseconds. */
  duration: number;
}

// framer settles a value that moves less than 5 (a scale, an opacity) to within 0.005 rather than
// 0.5. The solver's thresholds are in pixels, so such a value is solved in hundredths.
const GRANULAR_DELTA = 5;
const GRANULAR_UNIT = 100;

/**
 * `transition` from `from` to `to` as keyframes, one per sampled stop: `frame` turns each value
 * (`from + (to - from) * progress`, overshoot included) into a keyframe. Null when the spring is too
 * short to animate (no distance, or not a spring at all).
 */
export function springKeyframes(
  transition: Transition,
  from: number,
  to: number,
  frame: (value: number) => Keyframe,
  velocity = 0
): SpringKeyframes | null {
  const unit = Math.abs(to - from) < GRANULAR_DELTA ? GRANULAR_UNIT : 1;
  const sampled = springKeyframeStops(transition, { distance: (from - to) * unit, velocity: velocity * unit });
  if (!sampled) return null;
  return {
    duration: sampled.duration,
    keyframes: sampled.stops.map(({ offset, progress }) => ({
      ...frame(progress === 1 ? to : from + (to - from) * progress),
      offset
    }))
  };
}

const running = new WeakMap<Element, Animation>();

/** Cancels the animation `playKeyframes` or `playSpring` last started on `el`. */
export function cancelSpring(el: Element): void {
  running.get(el)?.cancel();
  running.delete(el);
}

const NOT_STYLE = new Set(['offset', 'easing', 'composite']);

function applyKeyframe(el: HTMLElement, keyframe: Keyframe): void {
  for (const [key, value] of Object.entries(keyframe)) {
    if (NOT_STYLE.has(key)) continue;
    const property = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    if (value === null || value === undefined) el.style.removeProperty(property);
    else el.style.setProperty(property, String(value));
  }
}

/**
 * Plays `keyframes` on `el` after cancelling the animation last started on it. `rest` is written to
 * the element's style first, so it stays there once the animation (which fills nothing) ends; with
 * no keyframes the element only moves to `rest`.
 */
export function playKeyframes(
  el: HTMLElement,
  keyframes: Keyframe[] | null,
  duration: number,
  rest: Keyframe
): Animation | null {
  cancelSpring(el);
  applyKeyframe(el, rest);
  if (!keyframes || typeof el.animate !== 'function') return null;
  const animation = el.animate(keyframes, { duration, easing: 'linear', fill: 'none' });
  // Start on this frame's timeline. Left unset, WebKit waits for the next frame, and the element
  // paints at its end state for that frame.
  const now = document.timeline?.currentTime;
  if (typeof now === 'number') animation.startTime = now;
  running.set(el, animation);
  return animation;
}

/** `transition` from `from` to `to` on `el` (see `springKeyframes` and `playKeyframes`). */
export function playSpring(
  el: HTMLElement,
  transition: Transition,
  from: number,
  to: number,
  frame: (value: number) => Keyframe
): Animation | null {
  const sampled = springKeyframes(transition, from, to, frame);
  return playKeyframes(el, sampled?.keyframes ?? null, sampled?.duration ?? 0, frame(to));
}

function computedMatrix(el: Element): DOMMatrixReadOnly | null {
  const transform = getComputedStyle(el).transform;
  return transform && transform !== 'none' ? new DOMMatrixReadOnly(transform) : null;
}

/** The scale `el` is drawn at, a running animation included. */
export function currentScale(el: HTMLElement): number {
  const matrix = computedMatrix(el);
  return matrix ? Math.hypot(matrix.a, matrix.b) : 1;
}

/** The translation `el` is drawn at, a running animation included. */
export function currentTranslate(el: HTMLElement): { x: number; y: number } {
  const matrix = computedMatrix(el);
  return matrix ? { x: matrix.e, y: matrix.f } : { x: 0, y: 0 };
}

export const scaleKeyframe = (value: number): Keyframe => ({ transform: `scale(${value})` });

export interface CompositorPressHandlers {
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
}

/**
 * A press dip on the compositor: down scales `ref` to `scale`, up, cancel or leave bring it back to
 * 1, each from the scale it is drawn at. Nothing happens while `enabled` is false.
 */
export function useCompositorPress(
  ref: RefObject<HTMLElement>,
  { scale, transition, enabled }: { scale: number; transition: Transition; enabled: boolean }
): CompositorPressHandlers {
  // A touch fires pointerleave after pointerup; a second release would restart the spring at rest speed.
  const pressed = useRef(false);

  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el) cancelSpring(el);
    };
  }, [ref]);

  return useMemo(() => {
    const scaleTo = (target: number) => {
      const el = ref.current;
      if (el) playSpring(el, transition, currentScale(el), target, scaleKeyframe);
    };
    const release = () => {
      if (!pressed.current) return;
      pressed.current = false;
      scaleTo(1);
    };
    return {
      onPointerDown: () => {
        if (!enabled) return;
        pressed.current = true;
        scaleTo(scale);
      },
      onPointerUp: release,
      onPointerCancel: release,
      onPointerLeave: release
    };
  }, [ref, scale, transition, enabled]);
}
