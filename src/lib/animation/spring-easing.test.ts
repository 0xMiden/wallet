import { sampleSpring, springKeyframeStops, springToLinearEasing } from './spring-easing';
import { springs } from './springs';

describe('sampleSpring', () => {
  it('starts at 0, lands on 1 and keeps the overshoot', () => {
    const sample = sampleSpring(springs.tabSwitch, { distance: 90 });
    if (!sample) throw new Error('expected a sample');
    expect(sample.progress[0]).toBe(0);
    expect(sample.progress[sample.progress.length - 1]).toBe(1);
    expect(Math.max(...sample.progress)).toBeGreaterThan(1.05);
    expect(sample.duration).toBe(springToLinearEasing(springs.tabSwitch, { distance: 90 })?.duration);
  });

  it('returns null for a non-spring transition and a negligible distance', () => {
    expect(sampleSpring({ type: 'tween', duration: 0.2 }, { distance: 90 })).toBeNull();
    expect(sampleSpring(springs.tabSwitch, { distance: 0.1 })).toBeNull();
  });
});

describe('springToLinearEasing', () => {
  it('still emits a linear() curve from 0 to 1', () => {
    const easing = springToLinearEasing(springs.sheetOpen, { distance: 420 })?.easing;
    expect(easing?.startsWith('linear(0,')).toBe(true);
    expect(easing?.endsWith(',1)')).toBe(true);
  });
});

describe('springKeyframeStops', () => {
  it('spans offsets 0..1 from progress 0 to 1 with strictly increasing offsets', () => {
    const result = springKeyframeStops(springs.sheetOpen, { distance: 420 });
    if (!result) throw new Error('expected stops');
    const { duration, stops } = result;
    expect(stops[0]).toEqual({ offset: 0, progress: 0 });
    expect(stops[stops.length - 1]).toEqual({ offset: 1, progress: 1 });
    const offsets = stops.map(stop => stop.offset);
    expect(offsets).toEqual([...new Set(offsets)].sort((a, b) => a - b));
    expect(Math.abs(stops.length - (Math.ceil(duration / 8) + 1))).toBeLessThanOrEqual(1);
  });

  it('returns null for a non-spring transition and a negligible distance', () => {
    expect(springKeyframeStops({ type: 'tween', duration: 0.2 }, { distance: 90 })).toBeNull();
    expect(springKeyframeStops(springs.sheetOpen, { distance: 0.1 })).toBeNull();
  });

  it('keeps the 8 ms stride when a third argument is passed', () => {
    const fine = springKeyframeStops(springs.sheetOpen, { distance: 420 });
    const sampled: (
      transition: Parameters<typeof springKeyframeStops>[0],
      options: Parameters<typeof springKeyframeStops>[1],
      stepMs: number
    ) => ReturnType<typeof springKeyframeStops> = springKeyframeStops;
    const coarse = sampled(springs.sheetOpen, { distance: 420 }, 1000);
    if (!fine || !coarse) throw new Error('expected stops');
    expect(coarse.stops.length).toBe(fine.stops.length);
  });
});
