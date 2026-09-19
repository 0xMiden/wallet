import React from 'react';

import { render, screen } from '@testing-library/react';

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
});
