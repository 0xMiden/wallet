import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { hapticError } from 'lib/mobile/haptics';

import { PasscodeDots } from './PasscodeDots';

let mockReduce = false;
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReduce
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticError: jest.fn()
}));

const dots = () => screen.getAllByTestId('passcode-dot');
const filled = () => dots().filter(dot => dot.getAttribute('data-filled') === 'true');

beforeEach(() => {
  mockReduce = false;
  jest.clearAllMocks();
});

describe('PasscodeDots', () => {
  it('draws one dot per digit, hairline while empty and ink once filled', () => {
    render(<PasscodeDots filled={2} length={6} />);

    expect(dots()).toHaveLength(6);
    expect(filled()).toHaveLength(2);
    for (const dot of dots()) expect(dot).toHaveClass('rounded-full', 'bg-hairline');
    for (const dot of filled()) expect(dot.firstElementChild).toHaveClass('bg-ink');
    // An empty dot has no ink fill inside it.
    expect(dots()[2]).toBeEmptyDOMElement();
  });

  it('is hidden from assistive tech (the status line carries the meaning)', () => {
    render(<PasscodeDots filled={0} length={6} />);

    expect(screen.getByTestId('passcode-dots')).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not shake or buzz before any code is rejected', () => {
    render(<PasscodeDots filled={3} length={6} />);

    expect(screen.getByTestId('passcode-dots')).not.toHaveAttribute('data-shake');
    expect(hapticError).not.toHaveBeenCalled();
  });

  it('shakes and fires the error haptic on each rejected code', () => {
    const { rerender } = render(<PasscodeDots filled={0} length={6} errorKey={0} />);

    rerender(<PasscodeDots filled={0} length={6} errorKey={1} />);
    expect(screen.getByTestId('passcode-dots')).toHaveAttribute('data-shake', 'true');
    expect(hapticError).toHaveBeenCalledTimes(1);

    rerender(<PasscodeDots filled={0} length={6} errorKey={2} />);
    expect(hapticError).toHaveBeenCalledTimes(2);
  });

  it('stays still under reduced motion but still fires the error haptic', () => {
    mockReduce = true;
    const { rerender } = render(<PasscodeDots filled={0} length={6} errorKey={0} />);

    rerender(<PasscodeDots filled={0} length={6} errorKey={1} />);
    expect(screen.getByTestId('passcode-dots')).not.toHaveAttribute('data-shake');
    expect(screen.getByTestId('passcode-dots').style.transform).toBe('');
    expect(hapticError).toHaveBeenCalledTimes(1);
  });

  // Asserts the animation itself, not the `data-shake` flag computed beside it: every assertion
  // above reads that flag, and deleting `animate` left all of them green. Framer runs in jsdom, so
  // the row's transform genuinely moves while it shakes.
  it('actually shakes on a rejected code, and again on the next one', async () => {
    mockReduce = false;
    const wait = (ms: number) =>
      act(async () => {
        await new Promise(resolve => setTimeout(resolve, ms));
      });
    const row = () => screen.getByTestId('passcode-dots');
    const { rerender } = render(<PasscodeDots filled={0} length={6} errorKey={0} />);
    expect(row().style.transform).toBe('');

    rerender(<PasscodeDots filled={0} length={6} errorKey={1} />);
    await wait(50);
    expect(row().style.transform).toMatch(/translateX\(-?[1-9]/);

    await wait(900); // let the first shake come to rest
    expect(row().style.transform).toBe('none');

    // The SECOND rejected code must shake too. Framer does nothing when it is handed the same
    // target again, so it is the remount on `key={errorKey}` that replays the shake - without it,
    // only the first wrong code would ever move.
    rerender(<PasscodeDots filled={0} length={6} errorKey={2} />);
    await wait(50);
    expect(row().style.transform).toMatch(/translateX\(-?[1-9]/);
  });
});
