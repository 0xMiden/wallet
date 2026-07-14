import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { PromptCarousel } from './PromptCarousel';

jest.mock('framer-motion', () => {
  const React = jest.requireActual('react');
  return {
    animate: jest.fn(() => ({ stop: jest.fn() })),
    useMotionValue: () => ({ set: jest.fn() }),
    motion: {
      div: React.forwardRef(
        (
          {
            children,
            drag: _drag,
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

  beforeEach(() => jest.useFakeTimers());
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
});
