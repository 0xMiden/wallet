import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { animate } from 'framer-motion';

import { PromptCarousel } from './PromptCarousel';

// One motion value per test, so where the track is placed can be read back. It keeps
// MotionValue's rule for a running animation: starting one replaces it, jump() and stop()
// end it, set() leaves it running, and stopping an animation already replaced ends nothing.
const mockTrackX = {
  running: null as object | null,
  set: jest.fn(),
  jump: jest.fn(() => {
    mockTrackX.running = null;
  }),
  stop: jest.fn(() => {
    mockTrackX.running = null;
  })
};

jest.mock('framer-motion', () => {
  const React = jest.requireActual('react');
  return {
    animate: jest.fn(() => {
      const animation = {};
      mockTrackX.running = animation;
      return {
        stop: jest.fn(() => {
          if (mockTrackX.running === animation) mockTrackX.running = null;
        })
      };
    }),
    useMotionValue: () => mockTrackX,
    motion: {
      div: React.forwardRef(
        (
          {
            children,
            drag,
            dragDirectionLock: _dragDirectionLock,
            dragConstraints: _dragConstraints,
            dragElastic: _dragElastic,
            dragMomentum: _dragMomentum,
            onDragStart,
            onDragEnd,
            ...props
          }: any,
          ref: React.Ref<HTMLDivElement>
        ) => (
          <div
            ref={ref}
            data-testid="motion-track"
            data-drag={String(drag)}
            onMouseDown={() => onDragStart?.()}
            onMouseUp={event => onDragEnd?.(event, { offset: { x: -100, y: 0 }, velocity: { x: 0, y: 0 } })}
            {...props}
          >
            {children}
          </div>
        )
      )
    }
  };
});

// Each placement check looks only at what the step under test did: the mount places
// the track too, and a stale call would satisfy a last-call check.
const clearTrackCalls = () => {
  mockTrackX.set.mockClear();
  mockTrackX.jump.mockClear();
  jest.mocked(animate).mockClear();
};

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

