import React from 'react';

import { act, render } from '@testing-library/react';

import { pagerMotion, pagerTapDurationMs } from 'lib/animation';
import { holdNavbarHidden, useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { _resetInteractionPriorityForTest, isInteracting } from 'lib/ui/interaction-priority';

import HomeSwipeContainer from './HomeSwipeContainer';
import { PageActiveContext, TabActiveContext, usePageActive } from './page-active';

const mockNavigate = jest.fn();
let mockPathname = '/';
const mockSwapEnabled = { value: true };
const mockReduceMotion = { value: false };
const mockHapticSelection = jest.fn();
const mockBoostRefreshRate = jest.fn();
const mockUseHideNavbarWhileOpen = useHideNavbarWhileOpen;
const mockSwapReview = { open: false };
const mockReceiveRenders = { count: 0 };

jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReduceMotion.value
}));

jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  useLocation: () => ({ pathname: mockPathname })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticSelection: (...args: unknown[]) => mockHapticSelection(...args)
}));

jest.mock('lib/mobile/high-refresh-rate', () => ({
  boostRefreshRate: (...args: unknown[]) => mockBoostRefreshRate(...args)
}));

jest.mock('lib/feature-flags', () => ({
  isSwapEnabled: () => mockSwapEnabled.value
}));

// Child pages pull in the full wallet stack; each marker reports the page-active value it renders under.
function MockPage({ renders, ...props }: React.ComponentProps<'div'> & { renders?: { count: number } }) {
  if (renders) renders.count += 1;
  return <div {...props} data-page-active={String(usePageActive())} />;
}
jest.mock('app/pages/Explore', () => ({
  __esModule: true,
  default: () => <MockPage data-testid="page-explore" />
}));
jest.mock('app/pages/Earn', () => ({
  __esModule: true,
  default: () => <MockPage data-testid="page-earn" />
}));
jest.mock('app/pages/Receive', () => ({
  __esModule: true,
  Receive: () => <MockPage data-testid="page-receive" renders={mockReceiveRenders} />
}));
jest.mock('screens/send-flow/SendManager', () => ({
  __esModule: true,
  SendFlow: ({ isLoading }: { isLoading?: boolean }) => (
    <MockPage data-testid="page-send" data-loading={String(isLoading)}>
      <input data-testid="send-amount-input" />
    </MockPage>
  )
}));
jest.mock('screens/swap-flow/SwapManager', () => ({
  __esModule: true,
  SwapFlow: () => {
    mockUseHideNavbarWhileOpen(mockSwapReview.open);
    return (
      <MockPage data-testid="page-swap">
        <input data-testid="swap-amount-input" />
      </MockPage>
    );
  }
}));

let mockRoCallback: ((entries: unknown[]) => void) | null = null;
const mockRoDisconnect = jest.fn();
class MockResizeObserver {
  constructor(cb: (entries: unknown[]) => void) {
    mockRoCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {
    mockRoDisconnect();
  }
}

/** What the component hands the compositor for a tap's slide; jsdom has no Web Animations. */
interface FakeAnimation {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: jest.Mock;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
}
let mockAnimations: FakeAnimation[] = [];

const W = 300;
let mockWidth = 0;

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: MockResizeObserver
  });
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation: FakeAnimation = { keyframes, options, cancel: jest.fn(), onfinish: null, oncancel: null };
      mockAnimations.push(animation);
      return animation;
    }
  });
  // Enough of DOMMatrixReadOnly to read back a translateX, which is all the component asks of it.
  Object.defineProperty(globalThis, 'DOMMatrixReadOnly', {
    configurable: true,
    writable: true,
    value: class {
      m41: number;
      constructor(transform: string) {
        const match = /translateX\((-?[\d.]+)px\)/.exec(transform);
        this.m41 = match ? Number(match[1]) : 0;
      }
    }
  });
  // An engine with scrollend, unless a test removes it.
  Object.defineProperty(window, 'onscrollend', { configurable: true, writable: true, value: null });
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  _resetInteractionPriorityForTest();
  mockPathname = '/';
  mockSwapEnabled.value = true;
  mockSwapReview.open = false;
  mockReduceMotion.value = false;
  mockRoCallback = null;
  mockAnimations = [];
  mockWidth = 0;
  document.body.removeAttribute('data-hide-navbar');
});

afterEach(() => {
  document.body.removeAttribute('data-hide-navbar');
});

/** The scroller is the page wrappers' grandparent: scroller, then track, then one wrapper per page. */
function scrollerOf(page: HTMLElement): HTMLElement {
  const scroller = page.closest('[data-home-page]')?.parentElement?.parentElement;
  if (!scroller) throw new Error('expected the pager scroller');
  return scroller;
}

const mockScrollTo = jest.fn();

