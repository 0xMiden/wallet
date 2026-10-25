import React, { useRef } from 'react';

import { act, render } from '@testing-library/react';

import { springKeyframes, springs } from 'lib/animation';

import { useSlideOnReflow } from './useSlideOnReflow';

type Engine = 'linear' | 'no-linear' | 'no-supports';

const originalCSS = window.CSS;
const setEngine = (engine: Engine) => {
  // A plain function, not jest.fn: afterEach's restoreAllMocks would strip a mock's implementation.
  const calls: string[][] = [];
  const supports = Object.assign(
    (...args: string[]) => {
      calls.push(args);
      return engine === 'linear';
    },
    { calls }
  );
  Object.defineProperty(window, 'CSS', {
    value: engine === 'no-supports' ? {} : { supports },
    configurable: true,
    writable: true
  });
  return supports;
};

/**
 * The linear() predicate is computed once per module, and importing lib/animation already asks it
 * (sheet.ts solves its curves at import), so each engine loads its own copy of the modules.
 */
const load = (engine: Engine) => {
  const supports = setEngine(engine);
  let predicate!: () => boolean;
  jest.isolateModules(() => {
    jest.doMock('react', () => React);
    predicate = require('lib/animation').supportsLinearEasing;
  });
  jest.dontMock('react');
  return { predicate, supports };
};

afterAll(() => {
  Object.defineProperty(window, 'CSS', { value: originalCSS, configurable: true, writable: true });
});

let reduceMotion = false;
let mockIsMobile = true;
jest.mock('lib/platform', () => ({ isMobile: () => mockIsMobile }));
jest.mock('framer-motion', () => ({ useReducedMotion: () => reduceMotion }));

let reflow: () => void = () => {};
const mockObserved: Array<{ target: Element; box?: string }> = [];
class MockResizeObserver {
  constructor(cb: () => void) {
    reflow = cb;
  }
  observe(target: Element, options?: ResizeObserverOptions) {
    mockObserved.push({ target, box: options?.box });
  }
  disconnect() {}
}

const animateMock = jest.fn();
let top = 700;
let computedOffset = 0;

beforeEach(() => {
  animateMock.mockReset();
  animateMock.mockImplementation(() => ({ cancel: jest.fn(), onfinish: null }));
  top = 700;
  reduceMotion = false;
  computedOffset = 0;
  mockIsMobile = true;
  Object.defineProperty(window, 'ResizeObserver', { value: MockResizeObserver, configurable: true, writable: true });
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: reduceMotion }),
    configurable: true,
    writable: true
  });
  Object.defineProperty(window, 'DOMMatrixReadOnly', {
    value: class {
      m42 = computedOffset;
    },
    configurable: true,
    writable: true
  });
  HTMLElement.prototype.animate = animateMock;
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top }) as DOMRect);
});

afterEach(() => jest.restoreAllMocks());

const Harness = () => {
  const footer = useRef<HTMLDivElement>(null);
  useSlideOnReflow(footer);
  return (
    <div>
      <div ref={footer}>cta</div>
    </div>
  );
};

const InertHarness = ({ inert }: { inert: boolean }) => {
  const footer = useRef<HTMLDivElement>(null);
  useSlideOnReflow(footer);
  return (
    <div {...(inert ? { inert: '' } : {})}>
      <div>
        <div ref={footer}>cta</div>
      </div>
    </div>
  );
};

const keyframes = (): Keyframe[] => animateMock.mock.calls.at(-1)?.[0];
const options = () => animateMock.mock.calls.at(-1)?.[1];

it('slides up from where it was drawn when the keyboard pushes it up', () => {
  render(<Harness />);
  top = 500;
  act(() => reflow());

  expect(keyframes()[0]).toMatchObject({ transform: 'translateY(200px)', offset: 0 });
  expect(keyframes().at(-1)).toMatchObject({ transform: 'translateY(0px)', offset: 1 });
});

it('slides down when the keyboard closes', () => {
  top = 500;
  render(<Harness />);
  top = 700;
  act(() => reflow());

  expect(keyframes()[0]).toMatchObject({ transform: 'translateY(-200px)' });
  expect(keyframes().at(-1)).toMatchObject({ transform: 'translateY(0px)' });
});

// The slide is one of the app's springs, sampled into keyframes so every engine runs it at the
// display's rate (WebKit runs a linear() easing at 60Hz). `standard` is all but critically damped on
// purpose: a CTA riding the keyboard up must not overshoot past the keyboard's edge.
it('runs the slide as sampled keyframes of the shared standard spring', () => {
  render(<Harness />);
  top = 500;
  act(() => reflow());

  const sampled = springKeyframes(springs.standard, 200, 0, v => ({ transform: `translateY(${v}px)` }), 'px');
  expect(keyframes().length).toBeGreaterThan(2);
  expect(keyframes()).toEqual(sampled?.keyframes);
  expect(options()).toEqual({ duration: sampled?.duration, easing: 'linear' });
});

it('slides without asking whether the engine parses linear()', () => {
  const supports = setEngine('no-linear');
  render(<Harness />);
  top = 500;
  act(() => reflow());

  expect(supports.calls).toEqual([]);
  expect(options().easing).toBe('linear');
});

