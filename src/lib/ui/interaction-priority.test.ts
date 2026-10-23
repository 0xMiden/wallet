import { pagerMotion } from 'lib/animation';

import {
  _resetInteractionPriorityForTest,
  beginInteraction,
  isInteracting,
  subscribeInteraction,
  whenInteractionIdle
} from './interaction-priority';

const CAP = pagerMotion.interactionDeferCapMs;
let frames: Array<() => void> = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  run.forEach(cb => cb());
};
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('interaction priority', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    frames = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      frames.push(() => cb(0));
      return frames.length;
    });
    _resetInteractionPriorityForTest();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('resolves at once when idle', async () => {
    const done = jest.fn();
    void whenInteractionIdle().then(done);
    await flushMicrotasks();
    expect(done).toHaveBeenCalled();
    expect(isInteracting()).toBe(false);
  });

  it('resolves one frame after the last interaction ends', async () => {
    const end = beginInteraction();
    const done = jest.fn();
    void whenInteractionIdle().then(done);
    await flushMicrotasks();
    expect(done).not.toHaveBeenCalled();
    end();
    await flushMicrotasks();
    expect(done).not.toHaveBeenCalled();
    flushFrame();
    await flushMicrotasks();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting when a new interaction starts before the frame', async () => {
    const end = beginInteraction();
    const done = jest.fn();
    void whenInteractionIdle().then(done);
    end();
    const endAgain = beginInteraction();
    flushFrame();
    await flushMicrotasks();
    expect(done).not.toHaveBeenCalled();
    endAgain();
    flushFrame();
    await flushMicrotasks();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('resolves at the cap while still interacting, measured from the first begin', async () => {
    beginInteraction();
    jest.advanceTimersByTime(1000);
    const done = jest.fn();
    void whenInteractionIdle().then(done);
    jest.advanceTimersByTime(CAP - 1000 - 1);
    await flushMicrotasks();
    expect(done).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(done).toHaveBeenCalledTimes(1);
    expect(isInteracting()).toBe(true);
  });

  it('counts nested interactions', () => {
    const endA = beginInteraction();
    const endB = beginInteraction();
    endA();
    expect(isInteracting()).toBe(true);
    endB();
    expect(isInteracting()).toBe(false);
  });

  it('ignores a second call of the same end function', () => {
    const endA = beginInteraction();
    beginInteraction();
    endA();
    endA();
    expect(isInteracting()).toBe(true);
  });

  it('notifies listeners on transitions only and stops after unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeInteraction(listener);
    const endA = beginInteraction();
    const endB = beginInteraction();
    expect(listener.mock.calls).toEqual([[true]]);
    endA();
    expect(listener).toHaveBeenCalledTimes(1);
    endB();
    expect(listener.mock.calls).toEqual([[true], [false]]);
    unsubscribe();
    beginInteraction();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('falls back to a timer when requestAnimationFrame is missing', async () => {
    const original = window.requestAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', { value: undefined, configurable: true });
    const end = beginInteraction();
    const done = jest.fn();
    void whenInteractionIdle().then(done);
    end();
    jest.advanceTimersByTime(16);
    await flushMicrotasks();
    Object.defineProperty(window, 'requestAnimationFrame', { value: original, configurable: true });
    expect(done).toHaveBeenCalledTimes(1);
  });
});
