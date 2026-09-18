import { durations } from './durations';
import { easings } from './easings';
import {
  pageSlideEntrance,
  pageStepFadeOffset,
  pageStepOffset,
  pageStepTransition,
  resolvePageStepTransition
} from './page-appearance';

const INSTANT = { duration: 0.001 };

describe('lib/animation/page-appearance', () => {
  it('slides a stacked page over durations.page on the standard curve', () => {
    expect(durations.page).toBe(0.34);
    expect(pageSlideEntrance).toEqual({ type: 'tween', duration: durations.page, ease: easings.standard });
  });

  it('swaps a step over durations.pageStep on the same curve as the page slide', () => {
    expect(durations.pageStep).toBe(0.15);
    expect(pageStepTransition).toEqual({ type: 'tween', duration: durations.pageStep, ease: easings.standard });
  });

  it('names how far a step travels: an 8% nudge for Navigator, a 1vw drift for onboarding', () => {
    expect(pageStepOffset).toBe('8%');
    expect(pageStepFadeOffset).toBe('1vw');
  });

  describe('resolvePageStepTransition', () => {
    it('runs the step transition where steps animate', () => {
      expect(resolvePageStepTransition(false, true)).toEqual(pageStepTransition);
      expect(resolvePageStepTransition(null, true)).toEqual(pageStepTransition);
    });

    it('takes a caller duration on the same curve', () => {
      expect(resolvePageStepTransition(false, true, 0.5)).toEqual({ ...pageStepTransition, duration: 0.5 });
    });

    it('swaps at once where steps do not animate (the extension)', () => {
      expect(resolvePageStepTransition(false, false)).toEqual({ ...pageStepTransition, duration: 0 });
      expect(resolvePageStepTransition(false, false, 0.5)).toEqual({ ...pageStepTransition, duration: 0 });
    });

    it('is instant under reduced motion, whatever the platform or duration', () => {
      expect(resolvePageStepTransition(true, true)).toEqual(INSTANT);
      expect(resolvePageStepTransition(true, true, 0.5)).toEqual(INSTANT);
      expect(resolvePageStepTransition(true, false)).toEqual(INSTANT);
    });
  });
});
