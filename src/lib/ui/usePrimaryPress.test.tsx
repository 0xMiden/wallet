import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { usePrimaryPress } from './usePrimaryPress';

const Harness: React.FC = () => {
  const { pressed, release, handlers } = usePrimaryPress();
  return (
    <>
      <button type="button" data-testid="target" data-pressed={pressed || undefined} {...handlers} />
      <button type="button" data-testid="release" onClick={release} />
    </>
  );
};

// jsdom has no PointerEvent, so a MouseEvent carries the fields React reads; React builds its leave
// event from `pointerout`, so that is what a leave is dispatched as.
const dispatch = (type: string, init: MouseEventInit, isPrimary?: boolean) => {
  const event = new MouseEvent(type, { bubbles: true, ...init });
  if (isPrimary !== undefined) Object.defineProperty(event, 'isPrimary', { value: isPrimary });
  act(() => {
    screen.getByTestId('target').dispatchEvent(event);
  });
};
const pressed = () => screen.getByTestId('target').hasAttribute('data-pressed');

describe('usePrimaryPress', () => {
  it('starts on the primary pointer only: not a right click, not a second finger', () => {
    render(<Harness />);

    dispatch('pointerdown', { button: 2 });
    expect(pressed()).toBe(false);
    dispatch('pointerdown', { button: 0 }, false);
    expect(pressed()).toBe(false);
    dispatch('pointerdown', { button: 0 }, true);
    expect(pressed()).toBe(true);
  });

  it.each([
    ['up', 'pointerup'],
    ['cancel', 'pointercancel'],
    ['leave', 'pointerout']
  ])('keeps a primary press when another pointer ends (%s)', (_name, type) => {
    render(<Harness />);
    dispatch('pointerdown', { button: 0 }, true);

    dispatch(type, { button: 0 }, false);
    expect(pressed()).toBe(true);

    dispatch(type, { button: 0 }, true);
    expect(pressed()).toBe(false);
  });

  it("ends on the primary pointer's release whatever its button, as a chorded mouse release does", () => {
    render(<Harness />);
    dispatch('pointerdown', { button: 0 }, true);

    dispatch('pointerup', { button: 2 }, true);
    expect(pressed()).toBe(false);
  });

  it('lets the host end a press itself (a blur, the page going off screen)', () => {
    render(<Harness />);
    dispatch('pointerdown', { button: 0 }, true);

    fireEvent.click(screen.getByTestId('release'));
    expect(pressed()).toBe(false);
  });
});
