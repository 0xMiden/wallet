import { act, renderHook } from '@testing-library/react';

import * as animation from 'lib/animation';

import * as compositor from './compositor';
import { springKeyframeStops } from './spring-easing';
import { springs } from './springs';

const { cancelSpring, currentScale, playSpring, springKeyframes, useCompositorPress } = compositor;

interface Played {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: jest.Mock;
}

const played: Played[] = [];

// jsdom has no DOMMatrixReadOnly; this reads the 2D part of a matrix() or a scale() the way an engine does.
class TestMatrix {
  a = 1;
  b = 0;
  e = 0;
  f = 0;
  constructor(transform: string) {
    const matrix = /matrix\(([^)]+)\)/.exec(transform);
    if (matrix?.[1]) {
      const [a = 1, b = 0, , , e = 0, f = 0] = matrix[1].split(',').map(Number);
      Object.assign(this, { a, b, e, f });
    }
    const scale = /scale\(([^)]+)\)/.exec(transform);
    if (scale?.[1]) this.a = Number(scale[1]);
  }
}

beforeEach(() => {
  played.length = 0;
  Object.defineProperty(globalThis, 'DOMMatrixReadOnly', { configurable: true, value: TestMatrix });
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = { cancel: jest.fn(), finished: Promise.resolve() };
      played.push({ element: this, keyframes, options, cancel: animation.cancel });
      return animation;
    }
  });
});

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(Element.prototype, 'animate');
  Reflect.deleteProperty(globalThis, 'DOMMatrixReadOnly');
});

const translateX = (value: number): Keyframe => ({ transform: `translateX(${value}px)` });
const scale = (value: number): Keyframe => ({ transform: `scale(${value})` });

describe('springKeyframes', () => {
  it('runs from the start value at offset 0 to the end value at offset 1', () => {
    const sampled = springKeyframes(springs.tabSwitch, 80, 0, translateX)!;

    expect(sampled.keyframes[0]).toEqual({ transform: 'translateX(80px)', offset: 0 });
    expect(sampled.keyframes.at(-1)).toEqual({ transform: 'translateX(0px)', offset: 1 });
  });

  it('places each keyframe at its stop, on the spring the solver samples, overshoot included', () => {
    const sampled = springKeyframes(springs.tabSwitch, 80, 0, translateX)!;
    const stops = springKeyframeStops(springs.tabSwitch, { distance: 80 })!;

    expect(sampled.duration).toBe(stops.duration);
    expect(sampled.keyframes.map(k => k.offset)).toEqual(stops.stops.map(s => s.offset));
    // One visible overshoot past the target: some stop lands left of 0.
    expect(sampled.keyframes.some(k => String(k.transform).startsWith('translateX(-'))).toBe(true);
  });

  it('animates a scale, which moves less than the 0.5 a pixel move needs to be worth animating', () => {
    const sampled = springKeyframes(springs.snappy, 1, 0.92, scale)!;

    expect(sampled).not.toBeNull();
    expect(sampled.keyframes[0]).toEqual({ transform: 'scale(1)', offset: 0 });
    expect(sampled.keyframes.at(-1)).toEqual({ transform: 'scale(0.92)', offset: 1 });
  });

  it('is null when there is nothing to animate', () => {
    expect(springKeyframes(springs.tabSwitch, 12, 12, translateX)).toBeNull();
    expect(springKeyframes({ duration: 0.001 }, 80, 0, translateX)).toBeNull();
  });

  it('keeps the same keyframes when a fifth argument is passed', () => {
    const withVelocity: (
      transition: Parameters<typeof springKeyframes>[0],
      from: Parameters<typeof springKeyframes>[1],
      to: Parameters<typeof springKeyframes>[2],
      frame: Parameters<typeof springKeyframes>[3],
      velocity: number
    ) => ReturnType<typeof springKeyframes> = springKeyframes;

    expect(withVelocity(springs.tabSwitch, 80, 0, translateX, 1200)).toEqual(
      springKeyframes(springs.tabSwitch, 80, 0, translateX)
    );
  });
});

