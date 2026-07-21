import { RefObject } from 'react';

import { renderHook } from '@testing-library/react';

import { useIntersectionDetection } from './use-intersection-detection';

/**
 * jsdom ships no `IntersectionObserver`, so we install a fake that records the
 * callback + options handed to the constructor and exposes `observe` /
 * `unobserve` spies. `trigger` lets a test synchronously replay the entries the
 * real browser would deliver, so we can exercise the intersection branch.
 */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    MockIntersectionObserver.instances.push(this);
  }

  trigger(entries: Array<Partial<IntersectionObserverEntry>>) {
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }

  static get last() {
    return MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1];
  }
}

const makeRef = (el: HTMLDivElement | null): RefObject<HTMLDivElement> => ({ current: el });

describe('useIntersectionDetection', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIntersectionObserver;
  });

  afterEach(() => {
    delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    jest.clearAllMocks();
  });

  it('observes the element and fires the callback when it intersects (default predicate)', () => {
    const el = document.createElement('div');
    const ref = makeRef(el);
    const callback = jest.fn();

    // No predicate arg -> exercises the `predicate = true` default.
    renderHook(() => useIntersectionDetection(ref, callback));

    expect(MockIntersectionObserver.instances).toHaveLength(1);
    const observer = MockIntersectionObserver.last!;
    expect(observer.options).toEqual({ rootMargin: '0px' });
    expect(observer.observe).toHaveBeenCalledWith(el);
    expect(callback).not.toHaveBeenCalled();

    observer.trigger([{ isIntersecting: true }]);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not fire the callback when the entry is not intersecting', () => {
    const el = document.createElement('div');
    const callback = jest.fn();

    renderHook(() => useIntersectionDetection(makeRef(el), callback, true));

    MockIntersectionObserver.last!.trigger([{ isIntersecting: false }]);

    expect(callback).not.toHaveBeenCalled();
  });

  it('does not fire the callback when there is no entry (optional-chaining guard)', () => {
    const el = document.createElement('div');
    const callback = jest.fn();

    renderHook(() => useIntersectionDetection(makeRef(el), callback, true));

    // Empty entry list -> `entry` is undefined -> `entry?.isIntersecting` short-circuits.
    MockIntersectionObserver.last!.trigger([]);

    expect(callback).not.toHaveBeenCalled();
  });

  it('unobserves the element on cleanup', () => {
    const el = document.createElement('div');
    const callback = jest.fn();

    const { unmount } = renderHook(() => useIntersectionDetection(makeRef(el), callback, true));

    const observer = MockIntersectionObserver.last!;
    expect(observer.unobserve).not.toHaveBeenCalled();

    unmount();

    expect(observer.unobserve).toHaveBeenCalledWith(el);
  });

  it('does nothing when predicate is false', () => {
    const el = document.createElement('div');
    const callback = jest.fn();

    renderHook(() => useIntersectionDetection(makeRef(el), callback, false));

    expect(MockIntersectionObserver.instances).toHaveLength(0);
    expect(callback).not.toHaveBeenCalled();
  });

  it('does nothing when the ref has no element', () => {
    const callback = jest.fn();

    const { unmount } = renderHook(() => useIntersectionDetection(makeRef(null), callback, true));

    expect(MockIntersectionObserver.instances).toHaveLength(0);

    // Cleanup path must be a no-op too (no observer to unobserve).
    expect(() => unmount()).not.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });

  it('does nothing when IntersectionObserver is unavailable in the environment', () => {
    delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;

    const el = document.createElement('div');
    const callback = jest.fn();

    expect(() => renderHook(() => useIntersectionDetection(makeRef(el), callback, true))).not.toThrow();

    expect(MockIntersectionObserver.instances).toHaveLength(0);
    expect(callback).not.toHaveBeenCalled();
  });
});
