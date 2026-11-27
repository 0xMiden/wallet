import React from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { hapticSuccess } from 'lib/mobile/haptics';

import { SlideToConfirm } from './SlideToConfirm';

jest.mock('lib/mobile/haptics', () => ({ hapticSuccess: jest.fn() }));

// jsdom has no PointerEvent, so a pointer event would lose its `clientX`. A MouseEvent carries it.
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}
if (typeof window.PointerEvent === 'undefined') {
  Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent });
}

const LABEL = 'Slide to show deposit address';

/** jsdom has no layout: give the track 300px and the knob 48px, so the knob travels 244px. */
function withLayout() {
  const track = screen.getByTestId('slide');
  const knob = screen.getByTestId('slide-knob');
  Object.defineProperty(track, 'clientWidth', { configurable: true, value: 300 });
  Object.defineProperty(knob, 'offsetWidth', { configurable: true, value: 48 });
  return knob;
}

function drag(knob: HTMLElement, distance: number) {
  fireEvent.pointerDown(knob, { clientX: 10, pointerId: 1 });
  fireEvent.pointerMove(knob, { clientX: 10 + distance, pointerId: 1 });
  fireEvent.pointerUp(knob, { clientX: 10 + distance, pointerId: 1 });
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('SlideToConfirm', () => {
  it('names the knob with the label and hides the duplicate text from assistive technology', () => {
    render(<SlideToConfirm label={LABEL} onConfirm={jest.fn()} accent="send" data-testid="slide" />);
    const knob = screen.getByRole('button', { name: LABEL });
    expect(knob).toBeInTheDocument();
    expect(screen.getByText(LABEL)).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('slide')).toHaveClass('bg-accent-send');
    expect(knob.className).toContain('text-[var(--qr-blue)]');
  });

  it.each(['Enter', ' ', 'ArrowRight'])('confirms once from the keyboard with %j', key => {
    const onConfirm = jest.fn();
    render(<SlideToConfirm label={LABEL} onConfirm={onConfirm} data-testid="slide" />);
    const knob = screen.getByTestId('slide-knob');
    fireEvent.keyDown(knob, { key });
    fireEvent.keyDown(knob, { key });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(hapticSuccess).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('slide')).toHaveAttribute('data-done', 'true');
  });

  it('ignores other keys', () => {
    const onConfirm = jest.fn();
    render(<SlideToConfirm label={LABEL} onConfirm={onConfirm} data-testid="slide" />);
    fireEvent.keyDown(screen.getByTestId('slide-knob'), { key: 'ArrowLeft' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms when the knob is dragged past 90% of the track', () => {
    const onConfirm = jest.fn();
    render(<SlideToConfirm label={LABEL} onConfirm={onConfirm} data-testid="slide" />);
    drag(withLayout(), 230);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(hapticSuccess).toHaveBeenCalledTimes(1);
  });

  it('springs back without confirming below 90%', () => {
    const onConfirm = jest.fn();
    render(<SlideToConfirm label={LABEL} onConfirm={onConfirm} data-testid="slide" />);
    drag(withLayout(), 200);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId('slide')).toHaveAttribute('data-done', 'false');
  });

  it('treats a tap as a hint, not a confirmation', () => {
    const onConfirm = jest.fn();
    render(<SlideToConfirm label={LABEL} onConfirm={onConfirm} data-testid="slide" />);
    const knob = withLayout();
    drag(knob, 0);
    fireEvent.click(knob, { detail: 1 });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('ignores a move or a release with no press first', () => {
    const onConfirm = jest.fn();
    render(<SlideToConfirm label={LABEL} onConfirm={onConfirm} data-testid="slide" />);
    const knob = withLayout();
    fireEvent.pointerMove(knob, { clientX: 290 });
    fireEvent.pointerUp(knob, { clientX: 290 });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms an assistive-technology click, which has no pointer detail', () => {
    const onConfirm = jest.fn();
    render(<SlideToConfirm label={LABEL} onConfirm={onConfirm} data-testid="slide" />);
    fireEvent.click(screen.getByTestId('slide-knob'), { detail: 0 });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled', () => {
    const onConfirm = jest.fn();
    render(<SlideToConfirm label={LABEL} onConfirm={onConfirm} disabled data-testid="slide" />);
    const knob = withLayout();
    expect(knob).toBeDisabled();
    expect(screen.getByTestId('slide')).toHaveClass('opacity-40');
    fireEvent.keyDown(knob, { key: 'Enter' });
    drag(knob, 260);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('lets the user slide again after a new reset key', () => {
    const onConfirm = jest.fn();
    const { rerender } = render(
      <SlideToConfirm label={LABEL} onConfirm={onConfirm} resetKey={1} data-testid="slide" />
    );
    fireEvent.keyDown(screen.getByTestId('slide-knob'), { key: 'Enter' });
    rerender(<SlideToConfirm label={LABEL} onConfirm={onConfirm} resetKey={2} data-testid="slide" />);
    expect(screen.getByTestId('slide')).toHaveAttribute('data-done', 'false');
    fireEvent.keyDown(screen.getByTestId('slide-knob'), { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});
