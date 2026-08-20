import React from 'react';

import { render, act, fireEvent } from '@testing-library/react';

import HomeSwipeContainer from './HomeSwipeContainer';

// ---------------------------------------------------------------------------
// Mock capture holders. All are `mock`-prefixed so jest's factory-hoisting
// rule permits referencing them from inside `jest.mock` factories. They are
// only *dereferenced* lazily (when the mocked functions are called at
// render/interaction time), never at factory-execution time, so no TDZ issue.
// ---------------------------------------------------------------------------
const mockNavigate = jest.fn();
let mockPathname = '/';
const mockSwapEnabled = { value: true };
const mockReduceMotion = { value: false };

const mockAnimateStop = jest.fn();
const mockAnimate = jest.fn((..._args: unknown[]) => ({ stop: mockAnimateStop }));
// The motion value is stateful here, because the release path reads it back:
// `snapToPage` derives both the release velocity and the committed page from
// `x.get()`, so a `get` pinned to 0 would make every one of those tests agree
// with itself and nothing else.
let mockX = 0;
const mockMotionSet = jest.fn((value: number) => {
  mockX = value;
});
const mockMotionValue = { set: mockMotionSet, get: () => mockX };

const mockDragStart = jest.fn();
const mockDragControls = { start: mockDragStart };
const mockBoostRefreshRate = jest.fn();

// The spring is solved into a `linear()` easing before the release starts. The
// null-below-half-a-pixel rule is the real one's, and matters: it's the branch a
// snap-back-to-the-same-place takes.
const mockSpringToLinearEasing = jest.fn((_transition: unknown, { distance }: { distance: number }) =>
  Math.abs(distance) < 0.5 ? null : { duration: 340, easing: 'linear(0,0.5,1)' }
);

// The single `motion.div` in the component is the draggable track. We stash its
// handlers on each render so tests can drive the gesture directly (framer's real
// drag needs a pointer pipeline jsdom lacks).
let mockLastDragEnd: ((e: unknown, info: unknown) => void) | null = null;
let mockLastDragConstraints: unknown = null;
// #481 — the `drag` prop toggles between 'x' (swipe enabled) and false (locked).
let mockLastDrag: unknown = null;
// The snap is chosen and started inside `modifyTarget`, which framer calls while
// it handles pointer-up — a frame before `onDragEnd`. That ordering is the whole
// point of the release path, so the tests drive it in that order too.
let mockLastModifyTarget: ((ideal: number) => number) | null = null;
let mockLastDragControlsProp: unknown = null;

// framer-motion: `motion.div` -> passthrough div (drag props stripped so React
// doesn't warn/attempt to render them). `animate`/`useMotionValue` are stubbed.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  const passthrough = ReactActual.forwardRef((props: any, ref: React.Ref<HTMLDivElement>) => {
    const {
      children,
      onDragEnd,
      dragConstraints,
      // strip non-DOM / framer-only props
      drag,
      dragDirectionLock,
      dragElastic,
      dragMomentum,
      dragTransition,
      dragControls,
      style,
      ...rest
    } = props;
    if (onDragEnd) mockLastDragEnd = onDragEnd;
    if (dragConstraints !== undefined) mockLastDragConstraints = dragConstraints;
    if (dragTransition) mockLastModifyTarget = dragTransition.modifyTarget;
    if (dragControls !== undefined) mockLastDragControlsProp = dragControls;
    mockLastDrag = drag;
    return ReactActual.createElement('div', { ref, ...rest }, children);
  });
  return {
    __esModule: true,
    motion: new Proxy({}, { get: () => passthrough }),
    animate: (...args: unknown[]) => mockAnimate(...args),
    useMotionValue: () => mockMotionValue,
    useReducedMotion: () => mockReduceMotion.value,
    useDragControls: () => mockDragControls
  };
});

// woozie location/history stack is heavy; expose a controllable pathname and a
// spy navigate.
jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  useLocation: () => ({ pathname: mockPathname })
}));

jest.mock('lib/animation', () => ({
  springs: {
    standard: { type: 'spring', stiffness: 1 },
    dragRelease: { type: 'spring', stiffness: 2, damping: 3 }
  },
  // Reduced motion is asserted through the spring solver instead, which is where
  // the component actually branches on it.
  resolveTransition: (_reduceMotion: boolean, transition: unknown) => transition,
  springToLinearEasing: (...args: [unknown, { distance: number }]) => mockSpringToLinearEasing(...args)
}));

