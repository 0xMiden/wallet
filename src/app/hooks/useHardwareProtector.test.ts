import React from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';

import { useHardwareProtector, PROTECTOR_PROBE_DEADLINE_MS } from './useHardwareProtector';

const mockProbeHardwareProtector = jest.fn();
jest.mock('lib/miden/back/protector-probe', () => ({
  probeHardwareProtector: () => mockProbeHardwareProtector()
}));

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

it('reports no answer and no failure while the probe is pending', () => {
  mockProbeHardwareProtector.mockReturnValue(new Promise<boolean>(() => {}));
  const { result } = renderHook(() => useHardwareProtector());

  expect(result.current).toEqual(
    expect.objectContaining({ hasHardwareProtector: null, probeFailed: false, retrying: false })
  );
});

it.each([true, false])('adopts the probe answer (%s)', async hasHardware => {
  mockProbeHardwareProtector.mockResolvedValue(hasHardware);
  const { result } = renderHook(() => useHardwareProtector());

  await waitFor(() =>
    expect(result.current).toEqual(
      expect.objectContaining({ hasHardwareProtector: hasHardware, probeFailed: false, retrying: false })
    )
  );
  expect(warn).not.toHaveBeenCalled();
});

// A failed probe must leave the answer unknown: `false` would pick the password gate.
it('flags a failed probe, logs it, and never answers a credential', async () => {
  mockProbeHardwareProtector.mockRejectedValue(new Error('both protector reads failed (hardware: a; password: b)'));
  const { result } = renderHook(() => useHardwareProtector());

  await waitFor(() => expect(result.current.probeFailed).toBe(true));
  expect(result.current.hasHardwareProtector).toBeNull();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('both protector reads failed (hardware: a; password: b)'));
});

// A new mount starts its own probe rather than reusing a failure.
it('probes again on a new mount after a failure', async () => {
  mockProbeHardwareProtector
    .mockRejectedValueOnce(new Error('both protector reads failed'))
    .mockResolvedValueOnce(true);
  const first = renderHook(() => useHardwareProtector());
  await waitFor(() => expect(first.result.current.probeFailed).toBe(true));
  first.unmount();

  const second = renderHook(() => useHardwareProtector());

  await waitFor(() =>
    expect(second.result.current).toEqual(
      expect.objectContaining({ hasHardwareProtector: true, probeFailed: false, retrying: false })
    )
  );
  expect(mockProbeHardwareProtector).toHaveBeenCalledTimes(2);
});

