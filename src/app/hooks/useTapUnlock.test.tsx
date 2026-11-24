import React from 'react';

import { createEvent, fireEvent, render, screen } from '@testing-library/react';

import { UNLOCK_TAP_WINDOW_MS, UNLOCK_TAPS, useTapUnlock } from './useTapUnlock';

const mockHapticLight = jest.fn();
const mockHapticMedium = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: () => mockHapticLight(),
  hapticMedium: () => mockHapticMedium()
}));

const Target = ({ onUnlock }: { onUnlock: () => void }) => {
  const onTap = useTapUnlock(onUnlock);
  return (
    <span data-testid="target" onClick={onTap}>
      target
    </span>
  );
};

// The count reads the event's own time stamp; React falls back to Date.now() for a zero one.
const tapAt = (timeStamp: number) => {
  const target = screen.getByTestId('target');
  const event = createEvent.click(target);
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  fireEvent(target, event);
};

// Taps from `start`, each `gap` ms after the one before.
const tapTimes = (times: number, start: number, gap: number) => {
  for (let i = 0; i < times; i++) tapAt(start + i * gap);
};

describe('useTapUnlock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('unlocks on the seventh tap, each within two seconds of the one before', () => {
    const onUnlock = jest.fn();
    render(<Target onUnlock={onUnlock} />);
    tapTimes(UNLOCK_TAPS, 10_000, UNLOCK_TAP_WINDOW_MS);
    expect(onUnlock).toHaveBeenCalledTimes(1);
    expect(mockHapticMedium).toHaveBeenCalledTimes(1);
    // Taps four to six say the count is running.
    expect(mockHapticLight).toHaveBeenCalledTimes(3);
  });

  it('does not unlock on six taps', () => {
    const onUnlock = jest.fn();
    render(<Target onUnlock={onUnlock} />);
    tapTimes(6, 10_000, 300);
    expect(onUnlock).not.toHaveBeenCalled();
    expect(mockHapticMedium).not.toHaveBeenCalled();
  });

  it('starts the count again when the seventh tap comes more than two seconds after the sixth', () => {
    const onUnlock = jest.fn();
    render(<Target onUnlock={onUnlock} />);
    tapTimes(6, 10_000, 300);
    const late = 10_000 + 5 * 300 + UNLOCK_TAP_WINDOW_MS + 1;
    tapAt(late);
    expect(onUnlock).not.toHaveBeenCalled();
    // That tap was the first of a new count, so six more unlock.
    tapTimes(6, late + 300, 300);
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it('counts from zero after an unlock', () => {
    const onUnlock = jest.fn();
    render(<Target onUnlock={onUnlock} />);
    tapTimes(UNLOCK_TAPS + 6, 10_000, 300);
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });
});
