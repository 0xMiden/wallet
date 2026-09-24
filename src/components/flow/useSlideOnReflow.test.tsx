import React, { useRef } from 'react';

import { act, render } from '@testing-library/react';

import { springToLinearEasing, springs } from 'lib/animation';

import { useSlideOnReflow } from './useSlideOnReflow';

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

const keyframes = () => animateMock.mock.calls.at(-1)?.[0];
const options = () => animateMock.mock.calls.at(-1)?.[1];

it('slides up from where it was drawn when the keyboard pushes it up', () => {
  render(<Harness />);
  top = 500;
  act(() => reflow());

  expect(keyframes()).toEqual([{ transform: 'translateY(200px)' }, { transform: 'translateY(0)' }]);
});

it('slides down when the keyboard closes', () => {
  top = 500;
  render(<Harness />);
  top = 700;
  act(() => reflow());

  expect(keyframes()).toEqual([{ transform: 'translateY(-200px)' }, { transform: 'translateY(0)' }]);
});

// The slide is one of the app's springs, solved into a `linear()` curve so the compositor can run
// it above WKWebView's 60Hz rAF cap. `standard` is all but critically damped on purpose: a CTA
// riding the keyboard up must not overshoot past the keyboard's edge.
it('runs the slide on the shared standard spring, as a compositor curve', () => {
  render(<Harness />);
  top = 500;
  act(() => reflow());

  const solved = springToLinearEasing(springs.standard, { distance: 200 });
  expect(options()).toEqual({ duration: solved?.duration, easing: solved?.easing });
  expect(options().easing).toMatch(/^linear\(/);
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
  expect(keyframes()).toEqual([{ transform: 'translateY(-100px)' }, { transform: 'translateY(0)' }]);
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