describe('deadline and Retry (#1241)', () => {
  const never = () => new Promise<boolean>(() => {});
  const deferred = () => {
    let resolve!: (v: boolean) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<boolean>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('stays pending until the deadline, then fails and logs', () => {
    mockProbeHardwareProtector.mockReturnValue(never());
    const { result } = renderHook(() => useHardwareProtector());

    act(() => jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS - 1));
    expect(result.current.probeFailed).toBe(false);
    act(() => jest.advanceTimersByTime(1));
    expect(result.current).toEqual(
      expect.objectContaining({ hasHardwareProtector: null, probeFailed: true, retrying: false })
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`did not answer within ${PROTECTOR_PROBE_DEADLINE_MS}ms`)
    );
  });

  it('adopts an answer that arrives after the deadline', async () => {
    const first = deferred();
    mockProbeHardwareProtector.mockReturnValue(first.promise);
    const { result } = renderHook(() => useHardwareProtector());
    act(() => jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS));
    expect(result.current.probeFailed).toBe(true);

    await act(async () => first.resolve(true));
    expect(result.current).toEqual(
      expect.objectContaining({ hasHardwareProtector: true, probeFailed: false, retrying: false })
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('answered after the deadline'));
  });

  it('retries: keeps the failure on screen while loading, then adopts the new answer', async () => {
    const second = deferred();
    mockProbeHardwareProtector.mockReturnValueOnce(never()).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useHardwareProtector());
    act(() => jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS));

    act(() => result.current.retry());
    expect(mockProbeHardwareProtector).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(expect.objectContaining({ probeFailed: true, retrying: true }));

    await act(async () => second.resolve(false));
    expect(result.current).toEqual(
      expect.objectContaining({ hasHardwareProtector: false, probeFailed: false, retrying: false })
    );
  });

  it('a retry that misses its own deadline fails again and can be retried', () => {
    mockProbeHardwareProtector.mockReturnValue(never());
    const { result } = renderHook(() => useHardwareProtector());
    act(() => jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS));
    act(() => result.current.retry());
    act(() => jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS));

    expect(result.current).toEqual(expect.objectContaining({ probeFailed: true, retrying: false }));
    act(() => result.current.retry());
    expect(mockProbeHardwareProtector).toHaveBeenCalledTimes(3);
  });

  it('a retry that rejects fails again', async () => {
    const second = deferred();
    mockProbeHardwareProtector.mockReturnValueOnce(never()).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useHardwareProtector());
    act(() => jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS));
    act(() => result.current.retry());

    await act(async () => second.reject(new Error('both protector reads failed')));
    expect(result.current).toEqual(expect.objectContaining({ probeFailed: true, retrying: false }));
  });

  it('ignores an earlier attempt rejecting while a retry is in flight', async () => {
    const first = deferred();
    mockProbeHardwareProtector.mockReturnValueOnce(first.promise).mockReturnValueOnce(never());
    const { result } = renderHook(() => useHardwareProtector());
    act(() => jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS));
    act(() => result.current.retry());

    await act(async () => first.reject(new Error('late failure')));
    expect(result.current).toEqual(expect.objectContaining({ probeFailed: true, retrying: true }));
  });

  // protector-probe leaves the storage error to the caller's log, so a superseded one is still logged.
  it('logs an earlier attempt rejecting after a retry as superseded', async () => {
    const first = deferred();
    mockProbeHardwareProtector.mockReturnValueOnce(first.promise).mockReturnValueOnce(never());
    const { result } = renderHook(() => useHardwareProtector());
    act(() => jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS));
    act(() => result.current.retry());

    await act(async () => first.reject(new Error('late failure')));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('superseded'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('late failure'));
    expect(result.current).toEqual(expect.objectContaining({ probeFailed: true, retrying: true }));
  });

  it('keeps an answer when the retry it overtook rejects later', async () => {
    const first = deferred();
    const second = deferred();
    mockProbeHardwareProtector.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useHardwareProtector());
    act(() => jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS));
    act(() => result.current.retry());

    await act(async () => first.resolve(true));
    await act(async () => second.reject(new Error('both protector reads failed')));
    expect(result.current.hasHardwareProtector).toBe(true);
    expect(result.current.probeFailed).toBe(false);
    expect(result.current.retrying).toBe(false);
  });

  it('adopts an earlier attempt answering while a retry is in flight', async () => {
    const first = deferred();
    mockProbeHardwareProtector.mockReturnValueOnce(first.promise).mockReturnValueOnce(never());
    const { result } = renderHook(() => useHardwareProtector());
    act(() => jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS));
    act(() => result.current.retry());

    await act(async () => first.resolve(true));
    expect(result.current).toEqual(
      expect.objectContaining({ hasHardwareProtector: true, probeFailed: false, retrying: false })
    );
    // The retry's own deadline no longer applies once an answer is adopted.
    act(() => jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS));
    expect(result.current.probeFailed).toBe(false);
  });

  it('retry does nothing while the first probe is pending, after an answer, or twice in one tick', async () => {
    const first = deferred();
    mockProbeHardwareProtector.mockReturnValueOnce(first.promise).mockReturnValue(never());
    const { result } = renderHook(() => useHardwareProtector());

    act(() => result.current.retry());
    expect(mockProbeHardwareProtector).toHaveBeenCalledTimes(1);

    act(() => jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS));
    act(() => {
      result.current.retry();
      result.current.retry();
    });
    expect(mockProbeHardwareProtector).toHaveBeenCalledTimes(2);

    await act(async () => first.resolve(true));
    act(() => result.current.retry());
    expect(mockProbeHardwareProtector).toHaveBeenCalledTimes(2);
  });

  it('leaves no deadline behind after unmount', () => {
    mockProbeHardwareProtector.mockReturnValue(never());
    const { unmount } = renderHook(() => useHardwareProtector());
    unmount();

    expect(jest.getTimerCount()).toBe(0);
  });

  it('under StrictMode ignores the first attempt rejecting and adopts the second attempt answering', async () => {
    const first = deferred();
    const second = deferred();
    mockProbeHardwareProtector.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useHardwareProtector(), { wrapper: React.StrictMode });

    await act(async () => first.reject(new Error('stale')));
    expect(result.current.probeFailed).toBe(false);
    await act(async () => second.resolve(true));
    expect(result.current).toEqual(expect.objectContaining({ hasHardwareProtector: true, probeFailed: false }));
  });
});