jest.mock('lib/mobile/high-refresh-rate', () => ({
  boostRefreshRate: (...args: unknown[]) => mockBoostRefreshRate(...args)
}));

// Child pages pull in the full wallet/SDK stack — stub each to a marker div.
jest.mock('app/pages/Explore', () => ({
  __esModule: true,
  default: () => <div data-testid="page-explore" />
}));
jest.mock('app/pages/Earn', () => ({
  __esModule: true,
  default: () => <div data-testid="page-earn" />
}));
jest.mock('app/pages/Receive', () => ({
  __esModule: true,
  Receive: () => <div data-testid="page-receive" />
}));
jest.mock('screens/send-flow/SendManager', () => ({
  __esModule: true,
  SendFlow: ({ isLoading }: { isLoading?: boolean }) => <div data-testid="page-send" data-loading={String(isLoading)} />
}));
// The swap pane carries the amount fields whose `<input>` made framer refuse to
// start a drag, so this stub keeps one.
jest.mock('screens/swap-flow/SwapManager', () => ({
  __esModule: true,
  SwapFlow: () => (
    <div data-testid="page-swap">
      <input data-testid="swap-amount-input" />
    </div>
  )
}));

// Swap availability is gated by isSwapEnabled (false on iOS); toggle it to
// assert the pane is added/removed and the track stays in sync.
jest.mock('lib/feature-flags', () => ({
  isSwapEnabled: () => mockSwapEnabled.value
}));

// ---------------------------------------------------------------------------
// ResizeObserver is not implemented in jsdom. Provide a mock that captures the
// observer callback so tests can drive width measurements deterministically.
// ---------------------------------------------------------------------------
let mockRoCallback: ((entries: unknown[]) => void) | null = null;
const mockRoObserve = jest.fn();
const mockRoDisconnect = jest.fn();

class MockResizeObserver {
  constructor(cb: (entries: unknown[]) => void) {
    mockRoCallback = cb;
  }
  observe(...args: unknown[]) {
    mockRoObserve(...args);
  }
  unobserve() {
    /* not used by the component */
  }
  disconnect(...args: unknown[]) {
    mockRoDisconnect(...args);
  }
}

// The release runs on the compositor through the Web Animations API, which jsdom
// has none of. Each animation is captured so tests can assert what the
// compositor was handed, and drive its completion.
interface MockRelease {
  keyframes: unknown;
  options: { duration: number; easing: string; fill: string };
  cancel: jest.Mock;
  onfinish: (() => void) | null;
}
let mockReleases: MockRelease[] = [];

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

  // The landing check defers itself by a frame, so framer's own release path runs
  // first. Run it inline instead of making every test pump a clock.
  (global as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: (t: number) => void) => {
    cb(0);
    return 0;
  };

  (Element.prototype as unknown as { animate: unknown }).animate = function (
    keyframes: unknown,
    options: MockRelease['options']
  ) {
    const release: MockRelease = { keyframes, options, cancel: jest.fn(), onfinish: null };
    mockReleases.push(release);
    return release;
  };

  // Enough of DOMMatrixReadOnly to read back a translateX, which is all the
  // component asks of it — and asking is the point: adopting the *on-screen*
  // position is what stops an interrupted release from jumping.
  (global as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
    m41: number;
    constructor(transform: string) {
      const match = /translateX\((-?[\d.]+)px\)/.exec(transform);
      this.m41 = match ? Number(match[1]) : 0;
    }
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/';
  mockLastDragEnd = null;
  mockLastDragConstraints = null;
  mockLastDrag = null;
  mockLastModifyTarget = null;
  mockLastDragControlsProp = null;
  mockRoCallback = null;
  mockSwapEnabled.value = true;
  mockReduceMotion.value = false;
  mockX = 0;
  mockReleases = [];
  document.body.removeAttribute('data-hide-navbar');
});

afterEach(() => {
  document.body.removeAttribute('data-hide-navbar');
});

// Drive the captured ResizeObserver callback to set a positive width.
function measure(width: number) {
  act(() => {
    mockRoCallback?.([{ contentRect: { width } }]);
  });
}

