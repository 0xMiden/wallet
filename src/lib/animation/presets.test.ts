import { renderHook } from '@testing-library/react';

import { durations } from './durations';
import { easings } from './easings';
import { pageSlideEntrance } from './page-appearance';
import { presetNames, presets, resolvePreset, usePreset } from './presets';
import { springs } from './springs';
import { reducedMotionTransition } from './use-motion';

let mockReduce: boolean | null = false;
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReduce
}));

const INSTANT = reducedMotionTransition;

describe('lib/animation/presets', () => {
  beforeEach(() => {
    mockReduce = false;
  });

  it('exports the ten presets the design system names', () => {
    expect([...presetNames].sort()).toEqual(
      ['count', 'fade', 'indicator', 'page', 'pop', 'press', 'reveal', 'shake', 'sheet', 'shimmer'].sort()
    );
    expect(Object.keys(presets).sort()).toEqual([...presetNames].sort());
  });

  it('adds the standard and sheet easings', () => {
    expect(easings.standard).toEqual([0.4, 0, 0.2, 1]);
    expect(easings.sheet).toEqual([0.32, 0.72, 0, 1]);
  });

  describe('values', () => {
    it('fade: opacity over durations.fast on easeOutCubic', () => {
      expect(presets.fade.initial).toEqual({ opacity: 0 });
      expect(presets.fade.animate).toEqual({ opacity: 1 });
      expect(presets.fade.exit).toEqual({ opacity: 0 });
      expect(presets.fade.transition).toEqual({
        type: 'tween',
        duration: durations.fast,
        ease: easings.easeOutCubic
      });
    });

    it('reveal: height 0 <-> auto with opacity on springs.standard', () => {
      expect(presets.reveal.initial).toEqual({ height: 0, opacity: 0 });
      expect(presets.reveal.animate).toEqual({ height: 'auto', opacity: 1 });
      expect(presets.reveal.exit).toEqual({ height: 0, opacity: 0 });
      expect(presets.reveal.transition).toBe(springs.standard);
    });

    it('pop: in from opacity 0 / scale 0.92, out to scale 0.96, on springs.snappy', () => {
      expect(presets.pop.initial).toEqual({ opacity: 0, scale: 0.92 });
      expect(presets.pop.animate).toEqual({ opacity: 1, scale: 1 });
      expect(presets.pop.exit).toEqual({ opacity: 0, scale: 0.96 });
      expect(presets.pop.transition).toBe(springs.snappy);
    });

    it('sheet: y 24 + scale 0.96 + opacity on springs.sheetPresent', () => {
      expect(presets.sheet.initial).toEqual({ opacity: 0, y: 24, scale: 0.96 });
      expect(presets.sheet.animate).toEqual({ opacity: 1, y: 0, scale: 1 });
      expect(presets.sheet.exit).toEqual({ opacity: 0, y: 24, scale: 0.96 });
      expect(presets.sheet.transition).toBe(springs.sheetPresent);
    });

    it('page: the incoming page slides in from the right on the stacked-page tween', () => {
      expect(presets.page.initial).toEqual({ x: '100%' });
      expect(presets.page.animate).toEqual({ x: 0 });
      expect(presets.page.exit).toEqual({ x: '100%' });
      expect(presets.page.transition).toBe(pageSlideEntrance);
      expect(pageSlideEntrance).toEqual({ type: 'tween', duration: 0.34, ease: easings.standard });
    });

    it('press: whileTap scale 0.96 on springs.snappy', () => {
      expect(presets.press.whileTap).toEqual({ scale: 0.96 });
      expect(presets.press.transition).toBe(springs.snappy);
      expect(presets.press.initial).toBeUndefined();
      expect(presets.press.animate).toBeUndefined();
    });

    it('indicator: springs.pill for a shared layoutId, no enter/exit of its own', () => {
      expect(presets.indicator.transition).toBe(springs.pill);
      expect(presets.indicator.initial).toBeUndefined();
      expect(presets.indicator.animate).toBeUndefined();
    });

    it('count: a 0.6s tween on the standard curve, with no targets of its own', () => {
      expect(presets.count.transition).toEqual({
        type: 'tween',
        duration: durations.count,
        ease: easings.standard
      });
      expect(durations.count).toBe(0.6);
      expect(presets.count.initial).toBeUndefined();
      expect(presets.count.animate).toBeUndefined();
    });

    it('shimmer: a 1.2s linear loop across the element', () => {
      expect(presets.shimmer.initial).toEqual({ x: '-100%' });
      expect(presets.shimmer.animate).toEqual({ x: '100%' });
      expect(presets.shimmer.transition).toEqual({
        type: 'tween',
        duration: durations.shimmer,
        ease: 'linear',
        repeat: Infinity
      });
      expect(durations.shimmer).toBe(1.2);
    });

    it('shake: x keyframes that start and end at rest, over durations.slow', () => {
      const x = presets.shake.animate?.x;
      expect(Array.isArray(x) && x[0] === 0 && x[x.length - 1] === 0).toBe(true);
      expect(presets.shake.transition).toEqual({
        type: 'tween',
        duration: durations.slow,
        ease: easings.easeInOut
      });
    });
  });

  describe('resolvePreset', () => {
    it.each(presetNames)('returns %s unchanged when motion is allowed', name => {
      expect(resolvePreset(false, name)).toBe(presets[name]);
      expect(resolvePreset(null, name)).toBe(presets[name]);
    });

    it.each(presetNames.filter(name => name !== 'shimmer' && name !== 'shake'))(
      'makes %s instant under reduced motion and keeps its targets',
      name => {
        const reduced = resolvePreset(true, name);
        const { transition, ...targets } = reduced;
        const { transition: _raw, ...rawTargets } = presets[name];
        expect(transition).toEqual(INSTANT);
        expect(targets).toEqual(rawTargets);
      }
    );

    it('holds shimmer still under reduced motion', () => {
      const reduced = resolvePreset(true, 'shimmer');
      expect(reduced.initial).toBeUndefined();
      expect(reduced.animate).toBeUndefined();
      expect(reduced.transition).toEqual(INSTANT);
    });

    it('does not shake at all under reduced motion', () => {
      const reduced = resolvePreset(true, 'shake');
      expect(reduced.animate).toBeUndefined();
      expect(reduced.transition).toEqual(INSTANT);
    });
  });

  describe('usePreset', () => {
    it('returns the raw preset when motion is allowed', () => {
      const { result } = renderHook(() => usePreset('pop'));
      expect(result.current).toBe(presets.pop);
    });

    it('returns the reduced preset when the user asks for reduced motion', () => {
      mockReduce = true;
      const { result } = renderHook(() => usePreset('press'));
      expect(result.current.transition).toEqual(INSTANT);
      expect(result.current.whileTap).toEqual({ scale: 0.96 });
    });

    it('keeps the same object across renders while the preference holds', () => {
      mockReduce = true;
      const { result, rerender } = renderHook(() => usePreset('sheet'));
      const first = result.current;
      rerender();
      expect(result.current).toBe(first);
    });
  });
});
