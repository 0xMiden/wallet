import type { Observer } from 'dexie';

import { subscribeToLiveQuery } from './dexie-live-query';

const observers: Observer<number>[] = [];
const unsubscribeCalls: jest.Mock[] = [];
let synchronousError = false;

jest.mock('dexie', () => ({
  liveQuery: (query: () => unknown) => ({
    subscribe: (observer: Observer<number>) => {
      query();
      observers.push(observer);
      const unsubscribe = jest.fn();
      unsubscribeCalls.push(unsubscribe);
      if (synchronousError) observer.error?.(new Error('read failed'));
      return { unsubscribe };
    }
  })
}));

beforeEach(() => {
  jest.useFakeTimers();
  observers.length = 0;
  unsubscribeCalls.length = 0;
  synchronousError = false;
});

afterEach(() => jest.useRealTimers());

it('keeps one subscription and cancels it on disposal', () => {
  const next = jest.fn();
  const stop = subscribeToLiveQuery(() => 7, { next, error: jest.fn() });
  observers[0]?.next?.(7);
  expect(next).toHaveBeenCalledWith(7);
  expect(observers).toHaveLength(1);
  stop();
  expect(unsubscribeCalls[0]).toHaveBeenCalledTimes(1);
  observers[0]?.next?.(8);
  observers[0]?.error?.(new Error('late'));
  jest.runOnlyPendingTimers();
  expect(next).toHaveBeenCalledTimes(1);
  expect(observers).toHaveLength(1);
});

it('retries at 1/2/4/8/16/30 seconds, caps, and resets after a result', () => {
  const error = jest.fn();
  const stop = subscribeToLiveQuery(() => 7, { next: jest.fn(), error });
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const count = observers.length;
    observers[count - 1]?.error?.(new Error('unavailable'));
    expect(unsubscribeCalls[count - 1]).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(delay - 1);
    expect(observers).toHaveLength(count);
    jest.advanceTimersByTime(1);
    expect(observers).toHaveLength(count + 1);
  }
  observers[7]?.next?.(7);
  observers[7]?.error?.(new Error('again'));
  jest.advanceTimersByTime(1000);
  expect(observers).toHaveLength(9);
  expect(error).toHaveBeenCalledTimes(8);
  stop();
});

it('ignores duplicate errors and late results from a failed subscription', () => {
  const next = jest.fn();
  const error = jest.fn();
  const stop = subscribeToLiveQuery(() => 7, { next, error });
  observers[0]?.error?.(new Error('first'));
  observers[0]?.error?.(new Error('duplicate'));
  observers[0]?.next?.(99);
  expect(error).toHaveBeenCalledTimes(1);
  expect(next).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1000);
  expect(observers).toHaveLength(2);
  observers[1]?.next?.(7);
  expect(next).toHaveBeenCalledWith(7);
  stop();
});

it('cancels a pending retry on disposal', () => {
  const stop = subscribeToLiveQuery(() => 7, { next: jest.fn(), error: jest.fn() });
  observers[0]?.error?.(new Error('unavailable'));
  stop();
  jest.advanceTimersByTime(30000);
  expect(observers).toHaveLength(1);
});

it('cleans up a subscription that reports an error synchronously', () => {
  synchronousError = true;
  const stop = subscribeToLiveQuery(() => 7, { next: jest.fn(), error: jest.fn() });
  expect(unsubscribeCalls[0]).toHaveBeenCalledTimes(1);
  synchronousError = false;
  jest.advanceTimersByTime(1000);
  expect(observers).toHaveLength(2);
  stop();
  expect(unsubscribeCalls[1]).toHaveBeenCalledTimes(1);
});