/**
 * Put the track at rest on a page. The mount effect animates there through the
 * (mocked) `animate`, which never moves the value, so a test starting anywhere
 * but index 0 has to say so.
 */
function settleAt(x: number) {
  mockX = x;
}

/** The release in flight, asserting there is one. */
function releaseInFlight(): MockRelease {
  const animation = mockReleases[mockReleases.length - 1];
  if (!animation) throw new Error('expected a compositor release to have been started');
  return animation;
}

/**
 * Play a release the way framer does: `modifyTarget` with the coasting target it
 * projected from the finger, then `onDragEnd` once the frame ends.
 *
 * Returns what `modifyTarget` handed back, which is framer's own momentum target.
 */
function release(idealX: number): number | undefined {
  let parked: number | undefined;
  act(() => {
    parked = mockLastModifyTarget?.(idealX);
    mockLastDragEnd?.(null, {
      offset: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      point: { x: 0, y: 0 },
      delta: { x: 0, y: 0 }
    });
  });
  return parked;
}

/**
 * jsdom has no PointerEvent, and `fireEvent.pointerDown` silently drops
 * `pointerType` when it falls back to `Event` — which is the one field the
 * handler branches on, so it is set explicitly here.
 */
function pointerDown(node: Element, pointerType: 'touch' | 'mouse'): Event {
  const event = new Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  act(() => {
    fireEvent(node, event);
  });
  return event;
}

function pointerUp(node: Element) {
  act(() => {
    fireEvent(node, new Event('pointerup', { bubbles: true, cancelable: true }));
  });
}

/** A touch that lands and lifts without travelling far enough to drag. */
function tap(node: Element) {
  pointerDown(node, 'touch');
  pointerUp(node);
}