/** jsdom has no layout or scrolling, so the scroller gets a width, a writable position and a scrollTo. */
function mount(ui: React.ReactElement = <HomeSwipeContainer />) {
  const view = render(ui);
  const scroller = scrollerOf(view.getByTestId('page-explore'));
  const track = scroller.firstElementChild;
  if (!(track instanceof HTMLElement)) throw new Error('expected the pager track');
  Object.defineProperty(scroller, 'scrollLeft', { configurable: true, writable: true, value: 0 });
  Object.defineProperty(scroller, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: mockWidth, height: 600, top: 0, left: 0, right: mockWidth, bottom: 600, x: 0, y: 0 })
  });
  mockScrollTo.mockImplementation((options: ScrollToOptions) => {
    if (typeof options.left === 'number') scroller.scrollLeft = options.left;
  });
  Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: mockScrollTo });
  return { ...view, scroller, track };
}

function measure(width: number) {
  mockWidth = width;
  act(() => {
    mockRoCallback?.([{ contentRect: { width } }]);
  });
}

/** `touches` is the count still down, or the targets of the fingers still down. */
function fire(target: EventTarget, type: string, touches?: number | EventTarget[]): Event {
  const init = { bubbles: true, cancelable: true };
  const event = type.startsWith('touch') ? new TouchEvent(type, init) : new Event(type, init);
  if (touches !== undefined) {
    const down =
      typeof touches === 'number'
        ? Array.from({ length: touches }, () => ({ target }))
        : touches.map(t => ({ target: t }));
    Object.defineProperty(event, 'touches', { value: down });
  }
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** One rendering step: scroll events from a programmatic move have fired, and the frame's callbacks run. */
function frame() {
  act(() => {
    jest.advanceTimersByTime(16);
  });
}

/** A user scroll that comes to rest at `left`, reported the way an engine with `scrollend` does. */
function settleAt(scroller: HTMLElement, left: number) {
  scroller.scrollLeft = left;
  fire(scroller, 'scroll');
  fire(scroller, 'scrollend');
}

function route(
  rerender: (ui: React.ReactElement) => void,
  path: string,
  ui: React.ReactElement = <HomeSwipeContainer />
) {
  mockPathname = path;
  act(() => {
    rerender(ui);
  });
}

function lastAnimation(): FakeAnimation {
  const animation = mockAnimations[mockAnimations.length - 1];
  if (!animation) throw new Error('expected a tap slide to have started');
  return animation;
}

function finishAnimation(animation: FakeAnimation) {
  act(() => {
    animation.onfinish?.();
  });
}

/** The pager after a tap on the bar has finished sliding to `path`. */
function tapTo(rerender: (ui: React.ReactElement) => void, path: string) {
  route(rerender, path);
  frame();
  if (mockAnimations.length) finishAnimation(lastAnimation());
}

/** Takes `scrollend` away, as on an engine without it. Returns the restore. */
function withoutScrollEnd(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'onscrollend');
  Reflect.deleteProperty(window, 'onscrollend');
  return () => {
    if (descriptor) Object.defineProperty(window, 'onscrollend', descriptor);
  };
}

const notInert = (scroller: HTMLElement) =>
  Array.from(scroller.querySelectorAll('[data-home-page]'))
    .filter(page => !page.hasAttribute('inert'))
    .map(page => page.getAttribute('data-home-page'));