describe('playSpring', () => {
  it('plays the keyframes linearly between stops, filling nothing', () => {
    const el = document.createElement('div');

    const animation = playSpring(el, springs.tabSwitch, 80, 0, translateX);

    expect(animation).not.toBeNull();
    expect(played).toHaveLength(1);
    expect(played[0]!.element).toBe(el);
    expect(played[0]!.options).toEqual({
      duration: springKeyframeStops(springs.tabSwitch, { distance: 80 })!.duration,
      easing: 'linear',
      fill: 'none'
    });
  });

  it('cancels the animation it last started on the element', () => {
    const el = document.createElement('div');

    playSpring(el, springs.tabSwitch, 80, 0, translateX);
    playSpring(el, springs.tabSwitch, 40, 0, translateX);

    expect(played).toHaveLength(2);
    expect(played[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(played[1]!.cancel).not.toHaveBeenCalled();
  });

  it('leaves the element at the end value, so it rests there once the animation ends', () => {
    const el = document.createElement('div');

    playSpring(el, springs.snappy, 1, 0.92, scale);

    expect(el.style.transform).toBe('scale(0.92)');
  });

  it('with nothing to animate: cancels the last animation, sets the end value and plays nothing', () => {
    const el = document.createElement('div');
    playSpring(el, springs.tabSwitch, 80, 0, translateX);

    expect(playSpring(el, springs.tabSwitch, 0, 0, translateX)).toBeNull();

    expect(played).toHaveLength(1);
    expect(played[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(el.style.transform).toBe('translateX(0px)');
  });

  it('cancelSpring stops what playSpring last started on the element', () => {
    const el = document.createElement('div');
    playSpring(el, springs.tabSwitch, 80, 0, translateX);

    cancelSpring(el);

    expect(played[0]!.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('currentScale', () => {
  it('reads the scale of the computed transform', () => {
    const el = document.createElement('div');
    el.style.transform = 'matrix(0.92, 0, 0, 0.92, 0, 0)';

    expect(currentScale(el)).toBeCloseTo(0.92);
  });

  it('reads no transform as the identity', () => {
    const el = document.createElement('div');
    el.style.transform = 'none';

    expect(currentScale(el)).toBe(1);
  });
});

describe('published surface', () => {
  it('does not publish currentTranslate or sampleSpring', () => {
    expect(compositor).not.toHaveProperty('currentTranslate');
    expect(animation).not.toHaveProperty('sampleSpring');

    type Animation = typeof import('lib/animation');
    type Leftover = Extract<
      | 'sampleSpring'
      | 'currentTranslate'
      | 'SpringSamples'
      | 'SpringKeyframeStop'
      | 'SpringKeyframeStops'
      | 'CompositorSpring',
      keyof Animation
    >;
    const unpublished: [Leftover] extends [never] ? true : Leftover = true;
    expect(unpublished).toBe(true);

    const present = <T>(_value?: T): true => true;
    // @ts-expect-error SpringSamples is not a barrel export
    type SpringSamplesProbe = import('lib/animation').SpringSamples;
    // @ts-expect-error SpringKeyframeStop is not a barrel export
    type SpringKeyframeStopProbe = import('lib/animation').SpringKeyframeStop;
    // @ts-expect-error SpringKeyframeStops is not a barrel export
    type SpringKeyframeStopsProbe = import('lib/animation').SpringKeyframeStops;
    // @ts-expect-error CompositorSpring is not a barrel export
    type CompositorSpringProbe = import('lib/animation').CompositorSpring;
    expect(
      present<SpringSamplesProbe>() &&
        present<SpringKeyframeStopProbe>() &&
        present<SpringKeyframeStopsProbe>() &&
        present<CompositorSpringProbe>()
    ).toBe(true);
  });
});

describe('useCompositorPress', () => {
  const setup = (enabled = true) => {
    // Connected, as a pressed control is: jsdom keeps a detached element's computed style stale.
    const el = document.body.appendChild(document.createElement('button'));
    const ref = { current: el };
    const { result, unmount } = renderHook(() =>
      useCompositorPress(ref, { scale: 0.92, transition: springs.snappy, enabled })
    );
    return { el, handlers: result.current, unmount };
  };

  it('dips on pointer down and comes back on pointer up, from wherever the dip got to', () => {
    const { el, handlers } = setup();

    act(() => handlers.onPointerDown());
    expect(played).toHaveLength(1);
    expect(played[0]!.keyframes[0]).toMatchObject({ transform: 'scale(1)' });
    expect(played[0]!.keyframes.at(-1)).toMatchObject({ transform: 'scale(0.92)' });

    act(() => handlers.onPointerUp());
    expect(played).toHaveLength(2);
    expect(played[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(played[1]!.element).toBe(el);
    expect(played[1]!.keyframes[0]).toMatchObject({ transform: 'scale(0.92)' });
    expect(played[1]!.keyframes.at(-1)).toMatchObject({ transform: 'scale(1)' });
  });

  it('comes back on pointer cancel and on pointer leave too, once per press', () => {
    const { handlers } = setup();

    act(() => handlers.onPointerDown());
    act(() => handlers.onPointerCancel());
    expect(played).toHaveLength(2);

    act(() => handlers.onPointerDown());
    act(() => handlers.onPointerLeave());
    // A touch fires pointerleave after pointerup: the release already ran and does not restart.
    act(() => handlers.onPointerUp());
    expect(played).toHaveLength(4);
  });

  // framer's press gesture: only the primary touch or pen, or a mouse's main button, presses.
  it('ignores a right click and a second touch', () => {
    const { handlers } = setup();

    act(() => handlers.onPointerDown({ pointerType: 'mouse', button: 2, isPrimary: true }));
    act(() => handlers.onPointerDown({ pointerType: 'touch', button: 0, isPrimary: false }));
    expect(played).toHaveLength(0);

    act(() => handlers.onPointerDown({ pointerType: 'mouse', button: 0, isPrimary: true }));
    expect(played).toHaveLength(1);
  });

  it('does nothing when disabled', () => {
    const { handlers } = setup(false);

    act(() => {
      handlers.onPointerDown();
      handlers.onPointerUp();
    });

    expect(played).toHaveLength(0);
  });

  it('cancels a running dip on unmount', () => {
    const { handlers, unmount } = setup();
    act(() => handlers.onPointerDown());

    unmount();

    expect(played[0]!.cancel).toHaveBeenCalledTimes(1);
  });
});
