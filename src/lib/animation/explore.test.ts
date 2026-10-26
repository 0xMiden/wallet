import { renderHook } from '@testing-library/react';
import { type TargetAndTransition, type Variant } from 'framer-motion';

import { exploreMotion, resolveExploreMotion, useExploreMotion } from './explore';
import { springs } from './springs';
import { tabBarMotion } from './tab-bar';
import { reducedMotionTransition } from './use-motion';

let mockReduce: boolean | null = false;
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReduce
}));

function shown(variant: Variant | undefined, index: number): TargetAndTransition {
  if (typeof variant !== 'function') throw new Error('expected a resolver');
  const target = variant(index, {}, {});
  if (typeof target === 'string') throw new Error('expected a target');
  return target;
}

describe('lib/animation/explore', () => {
  beforeEach(() => {
    mockReduce = false;
  });

  it('presses like the tab bars and settles on the tab switch spring', () => {
    const motion = resolveExploreMotion(false);
    expect(exploreMotion.pressScale).toBe(tabBarMotion.pressScale);
    expect(motion.press.whileTap).toEqual({ scale: tabBarMotion.pressScale, transition: tabBarMotion.press });
    expect(motion.press.transition).toBe(springs.tabSwitch);
    expect(motion.layout).toBe(springs.tabSwitch);
  });

  it('reveals each section from below with a short stagger, capped so the page settles fast', () => {
    const { section } = resolveExploreMotion(false);
    expect(section.hidden).toEqual({ opacity: 0, y: exploreMotion.revealOffset });
    const first = shown(section.shown, 0);
    const third = shown(section.shown, 2);
    const late = shown(section.shown, 50);
    expect(first).toMatchObject({ opacity: 1, y: 0 });
    expect(first.transition).toMatchObject({ default: springs.tabSwitch, delay: 0 });
    expect(third.transition).toMatchObject({ delay: 2 * exploreMotion.revealStagger });
    const lastDelay = exploreMotion.revealMaxStagger * exploreMotion.revealStagger;
    expect(late.transition).toMatchObject({ delay: lastDelay });
    expect(exploreMotion.revealStagger).toBeGreaterThanOrEqual(0.03);
    expect(exploreMotion.revealStagger).toBeLessThanOrEqual(0.04);
    expect(lastDelay).toBeLessThan(0.3);
  });

  it('drops the press, the reveal and every duration under reduced motion', () => {
    mockReduce = true;
    const { result } = renderHook(() => useExploreMotion());
    expect(result.current.reveal).toBe(false);
    expect(result.current.press.whileTap).toBeUndefined();
    expect(result.current.press.transition).toEqual(reducedMotionTransition);
    expect(result.current.layout).toEqual(reducedMotionTransition);
    expect(result.current.section.hidden).toEqual({ opacity: 1, y: 0 });
    expect(result.current.section.shown).toMatchObject({ transition: reducedMotionTransition });
  });
});
