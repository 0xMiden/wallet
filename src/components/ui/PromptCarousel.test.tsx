import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { hapticSelection } from 'lib/mobile/haptics';

import { PromptCarousel } from './PromptCarousel';

// ---------------------------------------------------------------------------
// Mock capture holders. All `mock`-prefixed so jest's factory-hoisting rule
// permits referencing them from inside the `jest.mock` factory below. They are
// only dereferenced lazily (when the mocked fns are invoked at render/gesture
// time), never at factory-eval time, so there is no TDZ issue.
// ---------------------------------------------------------------------------
const mockAnimateStop = jest.fn();
const mockAnimate = jest.fn(() => ({ stop: mockAnimateStop }));
const mockMotionSet = jest.fn();
const mockMotionValue = { set: mockMotionSet, get: () => 0 };

// The single draggable `motion.div` is the track. We stash the latest render's
// `onDragEnd` handler and `dragConstraints` so tests can drive the pan gesture
// directly (framer-motion's real drag needs a pointer pipeline jsdom lacks).
let mockLastDragEnd: ((e: unknown, info: unknown) => void) | null = null;
let mockLastDragConstraints: unknown = null;

// framer-motion: `motion.div` -> passthrough div (framer-only drag/style props
// stripped so React doesn't warn). `animate`/`useMotionValue` are stubbed.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  const passthrough = ReactActual.forwardRef((props: any, ref: React.Ref<HTMLDivElement>) => {
    const {
      children,
      onDragEnd,
      dragConstraints,
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

// The spring config is an opaque object as far as the (mocked) `animate` cares.
jest.mock('lib/animation', () => ({
  springs: { standard: { type: 'spring', stiffness: 322 } }
}));

// Native haptics — spy so we can assert the selection buzz fires on paging.
jest.mock('lib/mobile/haptics', () => ({
  hapticSelection: jest.fn()
}));

const mockHapticSelection = hapticSelection as jest.MockedFunction<typeof hapticSelection>;

// ---------------------------------------------------------------------------
// Controllable ResizeObserver. jsdom ships none and the component constructs
// one unguarded, so 2+ slide renders require a global stub. We record the
// callback + observed element so tests can push a contentRect width through it.
// ---------------------------------------------------------------------------
type ROEntryList = Array<{ contentRect: { width: number } }>;
let roCallback: ((entries: ROEntryList) => void) | null = null;
const roObserve = jest.fn();
const roDisconnect = jest.fn();

class MockResizeObserver {
  constructor(cb: (entries: ROEntryList) => void) {
    roCallback = cb;
  }
  observe = roObserve;
  unobserve = jest.fn();
  disconnect = roDisconnect;
}

// Drive a resize through the captured RO callback, wrapped in act() so the
// resulting setWidth commit is flushed before assertions run.
const emitResize = (width: number) => {
  act(() => {
    roCallback?.([{ contentRect: { width } }]);
  });
};

const originalRO = (global as any).ResizeObserver;

beforeEach(() => {
  jest.clearAllMocks();
  roCallback = null;
  mockLastDragEnd = null;
  mockLastDragConstraints = null;
  (global as any).ResizeObserver = MockResizeObserver;
});

afterEach(() => {
  (global as any).ResizeObserver = originalRO;
});

const slide = (id: string) => (
  <div key={id} data-testid={`slide-${id}`}>
    {id}
  </div>
);

const getDot = (n: number, total: number) => screen.getByRole('button', { name: `Show prompt ${n} of ${total}` });

describe('PromptCarousel — collapse behaviour', () => {
  it('renders nothing when there are no visible slides', () => {
    const { container } = render(<PromptCarousel>{false}</PromptCarousel>);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when every child is falsy', () => {
    const { container } = render(
      <PromptCarousel>
        {null}
        {false}
        {undefined}
      </PromptCarousel>
    );
    expect(container.firstChild).toBeNull();
    // No carousel chrome (dots) either.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a single slide bare (no track, no dots) and applies className', () => {
    const { container } = render(
      <PromptCarousel className="my-class">
        {slide('only')}
        {null}
      </PromptCarousel>
    );

    expect(screen.getByTestId('slide-only')).toBeTruthy();
    // No dot indicators for a lone slide.
    expect(screen.queryByRole('button')).toBeNull();
    // The wrapper is the bare `<div className={className}>` branch.
    expect(container.firstChild).toHaveClass('my-class');
    expect(container.firstChild).not.toHaveClass('flex');
  });

  it('renders the full carousel with a dot per slide once there are 2+', () => {
    const { container } = render(
      <PromptCarousel className="extra">
        {slide('a')}
        {false}
        {slide('b')}
        {slide('c')}
      </PromptCarousel>
    );

    // 3 truthy slides survive the Boolean filter.
    expect(screen.getByTestId('slide-a')).toBeTruthy();
    expect(screen.getByTestId('slide-b')).toBeTruthy();
    expect(screen.getByTestId('slide-c')).toBeTruthy();

    const dots = screen.getAllByRole('button');
    expect(dots).toHaveLength(3);
    expect(getDot(1, 3)).toHaveClass('w-4', 'bg-accent-primary');
    expect(getDot(2, 3)).toHaveClass('w-1.5', 'bg-gray-50');

    // Outer wrapper merges the base layout classes with the caller className.
    expect(container.firstChild).toHaveClass('flex', 'flex-col', 'gap-2', 'extra');
  });
});

describe('PromptCarousel — width plumbing', () => {
  it('sets x to 0 via the motion value while width is unknown (0)', () => {
    render(
      <PromptCarousel>
        {slide('a')}
        {slide('b')}
      </PromptCarousel>
    );

    // useLayoutEffect reads clientWidth (0 in jsdom) → width stays 0, so the
    // width effect takes the `!width` branch and drives x directly.
    expect(mockMotionSet).toHaveBeenCalledWith(-0);
    // Track constraints collapse to a no-op while width is 0.
    expect(mockLastDragConstraints).toEqual({ left: 0, right: 0 });
    // No spring animation runs until a real width arrives.
    expect(mockAnimate).not.toHaveBeenCalled();
  });

  it('animates to the active offset once the ResizeObserver reports a width', () => {
    render(
      <PromptCarousel>
        {slide('a')}
        {slide('b')}
        {slide('c')}
      </PromptCarousel>
    );

    expect(roObserve).toHaveBeenCalledTimes(1);

    emitResize(300);

    // width>0 branch: spring-animate x to -activeIndex(0) * width.
    expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -0, { type: 'spring', stiffness: 322 });
    // Constraints now span the full track: -(n-1)*width .. 0.
    expect(mockLastDragConstraints).toEqual({ left: -600, right: 0 });
  });

  it('ignores resize entries with no width and empty entry lists', () => {
    render(
      <PromptCarousel>
        {slide('a')}
        {slide('b')}
      </PromptCarousel>
    );

    mockAnimate.mockClear();
    emitResize(0); // width 0 → guarded out, no state change
    act(() => {
      roCallback?.([]); // entries[0] undefined → `?? 0` fallback, no state change
    });

    expect(mockAnimate).not.toHaveBeenCalled();
  });

  it('disconnects the ResizeObserver on unmount', () => {
    const { unmount } = render(
      <PromptCarousel>
        {slide('a')}
        {slide('b')}
      </PromptCarousel>
    );
    unmount();
    expect(roDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe('PromptCarousel — dot navigation', () => {
  it('pages to a tapped dot, buzzing once and moving the active indicator', () => {
    render(
      <PromptCarousel>
        {slide('a')}
        {slide('b')}
        {slide('c')}
      </PromptCarousel>
    );
    emitResize(300);
    mockAnimate.mockClear();

    fireEvent.click(getDot(3, 3));

    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
    expect(getDot(3, 3)).toHaveClass('w-4', 'bg-accent-primary');
    expect(getDot(1, 3)).toHaveClass('w-1.5', 'bg-gray-50');
    // Active index changed → width effect re-runs → animate to -2*300.
    expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -600, { type: 'spring', stiffness: 322 });
  });

  it('is a no-op when tapping the already-active dot', () => {
    render(
      <PromptCarousel>
        {slide('a')}
        {slide('b')}
      </PromptCarousel>
    );
    emitResize(300);

    fireEvent.click(getDot(1, 2)); // dot 0 is already active

    expect(mockHapticSelection).not.toHaveBeenCalled();
    expect(getDot(1, 2)).toHaveClass('w-4');
  });
});

describe('PromptCarousel — drag paging', () => {
  const renderThree = () => {
    render(
      <PromptCarousel>
        {slide('a')}
        {slide('b')}
        {slide('c')}
      </PromptCarousel>
    );
  };

  const drag = (offsetX: number, velocityX = 0) => {
    act(() => {
      mockLastDragEnd?.(null, { offset: { x: offsetX }, velocity: { x: velocityX } });
    });
  };

  it('returns early on drag end while width is still 0', () => {
    renderThree();
    // No resize emitted → width 0.
    mockAnimate.mockClear();
    drag(-500);
    expect(mockHapticSelection).not.toHaveBeenCalled();
    expect(mockAnimate).not.toHaveBeenCalled();
    // Still on the first slide.
    expect(getDot(1, 3)).toHaveClass('w-4');
  });

  it('advances a slide when the projected drag clears the commit threshold', () => {
    renderThree();
    emitResize(300);
    mockAnimate.mockClear();

    // projected = -200 + (-100 * 0.3) = -230 < -(300 * 0.3) = -90 → advance.
    drag(-200, -100);

    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
    expect(getDot(2, 3)).toHaveClass('w-4');
  });

  it('does not advance past the last slide, snapping back instead', () => {
    renderThree();
    emitResize(300);
    // Jump to the last slide via a dot.
    fireEvent.click(getDot(3, 3));
    mockHapticSelection.mockClear();
    mockAnimate.mockClear();

    // Forward drag while already at the end: first predicate true but
    // `activeIndex < slides.length - 1` false → no page, spring rebound.
    drag(-500);

    expect(mockHapticSelection).not.toHaveBeenCalled();
    expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -600, { type: 'spring', stiffness: 322 });
    expect(getDot(3, 3)).toHaveClass('w-4');
  });

  it('pages back when dragged the other way past the threshold', () => {
    renderThree();
    emitResize(300);
    fireEvent.click(getDot(2, 3)); // move to index 1
    mockHapticSelection.mockClear();

    // projected = +200 > +90 and activeIndex(1) > 0 → page back to index 0.
    drag(200);

    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
    expect(getDot(1, 3)).toHaveClass('w-4');
  });

  it('does not page before the first slide, snapping back instead', () => {
    renderThree();
    emitResize(300);
    mockAnimate.mockClear();

    // Backward drag at index 0: second predicate `activeIndex > 0` false.
    drag(200);

    expect(mockHapticSelection).not.toHaveBeenCalled();
    expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -0, { type: 'spring', stiffness: 322 });
    expect(getDot(1, 3)).toHaveClass('w-4');
  });

  it('snaps back on a small drag that stays under the threshold', () => {
    renderThree();
    emitResize(300);
    mockAnimate.mockClear();

    // projected = -10, |·| < 90 → neither predicate → rebound, no page.
    drag(-10);

    expect(mockHapticSelection).not.toHaveBeenCalled();
    expect(mockAnimate).toHaveBeenCalledWith(mockMotionValue, -0, { type: 'spring', stiffness: 322 });
    expect(getDot(1, 3)).toHaveClass('w-4');
  });
});

describe('PromptCarousel — clamp when slides shrink', () => {
  it('re-clamps the active index when the slide count drops below it', () => {
    const { rerender } = render(
      <PromptCarousel>
        {slide('a')}
        {slide('b')}
        {slide('c')}
      </PromptCarousel>
    );
    emitResize(300);

    // Land on the last slide (index 2).
    fireEvent.click(getDot(3, 3));
    expect(getDot(3, 3)).toHaveClass('w-4');

    // Now the third prompt disappears — only 2 slides remain. The stored index
    // (2) exceeds slides.length-1 (1), so the clamp effect resets it to 1.
    rerender(
      <PromptCarousel>
        {slide('a')}
        {slide('b')}
      </PromptCarousel>
    );

    const dots = screen.getAllByRole('button');
    expect(dots).toHaveLength(2);
    // activeIndex clamped to the new last slide.
    expect(getDot(2, 2)).toHaveClass('w-4', 'bg-accent-primary');
    expect(getDot(1, 2)).toHaveClass('w-1.5');
  });
});
