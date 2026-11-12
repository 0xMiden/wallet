import { act, renderHook } from '@testing-library/react';

import { backgroundLockPending, BACKGROUND_LOCK_HEARTBEAT_MS, createBackgroundLockClock } from './background-lock';

const DELAY = 600_000;
const make = (now = 0, delay: () => number = () => DELAY) => createBackgroundLockClock(delay, now);

describe('createBackgroundLockClock', () => {
  it('locks when hidden for the delay', () => {
    const clock = make();
    clock.hidden(1_000);
    expect(clock.visible(601_000)).toBe(true);
  });

  it('does not lock after a shorter absence', () => {
    const clock = make();
    clock.hidden(1_000);
    expect(clock.visible(500_000)).toBe(false);
  });

  it('the first hidden signal wins', () => {
    const clock = make();
    clock.hidden(1_000);
    clock.hidden(400_000);
    expect(clock.visible(601_000)).toBe(true);
  });

  it('a hidden signal later than one heartbeat measures from the last tick', () => {
    const clock = make();
    clock.tick(0);
    clock.hidden(DELAY);
    expect(clock.visible(DELAY)).toBe(true);
  });

  it('an on-time hidden signal is not pulled back to the last tick', () => {
    const clock = make();
    clock.hidden(BACKGROUND_LOCK_HEARTBEAT_MS);
    expect(clock.visible(BACKGROUND_LOCK_HEARTBEAT_MS + DELAY - 1)).toBe(false);
  });

  it('a visible signal with no hidden one measures from the last heartbeat', () => {
    const clock = make();
    clock.tick(5_000);
    expect(clock.visible(5_000 + DELAY)).toBe(true);
    const other = make();
    other.tick(5_000);
    expect(other.visible(5_000 + DELAY - 1)).toBe(false);
  });

  it('a heartbeat after a freeze locks when the gap reached the delay', () => {
    const frozen = make();
    frozen.tick(0);
    expect(frozen.tick(600_000)).toBe(true);
    const live = make();
    live.tick(0);
    expect(live.tick(10_000)).toBe(false);
  });

  it('a heartbeat while hidden locks once the delay has passed, and leaves the hide open', () => {
    const kept = make();
    kept.hidden(1_000);
    expect(kept.tick(2_000)).toBe(false);
    expect(kept.visible(1_000 + DELAY)).toBe(true);
    const held = make();
    held.hidden(1_000);
    expect(held.tick(1_000 + DELAY - 1)).toBe(false);
    expect(held.tick(1_000 + DELAY)).toBe(true);
  });

  it('a heartbeat while hidden locks when the clock moves backward', () => {
    const back = make();
    back.hidden(1_000_000);
    expect(back.tick(10)).toBe(true);
  });

  it('locks when the clock moved back across a background', () => {
    const clock = make();
    clock.hidden(1_000_000);
    expect(clock.visible(10)).toBe(true);
  });

  it('a visible signal with no hide open still sees a clock set back below the last one', () => {
    const clock = make();
    clock.hidden(1_000);
    clock.visible(2_000_000);
    expect(clock.visible(1_500_000)).toBe(true);
  });

  it('a heartbeat that sees the clock move back does not lock', () => {
    const clock = make(1_000_000);
    expect(clock.tick(10)).toBe(false);
  });

  it('reads the delay at each decision', () => {
    let delay = DELAY;
    const clock = make(0, () => delay);
    clock.hidden(1_000);
    delay = 60_000;
    expect(clock.visible(61_000)).toBe(true);
    clock.hidden(100_000);
    delay = DELAY;
    expect(clock.visible(161_000)).toBe(false);
  });
});

describe('backgroundLockPending', () => {
  afterEach(() => backgroundLockPending.set(false));

  it('the pending flag notifies subscribers', () => {
    const { result } = renderHook(() => backgroundLockPending.useValue());
    expect(result.current).toBe(false);
    act(() => backgroundLockPending.set(true));
    expect(result.current).toBe(true);
    expect(backgroundLockPending.get()).toBe(true);
    act(() => backgroundLockPending.set(false));
    expect(result.current).toBe(false);
  });
});