describe('PromptCarousel', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: MockResizeObserver,
      configurable: true
    });
  });

  beforeEach(() => {
    jest.useFakeTimers();
    mockTrackX.running = null;
    clearTrackCalls();
    mockTrackX.stop.mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it('suppresses a card click emitted immediately after a drag', () => {
    const onClick = jest.fn();
    render(
      <PromptCarousel>
        <button type="button" onClick={onClick}>
          First prompt
        </button>
        <button type="button">Second prompt</button>
      </PromptCarousel>
    );

    const track = screen.getByTestId('motion-track');
    fireEvent.mouseDown(track);
    fireEvent.mouseUp(track);
    fireEvent.click(screen.getByRole('button', { name: 'First prompt' }));
    expect(onClick).not.toHaveBeenCalled();

    act(() => jest.runOnlyPendingTimers());
    fireEvent.click(screen.getByRole('button', { name: 'First prompt' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('claims pointer gestures before they reach an outer page carousel', () => {
    const outerPointerDown = jest.fn();
    render(
      <div data-testid="outer-carousel">
        <PromptCarousel>
          <button type="button">First prompt</button>
          <button type="button">Second prompt</button>
        </PromptCarousel>
      </div>
    );
    const outer = screen.getByTestId('outer-carousel');
    outer.addEventListener('pointerdown', outerPointerDown);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'First prompt' }));

    expect(outerPointerDown).not.toHaveBeenCalled();
  });

  it('does not make a lone slide a drag surface, and pages once a second slide arrives', () => {
    const { rerender } = render(
      <PromptCarousel>
        <button type="button">First prompt</button>
      </PromptCarousel>
    );
    const track = screen.getByTestId('motion-track');
    expect(track).toHaveAttribute('data-drag', 'false');
    expect(track.parentElement).not.toHaveClass('touch-pan-y');

    rerender(
      <PromptCarousel>
        <button type="button">First prompt</button>
        <button type="button">Second prompt</button>
      </PromptCarousel>
    );

    expect(screen.getByTestId('motion-track')).toHaveAttribute('data-drag', 'x');
    expect(screen.getByTestId('motion-track').parentElement).toHaveClass('touch-pan-y');
  });

  it('wires up the gesture claim when the track mounts after an empty render', () => {
    const outerPointerDown = jest.fn();
    const { rerender } = render(
      <div data-testid="outer-carousel">
        <PromptCarousel>{false}</PromptCarousel>
      </div>
    );
    expect(screen.queryByTestId('motion-track')).toBeNull();

    rerender(
      <div data-testid="outer-carousel">
        <PromptCarousel>
          <button type="button">First prompt</button>
          <button type="button">Second prompt</button>
        </PromptCarousel>
      </div>
    );
    screen.getByTestId('outer-carousel').addEventListener('pointerdown', outerPointerDown);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Second prompt' }));

    expect(outerPointerDown).not.toHaveBeenCalled();
  });

  it('keeps the selected slide on screen when a sibling before it is removed or added', () => {
    const widthSpy = jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    try {
      const slides = (keys: string[]) =>
        keys.map(key => (
          <button key={key} type="button">
            {key}
          </button>
        ));
      const { rerender } = render(<PromptCarousel>{slides(['first', 'second'])}</PromptCarousel>);
      // The user pages to the second slide: that move is animated.
      fireEvent.click(screen.getByRole('button', { name: 'Show prompt 2 of 2' }));
      expect(animate).toHaveBeenLastCalledWith(mockTrackX, -312, expect.anything());

      // The first slide goes away: the selected slide is now first, placed there at once.
      clearTrackCalls();
      rerender(<PromptCarousel>{slides(['second'])}</PromptCarousel>);
      expect(mockTrackX.jump).toHaveBeenLastCalledWith(-0);
      expect(animate).not.toHaveBeenCalled();

      // It comes back before it: the selection stays on the same slide, now second again.
      clearTrackCalls();
      rerender(<PromptCarousel>{slides(['first', 'second'])}</PromptCarousel>);
      expect(mockTrackX.jump).toHaveBeenLastCalledWith(-312);
      expect(animate).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Show prompt 2 of 2' })).toHaveClass('w-4');
    } finally {
      widthSpy.mockRestore();
    }
  });

  it('ends a snap-back still running when the slide list changes, so it cannot pull the track away', () => {
    const widthSpy = jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    try {
      const slides = (keys: string[]) =>
        keys.map(key => (
          <button key={key} type="button">
            {key}
          </button>
        ));
      const { rerender } = render(<PromptCarousel>{slides(['first', 'second'])}</PromptCarousel>);
      fireEvent.click(screen.getByRole('button', { name: 'Show prompt 2 of 2' }));

      // A pull past the last slide springs the track back to it.
      clearTrackCalls();
      const track = screen.getByTestId('motion-track');
      fireEvent.mouseDown(track);
      fireEvent.mouseUp(track);
      expect(animate).toHaveBeenCalledTimes(1);
      expect(animate).toHaveBeenCalledWith(mockTrackX, -312, expect.anything());
      expect(mockTrackX.running).not.toBeNull();

      // The first slide goes while that spring runs: the track is placed on the one slide
      // left, and nothing is still moving it back toward the old offset.
      clearTrackCalls();
      rerender(<PromptCarousel>{slides(['second'])}</PromptCarousel>);
      expect(mockTrackX.jump).toHaveBeenLastCalledWith(-0);
      expect(mockTrackX.running).toBeNull();
    } finally {
      widthSpy.mockRestore();
    }
  });

  it('places the track again when the other slide goes during a drag, since paging is then off', () => {
    const widthSpy = jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    try {
      const slides = (keys: string[]) =>
        keys.map(key => (
          <button key={key} type="button">
            {key}
          </button>
        ));
      const { rerender } = render(<PromptCarousel>{slides(['first', 'second'])}</PromptCarousel>);
      // A drag on the first slide is under way when the trailing slide goes: the selection
      // stays on the first slide, but drag turns off with the track wherever the drag left it.
      fireEvent.mouseDown(screen.getByTestId('motion-track'));

      clearTrackCalls();
      rerender(<PromptCarousel>{slides(['first'])}</PromptCarousel>);

      expect(screen.getByTestId('motion-track')).toHaveAttribute('data-drag', 'false');
      expect(mockTrackX.jump).toHaveBeenLastCalledWith(-0);
    } finally {
      widthSpy.mockRestore();
    }
  });

  it('draws the active dot in the accent and the rest on the hairline, visible on the page', () => {
    render(
      <PromptCarousel>
        {['first', 'second', 'third'].map(key => (
          <button key={key} type="button">
            {key}
          </button>
        ))}
      </PromptCarousel>
    );

    expect(screen.getByRole('button', { name: 'Show prompt 1 of 3' })).toHaveClass('bg-accent-primary');
    for (const n of [2, 3]) {
      const dot = screen.getByRole('button', { name: `Show prompt ${n} of 3` });
      // `hairline`, not `fill`: fill on the page behind the outlined cards all but vanishes in the light theme.
      expect(dot).toHaveClass('bg-hairline');
      expect(dot).not.toHaveClass('bg-fill');
    }
  });

  it('keeps a focused dot on its own slide when a slide before it goes', () => {
    const slides = (keys: string[]) =>
      keys.map(key => (
        <button key={key} type="button">
          {key}
        </button>
      ));
    const { rerender } = render(<PromptCarousel>{slides(['first', 'second', 'third'])}</PromptCarousel>);
    const dot = screen.getByRole('button', { name: 'Show prompt 2 of 3' });
    dot.focus();

    rerender(<PromptCarousel>{slides(['second', 'third'])}</PromptCarousel>);

    // Still the second slide's dot, not a button repurposed for the third slide.
    expect(document.activeElement).toBe(dot);
    expect(dot).toHaveAccessibleName('Show prompt 1 of 2');
  });

  describe('which slide is on stage', () => {
    const slides = (keys: string[]) =>
      keys.map(key => (
        <button key={key} type="button">
          {key}
        </button>
      ));
    let widthSpy: jest.SpyInstance;
    beforeEach(() => {
      widthSpy = jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    });
    afterEach(() => widthSpy.mockRestore());

    it('shows a prompt that arrives ahead of the first slide of an untouched carousel', () => {
      const { rerender } = render(<PromptCarousel>{slides(['second', 'third'])}</PromptCarousel>);

      // Prompts come in priority order: one that arrives first (pending notes) takes the stage,
      // and the track, already on the first slide, does not move.
      clearTrackCalls();
      rerender(<PromptCarousel>{slides(['first', 'second', 'third'])}</PromptCarousel>);

      expect(screen.getByRole('button', { name: 'Show prompt 1 of 3' })).toHaveClass('w-4');
      expect(mockTrackX.jump).not.toHaveBeenCalled();
      expect(animate).not.toHaveBeenCalled();
    });

    it('keeps a focused slide on stage when a prompt arrives ahead, and lets the prompt take it once focus leaves', () => {
      const { rerender } = render(
        <>
          <PromptCarousel>{slides(['first', 'second'])}</PromptCarousel>
          <button type="button">outside</button>
        </>
      );
      act(() => {
        screen.getByRole('button', { name: 'first' }).focus();
      });
      expect(animate).not.toHaveBeenCalled();

      clearTrackCalls();
      rerender(
        <>
          <PromptCarousel>{slides(['zeroth', 'first', 'second'])}</PromptCarousel>
          <button type="button">outside</button>
        </>
      );
      expect(screen.getByRole('button', { name: 'Show prompt 2 of 3' })).toHaveClass('w-4');
      expect(mockTrackX.jump).toHaveBeenLastCalledWith(-312);

      // Focus leaves the carousel: the choice went with it, and the first prompt takes the stage.
      act(() => {
        screen.getByRole('button', { name: 'outside' }).focus();
      });
      expect(screen.getByRole('button', { name: 'Show prompt 1 of 3' })).toHaveClass('w-4');
    });

    it('never keeps a scroll offset on the viewport, so only the track moves the slides', () => {
      render(<PromptCarousel>{slides(['first', 'second', 'third'])}</PromptCarousel>);
      const viewport = screen.getByTestId('motion-track').parentElement!;
      let scrollLeft = 0;
      Object.defineProperty(viewport, 'scrollLeft', {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => {
          scrollLeft = value;
        }
      });

      // A browser scrolls an overflow-hidden viewport to reveal a focused control in a hidden
      // slide; with the track then moved to that slide, the offsets would add up.
      scrollLeft = 312;
      fireEvent.scroll(viewport);

      expect(scrollLeft).toBe(0);
    });

    it('returns to the first slide when the slide the user chose goes', () => {
      const { rerender } = render(<PromptCarousel>{slides(['first', 'second', 'third'])}</PromptCarousel>);
      fireEvent.click(screen.getByRole('button', { name: 'Show prompt 2 of 3' }));

      rerender(<PromptCarousel>{slides(['first', 'third'])}</PromptCarousel>);
      expect(screen.getByRole('button', { name: 'Show prompt 1 of 2' })).toHaveClass('w-4');

      // The choice went with it: the slide coming back later does not take the stage again.
      rerender(<PromptCarousel>{slides(['first', 'second', 'third'])}</PromptCarousel>);
      expect(screen.getByRole('button', { name: 'Show prompt 1 of 3' })).toHaveClass('w-4');
    });

    it('brings a slide the user moves focus into on stage, and keeps it there when a prompt arrives ahead', () => {
      const { rerender } = render(<PromptCarousel>{slides(['first', 'second'])}</PromptCarousel>);

      act(() => {
        screen.getByRole('button', { name: 'second' }).focus();
      });
      expect(animate).toHaveBeenLastCalledWith(mockTrackX, -312, expect.anything());
      expect(screen.getByRole('button', { name: 'Show prompt 2 of 2' })).toHaveClass('w-4');

      rerender(<PromptCarousel>{slides(['zeroth', 'first', 'second'])}</PromptCarousel>);
      expect(screen.getByRole('button', { name: 'Show prompt 3 of 3' })).toHaveClass('w-4');
    });
  });

  it('claims pointer gestures only once there is a second slide to page to', () => {
    const outerPointerDown = jest.fn();
    const { rerender } = render(
      <div data-testid="outer-carousel">
        <PromptCarousel>
          <button type="button">First prompt</button>
        </PromptCarousel>
      </div>
    );
    const outer = screen.getByTestId('outer-carousel');
    outer.addEventListener('pointerdown', outerPointerDown);
    // One slide has nothing to page: no dots, and a swipe on it still reaches the page.
    expect(screen.queryByRole('button', { name: /Show prompt/ })).toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'First prompt' }));
    expect(outerPointerDown).toHaveBeenCalledTimes(1);

    rerender(
      <div data-testid="outer-carousel">
        <PromptCarousel>
          <button type="button">First prompt</button>
          <button type="button">Second prompt</button>
        </PromptCarousel>
      </div>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Second prompt' }));

    expect(screen.getAllByRole('button', { name: /Show prompt/ })).toHaveLength(2);
    expect(outerPointerDown).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a sibling before it is removed', ['first', 'second'], ['second']],
    ['a sibling is added before it', ['second'], ['first', 'second']]
  ])('keeps a slide and its focus when %s', (_change, before, after) => {
    const slides = (keys: string[]) =>
      keys.map(key => (
        <button key={key} type="button">
          {key}
        </button>
      ));
    const { rerender } = render(<PromptCarousel>{slides(before)}</PromptCarousel>);
    const second = screen.getByRole('button', { name: 'second' });
    second.focus();

    rerender(<PromptCarousel>{slides(after)}</PromptCarousel>);

    // A remount would drop focus to the page: a card that swaps its own content in the
    // same render (the Funding hero hides the pending-notes card) loses the user's place.
    expect(screen.getByRole('button', { name: 'second' })).toBe(second);
    expect(document.activeElement).toBe(second);
  });
});