it('starts the slide on the frame the layout moved', () => {
  const previousTimeline = document.timeline;
  Object.defineProperty(document, 'timeline', { configurable: true, value: { currentTime: 50 } });
  try {
    render(<Harness />);
    top = 500;
    let slide: { startTime?: number; cancel: () => void; onfinish: null } | undefined;
    animateMock.mockImplementation(() => {
      slide = { cancel: jest.fn(), onfinish: null };
      return slide;
    });
    act(() => reflow());

    // An unset start time waits for the next frame, and the footer paints at its
    // new place for that gap before the slide begins.
    expect(slide?.startTime).toBe(50);
  } finally {
    Object.defineProperty(document, 'timeline', { configurable: true, value: previousTimeline });
  }
});

it('does nothing when the position did not change', () => {
  render(<Harness />);
  act(() => reflow());

  expect(animateMock).not.toHaveBeenCalled();
});

it('continues from mid-flight when a move interrupts a slide', () => {
  render(<Harness />);
  top = 500;
  act(() => reflow());
  // Halfway through sliding up: still drawn 100px below its new spot.
  computedOffset = 100;
  top = 700;
  act(() => reflow());

  // Drawn at 500 + 100 = 600; new spot 700, so it starts 100px above it.
  expect(keyframes()[0]).toMatchObject({ transform: 'translateY(-100px)' });
  expect(keyframes().at(-1)).toMatchObject({ transform: 'translateY(0px)' });
});

// A hidden tab pane, a covered page layer and an off-screen home pane carry `inert`. A slide there
// is never seen, yet the trace showed it holding the display at 60Hz through a push.
describe('out of sight', () => {
  it('animates nothing inside an inert ancestor', () => {
    render(<InertHarness inert />);
    top = 500;
    act(() => reflow());

    expect(animateMock).not.toHaveBeenCalled();
  });

  it('cancels a slide still running when the page goes out of sight', () => {
    const cancel = jest.fn();
    animateMock.mockImplementation(() => ({ cancel, onfinish: null }));
    const { rerender } = render(<InertHarness inert={false} />);
    top = 500;
    act(() => reflow());
    rerender(<InertHarness inert />);
    top = 400;
    act(() => reflow());

    expect(animateMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a running slide when an ancestor becomes inert before the next reflow', async () => {
    const cancel = jest.fn();
    animateMock.mockImplementation(() => ({ cancel, onfinish: null }));
    const { rerender } = render(<InertHarness inert={false} />);
    top = 500;
    act(() => reflow());
    rerender(<InertHarness inert />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(animateMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);

    rerender(<InertHarness inert={false} />);
    top = 450;
    act(() => reflow());

    expect(keyframes()[0]).toMatchObject({ transform: 'translateY(50px)' });
  });

  it('stops watching for inert once unmounted', () => {
    const observe = jest.spyOn(MutationObserver.prototype, 'observe');
    const disconnect = jest.spyOn(MutationObserver.prototype, 'disconnect');
    const { unmount } = render(<InertHarness inert={false} />);
    const watching = observe.mock.calls.findIndex(([, init]) => init?.attributeFilter?.includes('inert'));
    expect(watching).toBeGreaterThanOrEqual(0);
    unmount();

    expect(disconnect.mock.contexts).toContain(observe.mock.contexts[watching]);
    observe.mockRestore();
    disconnect.mockRestore();
  });

  it('starts from the top it recorded while hidden once the ancestor loses inert', () => {
    const { rerender } = render(<InertHarness inert />);
    top = 500;
    act(() => reflow());
    rerender(<InertHarness inert={false} />);
    top = 450;
    act(() => reflow());

    // Drawn at the recorded 500, new spot 450. A stale 700 would start 250px below it.
    expect(animateMock).toHaveBeenCalledTimes(1);
    expect(keyframes()[0]).toMatchObject({ transform: 'translateY(50px)' });
  });
});

it('snaps without animating under reduced motion', () => {
  reduceMotion = true;
  render(<Harness />);
  top = 500;
  act(() => reflow());

  expect(animateMock).not.toHaveBeenCalled();
});

// The keyboard inset and the docked tab bar are the moves this exists for, and both are mobile.
// Off mobile the only thing that resizes the frame is a window or panel drag, which arrives every
// frame and left the footer trailing its own layout position.
it('does not animate off mobile', () => {
  mockIsMobile = false;
  render(<Harness />);
  top = 500;
  act(() => reflow());

  expect(animateMock).not.toHaveBeenCalled();
});

// Sampling the preference once at mount left the slide running for someone who turned Reduce
// Motion on while a flow page was open.
it('stops the next slide when the preference is turned on after mount', () => {
  const { rerender } = render(<Harness />);
  reduceMotion = true;
  rerender(<Harness />);
  top = 500;
  act(() => reflow());

  expect(animateMock).not.toHaveBeenCalled();
});

it("observes the element's border box, so a padding-only move reaches the slide", () => {
  mockObserved.length = 0;
  const { getByText } = render(<Harness />);
  expect(mockObserved).toContainEqual({ target: getByText('cta'), box: 'border-box' });
});

describe('the linear() predicate other motion sites ask', () => {
  afterEach(() => setEngine('linear'));

  const asked = [['transition-timing-function', 'linear(0, 1)']];
  it.each([
    ['linear', true, asked],
    ['no-linear', false, asked],
    ['no-supports', false, []]
  ] as const)('reports linear() support as the engine does, asking once (%s)', (engine, expected, calls) => {
    const { predicate, supports } = load(engine);
    expect(predicate()).toBe(expected);
    expect(predicate()).toBe(expected);
    expect(supports.calls).toEqual(calls);
  });
});