describe('HomeSwipeContainer', () => {
  // #1811: framer drag measured the track mid-release and added the animated offset to the drag, so a
  // second swipe from Earn toward Receive committed to Swap. The committed pane must be the one the
  // scroller settled on.
  it('commits the pane the scroller settled on, in the direction of the swipe (#1811)', () => {
    const { scroller, rerender } = mount();
    measure(W);
    tapTo(rerender, '/swap');
    scroller.scrollLeft = 4 * W;

    settleAt(scroller, 3 * W);
    expect(mockNavigate).toHaveBeenLastCalledWith('/earn');

    route(rerender, '/earn');
    settleAt(scroller, 2 * W);

    expect(mockNavigate.mock.calls).toEqual([['/earn'], ['/receive']]);
    expect(mockNavigate).not.toHaveBeenCalledWith('/swap');
  });

  describe('settling', () => {
    it('stays silent when the scroller comes back to rest on the current page', () => {
      mockPathname = '/send';
      const { scroller } = mount();
      measure(W);
      settleAt(scroller, W);
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockHapticSelection).not.toHaveBeenCalled();
    });

    it('buzzes once, then navigates, when it comes to rest on another page', () => {
      const { scroller } = mount();
      measure(W);
      settleAt(scroller, W);
      expect(mockHapticSelection).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/send');
      expect(mockHapticSelection.mock.invocationCallOrder[0]).toBeLessThan(mockNavigate.mock.invocationCallOrder[0]!);
    });

    // A navigation that is refused or redirected leaves the route where it was, so the next rest is
    // judged against the route, not against the page that was asked for.
    it('judges each rest against the route even after a navigation that did not land', () => {
      const { scroller, rerender } = mount();
      measure(W);
      settleAt(scroller, W);
      expect(mockNavigate).toHaveBeenCalledWith('/send');
      act(() => {
        rerender(<HomeSwipeContainer />);
      });

      settleAt(scroller, 0);

      expect(mockNavigate.mock.calls).toEqual([['/send']]);
      expect(mockHapticSelection).toHaveBeenCalledTimes(1);
    });

    it('commits a rest once, however many times the engine reports it', () => {
      const { scroller } = mount();
      measure(W);
      settleAt(scroller, W);
      fire(scroller, 'scrollend');
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs * 2);
      });
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockHapticSelection).toHaveBeenCalledTimes(1);
    });

    it('stays silent at either end, where there is no page past the edge', () => {
      mockPathname = '/swap';
      const { scroller, rerender } = mount();
      measure(W);
      settleAt(scroller, 4 * W);
      tapTo(rerender, '/');
      settleAt(scroller, 0);
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockHapticSelection).not.toHaveBeenCalled();
    });

    it('never commits while a finger is still down', () => {
      const { scroller } = mount();
      measure(W);
      fire(scroller, 'touchstart', 1);
      settleAt(scroller, W);
      expect(mockNavigate).not.toHaveBeenCalled();

      fire(scroller, 'touchend', 0);
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs);
      });
      expect(mockNavigate).toHaveBeenCalledWith('/send');
    });

    // A touch keeps targeting the node it started on after that node leaves the document, and a
    // detached node's events reach no ancestor: the scroller never hears this touch end.
    it('commits after a touch whose target was removed while the finger was down', () => {
      const { scroller, getByTestId } = mount();
      measure(W);
      const row = document.createElement('div');
      getByTestId('page-explore').appendChild(row);
      fire(row, 'touchstart', 1);
      row.remove();
      settleAt(scroller, W);
      expect(mockNavigate).not.toHaveBeenCalled();

      fire(row, 'touchend', 0);
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs);
      });

      expect(mockNavigate).toHaveBeenCalledWith('/send');
    });

    it('waits for the last finger of several, wherever each started', () => {
      const { scroller, getByTestId } = mount();
      measure(W);
      const row = document.createElement('div');
      getByTestId('page-explore').appendChild(row);
      fire(row, 'touchstart', 1);
      fire(scroller, 'touchstart', 2);
      row.remove();
      settleAt(scroller, W);

      fire(row, 'touchend', [scroller]);
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs);
      });
      expect(mockNavigate).not.toHaveBeenCalled();

      fire(scroller, 'touchend', 0);
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs);
      });
      expect(mockNavigate).toHaveBeenCalledWith('/send');
    });

    it('lets go once the pager fingers lift, though a finger outside the pager is still down', () => {
      const { scroller } = mount();
      measure(W);
      const outside = document.createElement('div');
      document.body.appendChild(outside);
      fire(scroller, 'touchstart', 1);
      settleAt(scroller, W);

      fire(scroller, 'touchend', [outside]);
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs);
      });
      expect(mockNavigate).toHaveBeenCalledWith('/send');
      outside.remove();
    });

    it('waits out a fling that is still coasting after the finger lifts', () => {
      const { scroller } = mount();
      measure(W);
      fire(scroller, 'touchstart', 1);
      fire(scroller, 'touchend', 0);
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs - 20);
      });
      scroller.scrollLeft = 0.5 * W;
      fire(scroller, 'scroll');
      act(() => {
        jest.advanceTimersByTime(20);
      });
      expect(mockScrollTo).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('settles after a cancelled touch as after a lifted one', () => {
      const { scroller } = mount();
      measure(W);
      fire(scroller, 'touchstart', 1);
      settleAt(scroller, W);
      fire(scroller, 'touchcancel', 0);
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs);
      });
      expect(mockNavigate).toHaveBeenCalledWith('/send');
    });

    it('lands a scroller left between two pages on the nearer one', () => {
      const { scroller } = mount();
      measure(W);
      scroller.scrollLeft = 0.7 * W;
      fire(scroller, 'scroll');
      fire(scroller, 'scrollend');
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockScrollTo).toHaveBeenLastCalledWith({ left: W, behavior: 'smooth' });
    });

    it('commits nothing while the width is unmeasured', () => {
      const { scroller } = mount();
      act(() => {
        mockRoCallback?.([{ contentRect: { width: 0 } }]);
      });
      settleAt(scroller, W);
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(isInteracting()).toBe(false);
    });
  });

  describe('settling on an engine without scrollend', () => {
    let restore: () => void = () => {};
    beforeEach(() => {
      restore = withoutScrollEnd();
    });
    afterEach(() => restore());

    const scrollTo = (scroller: HTMLElement, left: number) => {
      scroller.scrollLeft = left;
      fire(scroller, 'scroll');
    };
    const idle = (ms: number) =>
      act(() => {
        jest.advanceTimersByTime(ms);
      });

    it('commits once the scroller has been still for the idle time, aligned and released', () => {
      const { scroller } = mount();
      measure(W);
      scrollTo(scroller, W);
      idle(pagerMotion.settleIdleMs - 1);
      expect(mockNavigate).not.toHaveBeenCalled();
      idle(1);
      expect(mockNavigate).toHaveBeenCalledWith('/send');
    });

    it('leaves a tap slide to its own finish when an idle check armed before it comes due', () => {
      const { scroller, rerender } = mount();
      measure(W);
      scrollTo(scroller, 0);
      route(rerender, '/send');
      frame();
      mockNavigate.mockClear();

      scroller.scrollLeft = 4 * W;
      idle(pagerMotion.settleIdleMs);
      expect(mockNavigate).not.toHaveBeenCalled();

      finishAnimation(lastAnimation());
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/swap');
    });

    it('waits for every scroll event, not the first', () => {
      const { scroller } = mount();
      measure(W);
      scrollTo(scroller, 0.5 * W);
      idle(pagerMotion.settleIdleMs - 1);
      scrollTo(scroller, W);
      idle(pagerMotion.settleIdleMs - 1);
      expect(mockNavigate).not.toHaveBeenCalled();
      idle(1);
      expect(mockNavigate).toHaveBeenCalledWith('/send');
    });

    it('does not commit while a finger is down', () => {
      const { scroller } = mount();
      measure(W);
      fire(scroller, 'touchstart', 1);
      scrollTo(scroller, W);
      idle(pagerMotion.settleIdleMs * 3);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('does not commit while the scroller is between pages', () => {
      const { scroller } = mount();
      measure(W);
      scrollTo(scroller, W + 2 * pagerMotion.alignTolerancePx);
      idle(pagerMotion.settleIdleMs);
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('a tap on the bar', () => {
    it('jumps the scroller and slides the track from where the content was', () => {
      const { scroller, track, rerender } = mount();
      measure(W);

      route(rerender, '/earn');

      expect(mockScrollTo).toHaveBeenLastCalledWith({ left: 3 * W, behavior: 'auto' });
      expect(mockAnimations).toHaveLength(1);
      expect(lastAnimation().keyframes).toEqual([{ transform: `translateX(${3 * W}px)` }, { transform: 'none' }]);
      expect(lastAnimation().options).toEqual({ duration: pagerTapDurationMs(3), easing: pagerMotion.tapEasing });
      expect(mockBoostRefreshRate).toHaveBeenCalledWith(pagerTapDurationMs(3));
      expect(scroller.scrollLeft).toBe(3 * W);
      expect(track.style.willChange).toBe('transform');
      expect(isInteracting()).toBe(true);

      finishAnimation(lastAnimation());
      expect(track.style.willChange).toBe('');
      expect(isInteracting()).toBe(false);
    });

    it('starts from the live position when the scroller is off its page', () => {
      const { scroller, rerender } = mount();
      measure(W);
      scroller.scrollLeft = 40;

      route(rerender, '/send');

      expect(lastAnimation().keyframes[0]).toEqual({ transform: `translateX(${W - 40}px)` });
    });

    it('stops a coasting scroller for a frame before it jumps', () => {
      const { scroller, rerender } = mount();
      measure(W);
      scroller.scrollLeft = 20;
      fire(scroller, 'scroll');

      route(rerender, '/receive');
      expect(scroller.style.overflowX).toBe('hidden');
      // Restored only after the frame that painted it hidden, so the compositor sees the stop.
      frame();
      expect(scroller.style.overflowX).toBe('hidden');
      frame();
      expect(scroller.style.overflowX).toBe('auto');
    });

    it('leaves a still scroller scrollable', () => {
      const { scroller, rerender } = mount();
      measure(W);
      route(rerender, '/receive');
      expect(scroller.style.overflowX).toBe('auto');
    });

    it('never commits the scroll events its own jump fires', () => {
      const { scroller, rerender } = mount();
      measure(W);
      route(rerender, '/earn');

      // Move the scroller too: had the flag been dropped, this rest would commit Receive.
      scroller.scrollLeft = 2 * W;
      fire(scroller, 'scroll');
      fire(scroller, 'scrollend');

      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('does not count its own jump as the start of a user gesture', () => {
      const { scroller, rerender } = mount();
      measure(W);
      route(rerender, '/earn');
      fire(scroller, 'scroll');
      finishAnimation(lastAnimation());
      expect(isInteracting()).toBe(false);
    });

    it('jumps with no slide under reduced motion', () => {
      mockReduceMotion.value = true;
      const { scroller, rerender } = mount();
      measure(W);
      route(rerender, '/earn');
      expect(scroller.scrollLeft).toBe(3 * W);
      expect(mockAnimations).toHaveLength(0);
    });

    it('does nothing when the scroller is already on the page', () => {
      const { scroller, rerender } = mount();
      measure(W);
      scroller.scrollLeft = 2 * W;
      mockScrollTo.mockClear();
      route(rerender, '/receive');
      expect(mockScrollTo).not.toHaveBeenCalled();
      expect(mockAnimations).toHaveLength(0);
    });

    // Snap areas follow the track's transform, so a mandatory scroller would re-snap under the
    // slide every frame: the slide never shows, and each re-snap reports a scroll.
    it('turns snapping off before the jump and on again once the slide ends', () => {
      const { scroller, rerender } = mount();
      measure(W);
      const snapAtJump: string[] = [];
      const jump = mockScrollTo.getMockImplementation();
      mockScrollTo.mockImplementation((options: ScrollToOptions) => {
        snapAtJump.push(scroller.style.scrollSnapType);
        jump?.(options);
      });

      route(rerender, '/earn');
      expect(snapAtJump).toEqual(['none']);
      frame();
      expect(scroller.style.scrollSnapType).toBe('none');

      finishAnimation(lastAnimation());
      expect(scroller.style.scrollSnapType).toBe('x mandatory');
    });

    it('keeps snapping off across a second tap and restores it when that slide ends', () => {
      const { scroller, rerender } = mount();
      measure(W);
      route(rerender, '/earn');
      const first = lastAnimation();

      route(rerender, '/send');
      expect(first.cancel).toHaveBeenCalled();
      expect(scroller.style.scrollSnapType).toBe('none');

      finishAnimation(lastAnimation());
      expect(scroller.style.scrollSnapType).toBe('x mandatory');
    });

    it('never navigates on the scroll and scrollend events fired during a slide', () => {
      const { scroller, rerender } = mount();
      measure(W);
      route(rerender, '/earn');
      frame();

      // Past the jump's own events: a re-snap or any other engine scroll mid-slide.
      scroller.scrollLeft = 2 * W;
      fire(scroller, 'scroll');
      fire(scroller, 'scrollend');
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs * 2);
      });

      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockHapticSelection).not.toHaveBeenCalled();
      expect(mockScrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
    });

    it('starts a second tap from where the first slide is on screen', () => {
      const { track, rerender } = mount();
      measure(W);
      route(rerender, '/earn');
      const first = lastAnimation();
      // Two thirds of the way from Overview to Earn: on screen at 600, the track 300px from rest.
      track.style.transform = `translateX(${W}px)`;

      route(rerender, '/send');

      expect(first.cancel).toHaveBeenCalled();
      expect(lastAnimation().keyframes[0]).toEqual({ transform: `translateX(${W - 2 * W}px)` });
    });
  });

  // A wheel or trackpad scroll sends no touches, so its events are dropped while the slide runs;
  // the slide's end is then the only chance to notice the scroller is somewhere else.
  describe('a wheel scroll during a tap slide', () => {
    it('settles a finished slide onto the page a wheel left there', () => {
      const { scroller, rerender } = mount();
      measure(W);
      route(rerender, '/send');
      frame();
      mockNavigate.mockClear();
      mockHapticSelection.mockClear();
      mockScrollTo.mockClear();

      scroller.scrollLeft = 4 * W;
      finishAnimation(lastAnimation());

      expect(mockNavigate).toHaveBeenCalledWith('/swap');
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockHapticSelection).toHaveBeenCalledTimes(1);
      expect(mockHapticSelection.mock.invocationCallOrder[0]).toBeLessThan(mockNavigate.mock.invocationCallOrder[0]!);
      expect(scroller.scrollLeft).toBe(4 * W);
      expect(mockScrollTo).not.toHaveBeenCalled();

      route(rerender, '/swap');
      expect(notInert(scroller)).toEqual(['swap']);
    });

    it('nudges a finished slide that a wheel left between pages', () => {
      const { scroller, rerender } = mount();
      measure(W);
      route(rerender, '/earn');
      frame();
      mockNavigate.mockClear();
      mockHapticSelection.mockClear();
      mockScrollTo.mockClear();

      scroller.scrollLeft = 2 * W + 120;
      finishAnimation(lastAnimation());

      expect(mockScrollTo).toHaveBeenLastCalledWith({ left: 2 * W, behavior: 'smooth' });
      expect(mockNavigate).not.toHaveBeenCalled();

      scroller.scrollLeft = 2 * W;
      fire(scroller, 'scrollend');

      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/receive');
    });

    it('does not settle a slide a touch catches before it finishes', () => {
      const { scroller, rerender } = mount();
      measure(W);
      route(rerender, '/earn');
      scroller.scrollLeft = 4 * W;

      fire(scroller, 'touchstart', 1);

      expect(mockNavigate).not.toHaveBeenCalled();
      expect(scroller.scrollLeft).toBe(3 * W);
    });

    it('settles a slide that finishes under a finger only once the finger lifts', () => {
      const { scroller, rerender } = mount();
      measure(W);
      fire(scroller, 'touchstart', 1);
      route(rerender, '/send');
      scroller.scrollLeft = 4 * W;

      finishAnimation(lastAnimation());
      expect(mockNavigate).not.toHaveBeenCalled();

      fire(scroller, 'touchend', 0);
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs);
      });

      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/swap');
    });
  });

  describe('a touch during a tap slide', () => {
    it('catches the slide where it is on screen and hands it to the native scroll', () => {
      const { scroller, track, rerender } = mount();
      measure(W);
      route(rerender, '/earn');
      frame();
      track.style.transform = 'translateX(180px)';

      fire(scroller, 'touchstart', 1);

      expect(lastAnimation().cancel).toHaveBeenCalled();
      expect(scroller.scrollLeft).toBe(3 * W - 180);
      expect(track.style.willChange).toBe('');
      // Still a gesture: the finger is down.
      expect(isInteracting()).toBe(true);
    });

    // A mandatory snap container re-snaps a programmatic scroll, which would jump the caught slide to
    // a page edge, so snapping is off from the catch until the finger lifts.
    it('suspends snapping from the catch until the finger lifts', () => {
      const { scroller, track, rerender } = mount();
      measure(W);
      expect(scroller.style.scrollSnapType).toBe('x mandatory');
      route(rerender, '/earn');
      frame();
      track.style.transform = 'translateX(180px)';

      fire(scroller, 'touchstart', 1);
      expect(scroller.style.scrollSnapType).toBe('none');

      fire(scroller, 'touchend', 0);
      expect(scroller.style.scrollSnapType).toBe('x mandatory');
    });

    it('keeps snapping off until the finger lifts, even when a slide ends under it', () => {
      const { scroller, track, rerender } = mount();
      measure(W);
      route(rerender, '/earn');
      frame();
      track.style.transform = 'translateX(180px)';
      fire(scroller, 'touchstart', 1);

      // A route change while the finger is still down slides, and that slide ends first.
      route(rerender, '/send');
      finishAnimation(lastAnimation());
      expect(scroller.style.scrollSnapType).toBe('none');

      fire(scroller, 'touchend', 0);
      expect(scroller.style.scrollSnapType).toBe('x mandatory');
    });

    it('restores snapping when the catching touch is cancelled', () => {
      const { scroller, track, rerender } = mount();
      measure(W);
      route(rerender, '/earn');
      frame();
      track.style.transform = 'translateX(180px)';
      fire(scroller, 'touchstart', 1);

      fire(scroller, 'touchcancel', 0);
      expect(scroller.style.scrollSnapType).toBe('x mandatory');
    });

    it('leaves snapping alone for a touch that catches no slide', () => {
      const { scroller } = mount();
      measure(W);
      fire(scroller, 'touchstart', 1);
      expect(scroller.style.scrollSnapType).toBe('x mandatory');
    });

    it('restores snapping on unmount mid-catch', () => {
      const { scroller, track, rerender, unmount } = mount();
      measure(W);
      route(rerender, '/earn');
      frame();
      track.style.transform = 'translateX(180px)';
      fire(scroller, 'touchstart', 1);

      unmount();
      expect(scroller.style.scrollSnapType).toBe('x mandatory');
    });

    it('lands on a page when the touch lifts without dragging', () => {
      const { scroller, track, rerender } = mount();
      measure(W);
      route(rerender, '/earn');
      frame();
      track.style.transform = 'translateX(180px)';
      fire(scroller, 'touchstart', 1);
      frame();

      fire(scroller, 'touchend', 0);
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs);
      });

      // 720 is nearest Receive at 600.
      expect(mockScrollTo).toHaveBeenLastCalledWith({ left: 2 * W, behavior: 'smooth' });
    });

    it('does not focus a field it lands on mid-slide', () => {
      const { getByTestId, rerender } = mount();
      measure(W);
      route(rerender, '/swap');
      expect(fire(getByTestId('swap-amount-input'), 'pointerdown').defaultPrevented).toBe(true);
    });

    it('lets a tap focus a field while nothing is sliding', () => {
      const { getByTestId, rerender } = mount();
      measure(W);
      tapTo(rerender, '/swap');
      expect(fire(getByTestId('swap-amount-input'), 'pointerdown').defaultPrevented).toBe(false);
    });
  });

  describe('placement', () => {
    it('places the route page without a slide once measured', () => {
      mockPathname = '/receive';
      const { scroller } = mount();
      measure(W);
      expect(scroller.scrollLeft).toBe(2 * W);
      expect(mockAnimations).toHaveLength(0);
    });

    it('matches nested routes by prefix', () => {
      mockPathname = '/send/amount';
      const { scroller } = mount();
      measure(W);
      expect(scroller.scrollLeft).toBe(W);
    });

    it('falls back to Overview for an unknown path, never treating "/" as a prefix', () => {
      mockPathname = '/xyz';
      const { scroller } = mount();
      measure(W);
      expect(scroller.scrollLeft).toBe(0);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('realigns to the route page without a slide when the width changes', () => {
      mockPathname = '/send';
      const { scroller } = mount();
      measure(W);
      measure(400);
      expect(scroller.scrollLeft).toBe(400);
      expect(mockAnimations).toHaveLength(0);
    });
  });

  describe('while another tab is showing', () => {
    const pane = (shown: boolean) => (
      <TabActiveContext.Provider value={shown}>
        <HomeSwipeContainer />
      </TabActiveContext.Provider>
    );

    it('holds the pager on its page instead of sliding it to Overview', () => {
      mockPathname = '/send';
      const { scroller, rerender } = mount(pane(true));
      measure(W);
      mockScrollTo.mockClear();

      route(rerender, '/history', pane(false));

      expect(mockScrollTo).not.toHaveBeenCalled();
      expect(mockAnimations).toHaveLength(0);
      expect(scroller.scrollLeft).toBe(W);
    });

    it('shows the page again without a slide when the route comes back to it', () => {
      mockPathname = '/send';
      const { scroller, rerender } = mount(pane(true));
      measure(W);
      route(rerender, '/history', pane(false));

      route(rerender, '/send', pane(true));

      expect(mockAnimations).toHaveLength(0);
      expect(scroller.scrollLeft).toBe(W);
    });

    it('swaps straight to Overview when Home is chosen from another tab', () => {
      mockPathname = '/receive';
      const { scroller, rerender } = mount(pane(true));
      measure(W);
      route(rerender, '/history', pane(false));

      route(rerender, '/', pane(true));

      expect(mockAnimations).toHaveLength(0);
      expect(scroller.scrollLeft).toBe(0);
    });

    it('lets a slide in flight finish when another tab is chosen', () => {
      const { rerender } = mount(pane(true));
      measure(W);
      route(rerender, '/earn', pane(true));
      route(rerender, '/history', pane(false));
      expect(lastAnimation().cancel).not.toHaveBeenCalled();
    });

    it('settles against the held page while the route names none', () => {
      mockPathname = '/send';
      const { scroller, rerender } = mount(pane(true));
      measure(W);
      route(rerender, '/history', pane(false));
      settleAt(scroller, W);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    // Only the tab's return swaps (#1194). A slide page closing back onto another Home page flips
    // PageActiveContext and the route in one commit while the tab stays shown, and that reveal slides.
    it('slides when a slide page closes back onto another Home page', () => {
      const layer = (active: boolean) => (
        <TabActiveContext.Provider value={true}>
          <PageActiveContext.Provider value={active}>
            <HomeSwipeContainer />
          </PageActiveContext.Provider>
        </TabActiveContext.Provider>
      );
      mockPathname = '/receive';
      const { rerender } = mount(layer(true));
      measure(W);
      act(() => {
        rerender(layer(false));
      });

      route(rerender, '/', layer(true));

      expect(mockAnimations).toHaveLength(1);
    });
  });

  describe('which Home page is on screen', () => {
    const pageActive = (getByTestId: (id: string) => HTMLElement, id: string) =>
      getByTestId(`page-${id}`).getAttribute('data-page-active');

    it('gives only Overview an active page at "/"', () => {
      const { getByTestId } = mount();
      expect(pageActive(getByTestId, 'explore')).toBe('true');
      for (const id of ['send', 'receive', 'earn', 'swap']) expect(pageActive(getByTestId, id)).toBe('false');
    });

    it('moves the active page to Earn when the route does', () => {
      const { getByTestId, rerender } = mount();
      route(rerender, '/earn');
      expect(pageActive(getByTestId, 'earn')).toBe('true');
      for (const id of ['explore', 'send', 'receive', 'swap']) expect(pageActive(getByTestId, id)).toBe('false');
    });

    it('leaves every page inactive while another tab is showing', () => {
      mockPathname = '/history';
      const { getByTestId } = mount(
        <PageActiveContext.Provider value={false}>
          <HomeSwipeContainer />
        </PageActiveContext.Provider>
      );
      for (const id of ['explore', 'send', 'receive', 'earn', 'swap']) {
        expect(pageActive(getByTestId, id)).toBe('false');
      }
    });

    it('makes every pane but the settled one inert', () => {
      const { scroller, rerender } = mount();
      measure(W);
      expect(notInert(scroller)).toEqual(['overview']);

      settleAt(scroller, 3 * W);
      expect(mockNavigate).toHaveBeenCalledWith('/earn');
      route(rerender, '/earn');

      expect(notInert(scroller)).toEqual(['earn']);
    });
  });

  describe('pages', () => {
    it('mounts all five home pages in the track', () => {
      const { getByTestId } = mount();
      for (const id of ['explore', 'send', 'receive', 'earn', 'swap']) {
        expect(getByTestId(`page-${id}`)).toBeInTheDocument();
      }
    });

    it('re-renders only the panes whose flags a route change flips', () => {
      const { getByTestId, rerender } = mount();
      measure(W);
      const before = mockReceiveRenders.count;

      tapTo(rerender, '/send');

      expect(getByTestId('page-send')).toHaveAttribute('data-page-active', 'true');
      expect(mockReceiveRenders.count).toBe(before);

      tapTo(rerender, '/receive');
      expect(mockReceiveRenders.count).toBe(before + 1);
    });

    it('passes isLoading={false} to the SendFlow', () => {
      const { getByTestId } = mount();
      expect(getByTestId('page-send')).toHaveAttribute('data-loading', 'false');
    });

    it('drops the Swap pane when swap is disabled, keeping the track math on four pages', () => {
      mockSwapEnabled.value = false;
      const { queryByTestId, getByTestId, scroller, track } = mount();
      expect(queryByTestId('page-swap')).toBeNull();
      for (const id of ['explore', 'send', 'receive', 'earn']) {
        expect(getByTestId(`page-${id}`)).toBeInTheDocument();
      }
      expect(track.style.width).toBe('400%');
      measure(W);
      settleAt(scroller, 3 * W);
      expect(mockNavigate).toHaveBeenCalledWith('/earn');
    });
  });

  describe('swipe lock (#481)', () => {
    it('stops user scrolling while data-hide-navbar is set, and gives it back after', async () => {
      const { scroller } = mount();
      expect(scroller.style.overflowX).toBe('auto');

      await act(async () => {
        document.body.setAttribute('data-hide-navbar', '');
        await Promise.resolve();
      });
      expect(scroller.style.overflowX).toBe('hidden');

      await act(async () => {
        document.body.removeAttribute('data-hide-navbar');
        await Promise.resolve();
      });
      expect(scroller.style.overflowX).toBe('auto');
    });

    it('starts locked when the flag is already set at mount, and still moves for a route change', () => {
      document.body.setAttribute('data-hide-navbar', '');
      const { scroller, rerender } = mount();
      expect(scroller.style.overflowX).toBe('hidden');
      measure(W);
      route(rerender, '/send');
      expect(scroller.scrollLeft).toBe(W);
    });
  });

  describe('focus and navbar holds', () => {
    it('releases a Swap review hold when its action page moves out of view', () => {
      mockPathname = '/swap';
      mockSwapReview.open = true;
      const { rerender } = mount();
      expect(document.body).toHaveAttribute('data-hide-navbar');

      route(rerender, '/receive');
      expect(document.body).not.toHaveAttribute('data-hide-navbar');

      route(rerender, '/swap');
      expect(document.body).toHaveAttribute('data-hide-navbar');
    });

    it('releases keyboard focus when a retained action page moves out of view', () => {
      mockPathname = '/send';
      const { getByTestId, rerender } = mount();
      const input = getByTestId('send-amount-input');
      let releaseNavbar: (() => void) | undefined;
      input.addEventListener('focus', () => {
        releaseNavbar = holdNavbarHidden();
      });
      input.addEventListener('blur', () => {
        releaseNavbar?.();
      });

      input.focus();
      expect(document.body).toHaveAttribute('data-hide-navbar');

      route(rerender, '/receive');

      expect(input).not.toHaveFocus();
      expect(document.body).not.toHaveAttribute('data-hide-navbar');
    });
  });

  describe('gesture signal', () => {
    it('begins on touchstart and ends when the scroller settles', () => {
      const { scroller } = mount();
      measure(W);
      fire(scroller, 'touchstart', 1);
      expect(isInteracting()).toBe(true);
      fire(scroller, 'touchend', 0);
      settleAt(scroller, W);
      expect(isInteracting()).toBe(false);
    });

    it('begins on the first scroll event, as a trackpad swipe sends no touches', () => {
      const { scroller } = mount();
      measure(W);
      scroller.scrollLeft = 10;
      fire(scroller, 'scroll');
      expect(isInteracting()).toBe(true);
    });

    it('ends for a tap on content, which scrolls nothing', () => {
      const { scroller } = mount();
      measure(W);
      fire(scroller, 'touchstart', 1);
      fire(scroller, 'touchend', 0);
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs);
      });
      expect(isInteracting()).toBe(false);
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('stops listening for the end of a touch still down at unmount', () => {
      const { scroller, getByTestId, unmount } = mount();
      measure(W);
      const row = document.createElement('div');
      getByTestId('page-explore').appendChild(row);
      fire(row, 'touchstart', 1);
      scroller.scrollLeft = W;

      unmount();
      fire(row, 'touchend', 0);
      act(() => {
        jest.advanceTimersByTime(pagerMotion.settleIdleMs * 2);
      });

      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('cancels a slide, ends the gesture and disconnects the observer on unmount', () => {
      const { scroller, rerender, unmount } = mount();
      measure(W);
      route(rerender, '/earn');
      fire(scroller, 'touchstart', 1);
      route(rerender, '/send');
      const slide = lastAnimation();

      unmount();

      expect(slide.cancel).toHaveBeenCalled();
      expect(mockRoDisconnect).toHaveBeenCalled();
      expect(isInteracting()).toBe(false);
    });
  });
});
