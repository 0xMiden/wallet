import { act, renderHook } from '@testing-library/react';

import { easings } from './easings';
import { springToLinearEasing } from './spring-easing';
import { springs } from './springs';
import { resolveTabBarMotion, tabBarMotion, useTabBarMotion, useTabIconPop } from './tab-bar';

let mockReduce: boolean | null = false;
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReduce
}));

const INSTANT = { duration: 0.001 };

/** The progress samples of a spring solved over `distance` px. */
function samples(distance: number) {
  const solved = springToLinearEasing(springs.tabSwitch, { distance });
  if (!solved) throw new Error('expected tabSwitch to solve as a spring');
  const values = solved.easing.slice('linear('.length, -1).split(',').map(Number);
  return { duration: solved.duration, values };
}

/** The local maxima above the target, as a fraction past it. */
function overshoots(values: number[]) {
  const peaks: number[] = [];
  for (let i = 1; i < values.length - 1; i += 1) {
    const value = values[i]!;
    if (value > 1 && value >= values[i - 1]! && value > values[i + 1]!) peaks.push(value - 1);
  }
  return peaks;
}

describe('lib/animation/tab-bar', () => {
  beforeEach(() => {
    mockReduce = false;
  });

  describe('springs.tabSwitch', () => {
    it('starts from the brief’s spring and stiffens it to settle faster', () => {
      expect(springs.tabSwitch).toEqual({ type: 'spring', stiffness: 680, damping: 30, mass: 0.8 });
    });

    it.each([
      ['a one-tab hop', 90],
      ['a three-tab jump', 270]
    ])('settles within 350ms for %s (%ipx)', (_label, distance) => {
      expect(samples(distance).duration).toBeLessThanOrEqual(350);
    });

    it('overshoots once, visibly (5–10%), and not again beyond half a pixel', () => {
      const { values } = samples(90);
      const peaks = overshoots(values);
      expect(peaks[0]).toBeGreaterThan(0.05);
      expect(peaks[0]).toBeLessThan(0.1);
      // Any later swing past the target is under half a pixel on a 90px move.
      expect(peaks.slice(1).every(peak => peak * 90 < 0.5)).toBe(true);
    });
  });

  describe('springs.tabIconPop', () => {
    it('rises without a visible overshoot', () => {
      const solved = springToLinearEasing(springs.tabIconPop, { distance: 100 });
      const values = solved!.easing.slice('linear('.length, -1).split(',').map(Number);
      expect(Math.max(...values)).toBeLessThan(1.01);
      expect(solved!.duration).toBeLessThanOrEqual(200);
    });
  });

  describe('tabBarMotion', () => {
    it('names the highlight, pop and press values the tab bars use', () => {
      expect(tabBarMotion.highlight).toBe(springs.tabSwitch);
      expect(tabBarMotion.iconPopScale).toBe(1.12);
      expect(tabBarMotion.iconPopUp).toBe(springs.tabIconPop);
      expect(tabBarMotion.iconPopSettle).toBe(springs.tabSwitch);
      expect(tabBarMotion.pressScale).toBe(0.92);
      expect(tabBarMotion.press).toBe(springs.snappy);
      expect(tabBarMotion.label).toEqual({ type: 'tween', duration: 0.12, delay: 0.1, ease: easings.easeInOut });
    });
  });

  describe('resolveTabBarMotion / useTabBarMotion', () => {
    it('slides on tabSwitch and dips a pressed tab to 0.92 when motion is allowed', () => {
      const motion = resolveTabBarMotion(false);
      expect(motion.highlight).toBe(springs.tabSwitch);
      expect(motion.label).toBe(tabBarMotion.label);
      expect(motion.press).toEqual({ whileTap: { scale: 0.92, transition: springs.snappy } });
      expect(resolveTabBarMotion(null)).toBe(motion);
    });

    it('moves the highlight instantly and drops the press scale under reduced motion', () => {
      const motion = resolveTabBarMotion(true);
      expect(motion.highlight).toEqual(INSTANT);
      expect(motion.label).toEqual(INSTANT);
      expect(motion.press).toEqual({});
    });

    it('follows the user’s preference and keeps one object while it holds', () => {
      const { result, rerender } = renderHook(() => useTabBarMotion());
      expect(result.current).toBe(resolveTabBarMotion(false));

      mockReduce = true;
      rerender();
      const reduced = result.current;
      expect(reduced).toBe(resolveTabBarMotion(true));
      rerender();
      expect(result.current).toBe(reduced);
    });
  });

  describe('useTabIconPop', () => {
    const render = (active: boolean) =>
      renderHook(({ on }: { on: boolean }) => useTabIconPop(on), { initialProps: { on: active } });

    it('does not pop a tab that is already active on mount', () => {
      const { result } = render(true);
      expect(result.current.phase).toBe('rest');
      expect(result.current.animate).toEqual({ scale: 1 });
    });

    it('pops up to 1.12 on tabIconPop when the tab becomes active, then settles on tabSwitch', () => {
      const { result, rerender } = render(false);

      rerender({ on: true });
      expect(result.current.phase).toBe('pop');
      expect(result.current.animate).toEqual({ scale: 1.12 });
      expect(result.current.transition).toBe(springs.tabIconPop);

      act(() => result.current.onAnimationComplete());
      expect(result.current.phase).toBe('rest');
      expect(result.current.animate).toEqual({ scale: 1 });
      expect(result.current.transition).toBe(springs.tabSwitch);
    });

    it('stops popping when the tab loses focus mid-pop', () => {
      const { result, rerender } = render(false);
      rerender({ on: true });
      expect(result.current.phase).toBe('pop');

      rerender({ on: false });
      expect(result.current.phase).toBe('rest');
      expect(result.current.animate).toEqual({ scale: 1 });
    });

    it('pops again on each later activation', () => {
      const { result, rerender } = render(true);
      rerender({ on: false });
      rerender({ on: true });
      expect(result.current.phase).toBe('pop');
    });

    it('never pops under reduced motion, and its transition is instant', () => {
      mockReduce = true;
      const { result, rerender } = render(false);

      rerender({ on: true });
      expect(result.current.phase).toBe('rest');
      expect(result.current.animate).toEqual({ scale: 1 });
      expect(result.current.transition).toEqual(INSTANT);
    });
  });
});
