import { MORPH_TIMING, springTimeToReach, springToLinearEasing, springs } from 'lib/animation';
import { boostRefreshRate } from 'lib/mobile/high-refresh-rate';

import { startMorphCompanions } from './morph-companions';

type Frame = Record<string, string | number>;
interface Options {
  duration: number;
  delay?: number;
  easing?: string;
  fill?: string;
}
interface Played {
  element: Element;
  keyframes: Frame[];
  options: Options;
  cancel: jest.Mock;
}

const mockLinear = { value: true };
jest.mock('lib/animation', () => ({
  ...jest.requireActual('lib/animation'),
  supportsLinearEasing: () => mockLinear.value
}));
jest.mock('lib/mobile/high-refresh-rate', () => ({ boostRefreshRate: jest.fn() }));

const played: Played[] = [];
let capsule: HTMLElement;
let launcher: HTMLElement;
const of = (element: Element) => played.filter(entry => entry.element === element);

afterEach(() => {
  capsule.remove();
  launcher.remove();
});

beforeEach(() => {
  jest.clearAllMocks();
  played.length = 0;
  mockLinear.value = true;
  capsule = document.body.appendChild(document.createElement('header'));
  launcher = document.body.appendChild(document.createElement('div'));
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: function (this: Element, keyframes: Frame[], options: Options) {
      const entry = { element: this, keyframes, options, cancel: jest.fn() };
      played.push(entry);
      return entry;
    }
  });
});

it('collapse fades and lifts the capsule over 160 ms and stops its pointer events', () => {
  const stop = startMorphCompanions({ capsule, launcher }, { target: 'collapsed', progress: 1, velocity: 0 }, false);

  const [fade] = of(capsule);
  expect(fade?.keyframes).toEqual([
    { opacity: 1, transform: 'translateY(0px)' },
    { opacity: 0, transform: `translateY(-${MORPH_TIMING.capsuleLiftPx}px)` }
  ]);
  expect(fade?.options).toMatchObject({ duration: MORPH_TIMING.capsuleFadeMs, easing: 'ease-out', fill: 'forwards' });
  expect(capsule.style.pointerEvents).toBe('none');

  stop();
  expect(fade?.cancel).toHaveBeenCalled();
  expect(capsule.style.pointerEvents).toBe('');
});

it('expand fades the capsule in from progress 0.6', () => {
  capsule.style.opacity = '0';
  capsule.style.transform = 'translateY(-8px)';

  startMorphCompanions({ capsule, launcher }, { target: 'expanded', progress: 0, velocity: 0 }, false);

  const [fade] = of(capsule);
  expect(fade?.keyframes).toEqual([
    { opacity: 0, transform: 'translateY(-8px)' },
    { opacity: 1, transform: 'translateY(0px)' }
  ]);
  const reach = springTimeToReach(springs.morphExpand, 0, 1, 0, MORPH_TIMING.capsuleFadeInProgress)!;
  expect(fade?.options.delay).toBeCloseTo(reach * 1000, 3);
  expect(fade?.options.delay).toBeCloseTo(125, -1);
  expect(capsule.style.pointerEvents).toBe('');
});

it('launcher follows the spring from scale 0.97', () => {
  startMorphCompanions({ capsule, launcher }, { target: 'collapsed', progress: 1, velocity: 0 }, false);

  const [follow] = of(launcher);
  expect(follow?.keyframes).toEqual([
    { opacity: 0, transform: `scale(${MORPH_TIMING.launcherScaleFrom})` },
    { opacity: 1, transform: 'scale(1)' }
  ]);
  const spring = springToLinearEasing(springs.morphCollapse, { distance: -1000, velocity: 0 })!;
  expect(follow?.options).toMatchObject({ duration: spring.duration, easing: spring.easing, fill: 'forwards' });
});

it('reduced motion animates opacity only', () => {
  startMorphCompanions({ capsule, launcher }, { target: 'collapsed', progress: 1, velocity: 0 }, true);

  expect(played).toHaveLength(2);
  for (const entry of played) {
    expect(entry.keyframes.flatMap(Object.keys)).toEqual(['opacity', 'opacity']);
    expect(entry.options).toMatchObject({ duration: MORPH_TIMING.reducedFadeMs, easing: 'ease-out' });
  }
});

it('a retarget restarts from the current value with the event velocity', () => {
  const first = startMorphCompanions({ capsule, launcher }, { target: 'collapsed', progress: 1, velocity: 0 }, false);
  const previous = [...played];
  capsule.style.opacity = '0.25';
  capsule.style.transform = 'matrix(1, 0, 0, 1, 0, -6)';

  startMorphCompanions({ capsule, launcher }, { target: 'expanded', progress: 0.4, velocity: 3 }, false);

  expect(previous.every(entry => entry.cancel.mock.calls.length === 1)).toBe(true);
  const [follow] = of(launcher).slice(1);
  expect(follow?.keyframes[0]).toEqual({ opacity: 0.6, transform: 'scale(0.988)' });
  expect(follow?.options.easing).toBe(
    springToLinearEasing(springs.morphExpand, { distance: 600, velocity: -3000 })!.easing
  );
  expect(of(capsule)[1]?.keyframes[0]).toEqual({ opacity: 0.25, transform: 'translateY(-6px)' });
  first();
  expect(of(launcher)[1]?.cancel).not.toHaveBeenCalled();
});

it('snaps when linear() is unsupported', () => {
  mockLinear.value = false;

  startMorphCompanions({ capsule, launcher }, { target: 'collapsed', progress: 1, velocity: 0 }, false);

  expect(of(launcher)[0]?.options).toMatchObject({ duration: 0, fill: 'forwards' });
  expect(of(launcher)[0]?.keyframes.at(-1)).toEqual({ opacity: 1, transform: 'scale(1)' });
  expect(of(capsule)[0]?.options).toMatchObject({ duration: 0, fill: 'forwards' });
});

it('sends nothing over the bridge while the page moves', () => {
  startMorphCompanions({ capsule, launcher }, { target: 'collapsed', progress: 1, velocity: 0 }, false);
  startMorphCompanions({ capsule, launcher }, { target: 'expanded', progress: 0.4, velocity: 3 }, false);
  startMorphCompanions({ capsule, launcher }, { target: 'collapsed', progress: 0.6, velocity: -2 }, true);

  expect(played.length).toBeGreaterThan(0);
  expect(boostRefreshRate).not.toHaveBeenCalled();
});