describe('HomeSwipeContainer', () => {
  it('mounts all five home pages in the track', () => {
    const { getByTestId } = render(<HomeSwipeContainer />);
    expect(getByTestId('page-explore')).toBeInTheDocument();
    expect(getByTestId('page-send')).toBeInTheDocument();
    expect(getByTestId('page-receive')).toBeInTheDocument();
    expect(getByTestId('page-earn')).toBeInTheDocument();
    expect(getByTestId('page-swap')).toBeInTheDocument();
  });

  it('passes isLoading={false} to the SendFlow', () => {
    const { getByTestId } = render(<HomeSwipeContainer />);
    expect(getByTestId('page-send')).toHaveAttribute('data-loading', 'false');
  });

  it('drops the Swap pane when swap is disabled, keeping the other four', () => {
    mockSwapEnabled.value = false;
    const { getByTestId, queryByTestId } = render(<HomeSwipeContainer />);
    expect(queryByTestId('page-swap')).toBeNull();
    expect(getByTestId('page-explore')).toBeInTheDocument();
    expect(getByTestId('page-send')).toBeInTheDocument();
    expect(getByTestId('page-receive')).toBeInTheDocument();
    expect(getByTestId('page-earn')).toBeInTheDocument();
    // Track math must derive from the 4-page filtered array — not a hardcoded 5 —
    // so the drag bounds shrink accordingly (a phantom 5th slot would fail here).
    measure(300);
    expect(mockLastDragConstraints).toEqual({ left: -900, right: 0 }); // -(4 - 1) * 300
  });

  it('on mount at width 0 sets the motion value directly instead of animating', () => {
    render(<HomeSwipeContainer />);
    // The animate effect takes the `!width` branch: x.set(...) is called and
    // `animate` is not invoked for the resting position while width is 0.
    expect(mockMotionSet).toHaveBeenCalled();
  });

  it('registers a ResizeObserver on the container', () => {
    render(<HomeSwipeContainer />);
    expect(mockRoObserve).toHaveBeenCalledTimes(1);
    expect(mockRoCallback).toBeInstanceOf(Function);
  });

  describe('activeIdx resolution', () => {
    it('animates to index 0 (offset 0) for the overview path "/"', () => {
      mockPathname = '/';
      render(<HomeSwipeContainer />);
      measure(300);
      expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -0, expect.anything());
    });

    it('animates to the exact page index for a top-level path', () => {
      mockPathname = '/receive'; // index 2
      render(<HomeSwipeContainer />);
      measure(300);
      expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -600, expect.anything());
    });

    it('matches by prefix for nested routes (e.g. /send/sub-step)', () => {
      mockPathname = '/send/amount'; // prefix of /send -> index 1
      render(<HomeSwipeContainer />);
      measure(300);
      expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -300, expect.anything());
    });

    it('falls back to index 0 for an unknown path (no exact, no prefix)', () => {
      mockPathname = '/totally-unknown';
      render(<HomeSwipeContainer />);
      measure(300);
      // -0 * 300 === -0 (index 0). Assert an animate call landed at index 0.
      expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -0, expect.anything());
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('does not treat the root "/" as a prefix match for other paths', () => {
      // '/xyz' starts with '/' but the prefix scan explicitly skips p.path === '/'.
      mockPathname = '/xyz';
      render(<HomeSwipeContainer />);
      measure(300);
      expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -0, expect.anything());
    });
  });

  describe('ResizeObserver callback branches', () => {
    it('ignores measurements of width 0', () => {
      mockPathname = '/send';
      render(<HomeSwipeContainer />);
      mockAnimate.mockClear();
      act(() => {
        mockRoCallback?.([{ contentRect: { width: 0 } }]);
      });
      // width stayed 0 -> the release is a no-op (early return in snapToPage).
      release(-1000);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('handles an empty entries array without setting width', () => {
      render(<HomeSwipeContainer />);
      act(() => {
        mockRoCallback?.([]); // entries[0] undefined -> w = 0
      });
      release(-1000);
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('committing a release', () => {
    // `modifyTarget` receives framer's coasting target, `origin + power * velocity`
    // with power 0.8, and commits when 300ms of that velocity would carry the
    // track past 30% of a page. At width 300 and rest, that is a target beyond
    // -240: velocity -375px/s, projected -112.5px, past the -90px threshold.
    it('advances to the next page when the flick projects past the threshold', () => {
      mockPathname = '/'; // index 0
      render(<HomeSwipeContainer />);
      measure(300);
      release(-300);
      expect(mockNavigate).toHaveBeenCalledWith('/send');
    });

    it('goes to the previous page when flicked the other way', () => {
      mockPathname = '/receive'; // index 2
      render(<HomeSwipeContainer />);
      measure(300);
      settleAt(-600);
      release(-300); // velocity +375 -> projected +112.5
      expect(mockNavigate).toHaveBeenCalledWith('/send');
    });

    it('stays put when the flick is too weak to project past the threshold', () => {
      mockPathname = '/send'; // index 1
      render(<HomeSwipeContainer />);
      measure(300);
      settleAt(-300);
      release(-310); // velocity -12.5 -> projected -3.75
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('cannot advance past the last page', () => {
      mockPathname = '/swap'; // index 4 (last)
      render(<HomeSwipeContainer />);
      measure(300);
      settleAt(-1200);
      release(-1500);
      expect(mockNavigate).not.toHaveBeenCalled();
      // Same page, so the release has nowhere to travel: no compositor animation,
      // and the resting position is restored directly.
      expect(mockReleases).toHaveLength(0);
      expect(mockMotionSet).toHaveBeenCalledWith(-1200);
    });

    it('cannot go before the first page', () => {
      mockPathname = '/'; // index 0 (first)
      render(<HomeSwipeContainer />);
      measure(300);
      release(300);
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockReleases).toHaveLength(0);
    });

    it('parks framer\u2019s own momentum on the spot the finger left', () => {
      mockPathname = '/';
      render(<HomeSwipeContainer />);
      measure(300);
      settleAt(-42);
      // Returning the origin leaves framer's inertia animation nothing to travel,
      // so it cannot fight the compositor for the transform.
      expect(release(-300)).toBe(-42);
    });

    it('is a no-op while width is unmeasured (0)', () => {
      mockPathname = '/';
      render(<HomeSwipeContainer />);
      // Without a width there is no page geometry, so framer's own target is
      // handed straight back.
      expect(release(-1000)).toBe(-1000);
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('the release animation', () => {
    it('hands the compositor a single transform animation from the finger to the page', () => {
      mockPathname = '/';
      render(<HomeSwipeContainer />);
      measure(300);
      settleAt(-120);
      release(-300);

      expect(mockReleases).toHaveLength(1);
      expect(releaseInFlight().keyframes).toEqual([
        { transform: 'translateX(-120px)' },
        { transform: 'translateX(-300px)' }
      ]);
      // `fill: forwards` holds the landing position; without it the transform
      // reverts to framer's stale inline value for a frame.
      expect(releaseInFlight().options).toEqual({ duration: 340, easing: 'linear(0,0.5,1)', fill: 'forwards' });
    });

    it('seeds the spring with the release velocity, so the snap continues the flick', () => {
      mockPathname = '/';
      render(<HomeSwipeContainer />);
      measure(300);
      release(-300);
      expect(mockSpringToLinearEasing).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ distance: 300, velocity: -375 })
      );
    });

    it('asks for the display\u2019s full refresh rate only for the animation\u2019s duration', () => {
      mockPathname = '/';
      render(<HomeSwipeContainer />);
      measure(300);
      release(-300);
      expect(mockBoostRefreshRate).toHaveBeenCalledWith(340);
    });

    it('syncs the motion value to the target once the animation finishes', () => {
      mockPathname = '/';
      render(<HomeSwipeContainer />);
      measure(300);
      release(-300);
      mockMotionSet.mockClear();
      act(() => {
        releaseInFlight().onfinish?.();
      });
      expect(mockMotionSet).toHaveBeenCalledWith(-300);
      // Deliberately not cancelled here: dropping the compositor's hold before
      // framer's next render would show the stale transform for a frame.
      expect(releaseInFlight().cancel).not.toHaveBeenCalled();
    });

    it('jumps straight to the page when reduced motion is on', () => {
      mockReduceMotion.value = true;
      mockPathname = '/';
      render(<HomeSwipeContainer />);
      measure(300);
      release(-300);
      expect(mockReleases).toHaveLength(0);
      expect(mockMotionSet).toHaveBeenCalledWith(-300);
      expect(mockNavigate).toHaveBeenCalledWith('/send');
    });

    it('adopts the on-screen position when a finger interrupts a release', () => {
      mockPathname = '/';
      const { getByTestId } = render(<HomeSwipeContainer />);
      measure(300);
      release(-300);

      // Mid-flight the compositor owns the transform; pretend it has carried the
      // track to -180 while framer still believes the finger's last position.
      const track = getByTestId('page-explore').parentElement?.parentElement as HTMLElement;
      track.style.transform = 'translateX(-180px)';
      mockMotionSet.mockClear();

      pointerDown(getByTestId('page-explore'), 'touch');

      // Read and written before the hold is dropped — the other order leaves one
      // frame of the stale transform, which measured as a 172px backward jump.
      expect(mockMotionSet).toHaveBeenCalledWith(-180);
      expect(releaseInFlight().cancel).toHaveBeenCalled();
    });

    it('lands the track on its page when a tap stops a release', () => {
      mockPathname = '/';
      const { getByTestId, rerender } = render(<HomeSwipeContainer />);
      measure(300);
      release(-300);

      // The route commits the moment the finger lifts, so by now the active page
      // is already the one the release is travelling to.
      mockPathname = '/send';
      act(() => {
        rerender(<HomeSwipeContainer />);
      });
      const track = getByTestId('page-explore').parentElement?.parentElement as HTMLElement;
      track.style.transform = 'translateX(-180px)';
      mockAnimate.mockClear();

      tap(getByTestId('page-explore'));

      // Without this the track stays at -180: framer starts no drag for a tap, and
      // the resting-position effect won't re-run for an index that didn't change,
      // so it sat stranded showing two pages at once.
      expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -300, expect.anything());
    });

    it('does nothing when a tap lands on a track already at rest', () => {
      mockPathname = '/';
      const { getByTestId } = render(<HomeSwipeContainer />);
      measure(300);
      mockAnimate.mockClear();
      tap(getByTestId('page-earn'));
      expect(mockAnimate).not.toHaveBeenCalled();
    });

    it('leaves the landing to the release when the gesture was a drag', () => {
      mockPathname = '/';
      const { getByTestId } = render(<HomeSwipeContainer />);
      measure(300);
      release(-300); // a drag's own release is in flight
      mockAnimate.mockClear();
      pointerUp(getByTestId('page-explore'));
      expect(mockAnimate).not.toHaveBeenCalled();
    });
  });

  describe('dragConstraints', () => {
    it('clamps left to 0 while width is 0', () => {
      render(<HomeSwipeContainer />);
      expect(mockLastDragConstraints).toEqual({ left: 0, right: 0 });
    });

    it('clamps left to -(pages-1)*width once measured', () => {
      render(<HomeSwipeContainer />);
      measure(300);
      // 5 pages -> left edge at -(5 - 1) * 300 = -1200
      expect(mockLastDragConstraints).toEqual({ left: -1200, right: 0 });
    });
  });

  describe('swipe lock (#481)', () => {
    const flush = () => new Promise(res => setTimeout(res, 0));

    it('enables drag by default and locks it while data-hide-navbar is set', async () => {
      render(<HomeSwipeContainer />);
      // Draggable by default (no focused sub-surface up).
      expect(mockLastDrag).toBe('x');

      // A focused sub-surface (keyboard up, or the send flow past the recipient
      // step) raises the flag -> the carousel swipe must lock so it can't drag
      // an adjacent pane over the active step.
      await act(async () => {
        document.body.setAttribute('data-hide-navbar', '');
        await flush();
      });
      expect(mockLastDrag).toBe(false);

      // ...and the swipe returns once that surface closes.
      await act(async () => {
        document.body.removeAttribute('data-hide-navbar');
        await flush();
      });
      expect(mockLastDrag).toBe('x');
    });

    it('starts locked when the flag is already set at mount', () => {
      document.body.setAttribute('data-hide-navbar', '');
      render(<HomeSwipeContainer />);
      expect(mockLastDrag).toBe(false);
    });
  });

  describe('swiping from a text field', () => {
    // framer refuses to start a drag when the gesture lands on a form control, so
    // that dragging inside one selects text. The swap screen's two amount fields
    // are full-width and ~64px tall, which left most of that screen unable to
    // swipe, so touch gestures start the drag here instead.
    it('starts the drag itself for a touch that lands on an input', () => {
      const { getByTestId } = render(<HomeSwipeContainer />);
      pointerDown(getByTestId('swap-amount-input'), 'touch');
      expect(mockDragStart).toHaveBeenCalledTimes(1);
      // Manual starts need framer's controls on the track, or they go nowhere.
      expect(mockLastDragControlsProp).toBe(mockDragControls);
    });

    it('leaves a mouse on an input to framer, so drag-to-select still works', () => {
      const { getByTestId } = render(<HomeSwipeContainer />);
      pointerDown(getByTestId('swap-amount-input'), 'mouse');
      expect(mockDragStart).not.toHaveBeenCalled();
    });

    it('leaves touches on ordinary content to framer\u2019s own listener', () => {
      const { getByTestId } = render(<HomeSwipeContainer />);
      pointerDown(getByTestId('page-earn'), 'touch');
      expect(mockDragStart).not.toHaveBeenCalled();
    });

    it('starts nothing while the swipe is locked (#481)', () => {
      document.body.setAttribute('data-hide-navbar', '');
      const { getByTestId } = render(<HomeSwipeContainer />);
      pointerDown(getByTestId('swap-amount-input'), 'touch');
      expect(mockDragStart).not.toHaveBeenCalled();
    });

    it('does not focus a field tapped mid-transition', () => {
      mockPathname = '/';
      const { getByTestId } = render(<HomeSwipeContainer />);
      measure(300);
      release(-300);
      // The fields are moving at that moment, so which one is under the finger is
      // accidental — and the keyboard would interrupt the transition it stopped.
      expect(pointerDown(getByTestId('swap-amount-input'), 'touch').defaultPrevented).toBe(true);
    });

    it('lets a tap focus a field while nothing is animating', () => {
      const { getByTestId } = render(<HomeSwipeContainer />);
      measure(300);
      expect(pointerDown(getByTestId('swap-amount-input'), 'touch').defaultPrevented).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('disconnects the ResizeObserver and stops the animation on unmount', () => {
      const { unmount } = render(<HomeSwipeContainer />);
      measure(300); // width > 0 so the animate effect returns a stop() cleanup
      unmount();
      expect(mockRoDisconnect).toHaveBeenCalled();
      expect(mockAnimateStop).toHaveBeenCalled();
    });

    it('cancels an in-flight release on unmount', () => {
      mockPathname = '/';
      const { unmount } = render(<HomeSwipeContainer />);
      measure(300);
      release(-300);
      unmount();
      expect(releaseInFlight().cancel).toHaveBeenCalled();
    });
  });
});
