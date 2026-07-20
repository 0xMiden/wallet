import React from 'react';

import { render, act } from '@testing-library/react';

import HomeSwipeContainer from './HomeSwipeContainer';

// ---------------------------------------------------------------------------
// Mock capture holders. All are `mock`-prefixed so jest's factory-hoisting
// rule permits referencing them from inside `jest.mock` factories. They are
// only *dereferenced* lazily (when the mocked functions are called at
// render/interaction time), never at factory-execution time, so no TDZ issue.
// ---------------------------------------------------------------------------
const mockNavigate = jest.fn();
let mockPathname = '/';

const mockAnimateStop = jest.fn();
const mockAnimate = jest.fn(() => ({ stop: mockAnimateStop }));
const mockMotionSet = jest.fn();
const mockMotionValue = { set: mockMotionSet, get: () => 0 };

// The single `motion.div` in the component is the draggable track. We stash
// its `onDragEnd` handler on each render so tests can drive the pan gesture
// directly (framer-motion's real drag needs a pointer pipeline jsdom lacks).
let mockLastDragEnd: ((e: unknown, info: unknown) => void) | null = null;
let mockLastDragConstraints: unknown = null;

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
      style,
      ...rest
    } = props;
    if (onDragEnd) mockLastDragEnd = onDragEnd;
    if (dragConstraints !== undefined) mockLastDragConstraints = dragConstraints;
    return ReactActual.createElement('div', { ref, ...rest }, children);
  });
  return {
    __esModule: true,
    motion: new Proxy({}, { get: () => passthrough }),
    animate: (...args: unknown[]) => mockAnimate(...args),
    useMotionValue: () => mockMotionValue
  };
});

// woozie location/history stack is heavy; expose a controllable pathname and a
// spy navigate.
jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  useLocation: () => ({ pathname: mockPathname })
}));

// The spring config is just an opaque object as far as the (mocked) animate is
// concerned.
jest.mock('lib/animation', () => ({
  springs: { standard: { type: 'spring', stiffness: 1 } }
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
jest.mock('screens/swap-flow/SwapManager', () => ({
  __esModule: true,
  SwapFlow: () => <div data-testid="page-swap" />
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

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/';
  mockLastDragEnd = null;
  mockLastDragConstraints = null;
  mockRoCallback = null;
});

// Drive the captured ResizeObserver callback to set a positive width.
function measure(width: number) {
  act(() => {
    mockRoCallback?.([{ contentRect: { width } }]);
  });
}

// Fire the captured onDragEnd handler with a synthetic PanInfo.
function dragEnd(offsetX: number, velocityX = 0) {
  act(() => {
    mockLastDragEnd?.(null, {
      offset: { x: offsetX, y: 0 },
      velocity: { x: velocityX, y: 0 },
      point: { x: 0, y: 0 },
      delta: { x: 0, y: 0 }
    });
  });
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
      // width stayed 0 -> dragging is a no-op (early return in handleDragEnd).
      dragEnd(-1000);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('handles an empty entries array without setting width', () => {
      render(<HomeSwipeContainer />);
      act(() => {
        mockRoCallback?.([]); // entries[0] undefined -> w = 0
      });
      dragEnd(-1000);
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('handleDragEnd', () => {
    it('is a no-op while width is unmeasured (0)', () => {
      mockPathname = '/';
      render(<HomeSwipeContainer />);
      dragEnd(-1000, -1000);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('advances to the next page when dragged left past the threshold', () => {
      mockPathname = '/'; // index 0
      render(<HomeSwipeContainer />);
      measure(300); // threshold = 0.3 * 300 = 90
      dragEnd(-200); // projected -200 < -90
      expect(mockNavigate).toHaveBeenCalledWith('/send');
    });

    it('uses fling velocity projection to commit even on a short drag', () => {
      mockPathname = '/'; // index 0
      render(<HomeSwipeContainer />);
      measure(300);
      // offset -50 alone is short of -90, but velocity adds -500 * 0.3 = -150.
      dragEnd(-50, -500);
      expect(mockNavigate).toHaveBeenCalledWith('/send');
    });

    it('goes to the previous page when dragged right past the threshold', () => {
      mockPathname = '/receive'; // index 2
      render(<HomeSwipeContainer />);
      measure(300);
      dragEnd(200); // projected 200 > 90, index > 0 -> previous
      expect(mockNavigate).toHaveBeenCalledWith('/send');
    });

    it('cannot advance past the last page', () => {
      mockPathname = '/swap'; // index 4 (last)
      render(<HomeSwipeContainer />);
      measure(300);
      mockAnimate.mockClear();
      dragEnd(-1000); // projected far left but activeIdx === PAGES.length - 1
      expect(mockNavigate).not.toHaveBeenCalled();
      // No index change -> snap back animate to the current resting position.
      expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -1200, expect.anything());
    });

    it('cannot go before the first page', () => {
      mockPathname = '/'; // index 0 (first)
      render(<HomeSwipeContainer />);
      measure(300);
      mockAnimate.mockClear();
      dragEnd(1000); // projected far right but activeIdx === 0
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -0, expect.anything());
    });

    it('snaps back (no navigation) when the drag is below the threshold', () => {
      mockPathname = '/send'; // index 1
      render(<HomeSwipeContainer />);
      measure(300);
      mockAnimate.mockClear();
      dragEnd(-10); // |projected| < 90 -> newIdx === activeIdx
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -300, expect.anything());
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

  describe('cleanup', () => {
    it('disconnects the ResizeObserver and stops the animation on unmount', () => {
      const { unmount } = render(<HomeSwipeContainer />);
      measure(300); // width > 0 so the animate effect returns a stop() cleanup
      unmount();
      expect(mockRoDisconnect).toHaveBeenCalled();
      expect(mockAnimateStop).toHaveBeenCalled();
    });
  });
});
