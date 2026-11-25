import { act, renderHook } from '@testing-library/react';

import { MidenNameAbortedError } from './errors';
import { MIDEN_NAME_RECORD_POLL_MS, MidenNameRecordState, useMidenNameRecord } from './useMidenNameRecord';

let mockActive = true;
jest.mock('app/layouts/page-active', () => ({
  usePageActive: () => mockActive
}));

let mockSupported = true;
jest.mock('./config', () => ({
  isMidenNameSupported: () => mockSupported
}));

const mockFetchDomainRecordAccount = jest.fn<Promise<string | null>, [string]>();
jest.mock('./resolver', () => ({
  fetchDomainRecordAccount: (label: string) => mockFetchDomainRecordAccount(label)
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const ACCOUNT_A = 'mtst1accounta_0';
const ACCOUNT_B = 'mtst1accountb_0';

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockActive = true;
  mockSupported = true;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useMidenNameRecord', () => {
  it('starts in checking and resolves to here, elsewhere, or none', async () => {
    const first = deferred<string | null>();
    mockFetchDomainRecordAccount.mockReturnValueOnce(first.promise);

    const { result, rerender, unmount } = renderHook(
      ({ accountId, label, refreshKey }) => useMidenNameRecord(accountId, label, refreshKey),
      { initialProps: { accountId: ACCOUNT_A, label: 'alice', refreshKey: '0' } }
    );

    expect(result.current).toBe('checking');
    expect(mockFetchDomainRecordAccount).toHaveBeenCalledWith('alice');

    await act(async () => {
      first.resolve('mtst1accounta_1');
    });
    expect(result.current).toBe('here');

    const second = deferred<string | null>();
    mockFetchDomainRecordAccount.mockReturnValueOnce(second.promise);
    rerender({ accountId: ACCOUNT_A, label: 'alice', refreshKey: '1' });
    expect(result.current).toBe('checking');

    await act(async () => {
      second.resolve(ACCOUNT_B);
    });
    expect(result.current).toBe('elsewhere');

    const third = deferred<string | null>();
    mockFetchDomainRecordAccount.mockReturnValueOnce(third.promise);
    rerender({ accountId: ACCOUNT_A, label: 'alice', refreshKey: '2' });
    expect(result.current).toBe('checking');

    await act(async () => {
      third.resolve(null);
    });
    expect(result.current).toBe('none');
    unmount();
  });

  it('returns checking and issues zero RPC calls when accountId or label is undefined', async () => {
    const { result, rerender, unmount } = renderHook(
      ({ accountId, label }: { accountId: string | undefined; label: string | undefined }) =>
        useMidenNameRecord(accountId, label),
      { initialProps: { accountId: undefined as string | undefined, label: 'alice' as string | undefined } }
    );

    expect(result.current).toBe('checking');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MIDEN_NAME_RECORD_POLL_MS * 2);
    });
    expect(mockFetchDomainRecordAccount).not.toHaveBeenCalled();

    rerender({ accountId: ACCOUNT_A, label: undefined });
    expect(result.current).toBe('checking');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MIDEN_NAME_RECORD_POLL_MS * 2);
    });
    expect(mockFetchDomainRecordAccount).not.toHaveBeenCalled();
    unmount();
  });

  it('synchronously resets prior state to checking on every render when accountId, label, or refreshKey changes', async () => {
    const observed: MidenNameRecordState[] = [];

    mockFetchDomainRecordAccount.mockResolvedValueOnce(ACCOUNT_A);
    const { rerender, unmount } = renderHook(
      ({ accountId, label, refreshKey }) => {
        const value = useMidenNameRecord(accountId, label, refreshKey);
        observed.push(value);
        return value;
      },
      { initialProps: { accountId: ACCOUNT_A, label: 'alice', refreshKey: '0' } }
    );
    await flushMicrotasks();
    expect(observed.at(-1)).toBe('here');

    // Account change resets immediately on the render frame (before resolution).
    const afterAccount = deferred<string | null>();
    mockFetchDomainRecordAccount.mockReturnValueOnce(afterAccount.promise);
    observed.length = 0;
    rerender({ accountId: ACCOUNT_B, label: 'alice', refreshKey: '0' });
    expect(observed[0]).toBe('checking');
    expect(observed).not.toContain('here');
    await act(async () => {
      afterAccount.resolve(ACCOUNT_A);
    });
    expect(observed.at(-1)).toBe('elsewhere');

    // Label change resets prior 'elsewhere' synchronously.
    const afterLabel = deferred<string | null>();
    mockFetchDomainRecordAccount.mockReturnValueOnce(afterLabel.promise);
    observed.length = 0;
    rerender({ accountId: ACCOUNT_B, label: 'bob', refreshKey: '0' });
    expect(observed[0]).toBe('checking');
    expect(observed).not.toContain('elsewhere');
    await act(async () => {
      afterLabel.resolve(null);
    });
    expect(observed.at(-1)).toBe('none');

    // refreshKey change resets prior 'none' synchronously.
    const afterRefresh = deferred<string | null>();
    mockFetchDomainRecordAccount.mockReturnValueOnce(afterRefresh.promise);
    observed.length = 0;
    rerender({ accountId: ACCOUNT_B, label: 'bob', refreshKey: '1' });
    expect(observed[0]).toBe('checking');
    expect(observed).not.toContain('none');
    await act(async () => {
      afterRefresh.resolve(ACCOUNT_B);
    });
    expect(observed.at(-1)).toBe('here');

    unmount();
  });

  it('ignores stale pending reads when query parameters change', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    mockFetchDomainRecordAccount.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender, unmount } = renderHook(({ label }) => useMidenNameRecord(ACCOUNT_A, label), {
      initialProps: { label: 'alice' }
    });

    rerender({ label: 'bob' });
    expect(result.current).toBe('checking');

    await act(async () => {
      first.resolve(ACCOUNT_A);
    });
    expect(result.current).toBe('checking');

    await act(async () => {
      second.resolve(null);
    });
    expect(result.current).toBe('none');

    const third = deferred<string | null>();
    mockFetchDomainRecordAccount.mockReturnValueOnce(third.promise);
    rerender({ label: 'carol' });
    expect(result.current).toBe('checking');

    const fourth = deferred<string | null>();
    mockFetchDomainRecordAccount.mockReturnValueOnce(fourth.promise);
    rerender({ label: 'dave' });

    await act(async () => {
      third.reject(new Error('stale rpc error'));
    });
    expect(result.current).toBe('checking');
    expect(warnSpy).not.toHaveBeenCalled();

    await act(async () => {
      fourth.resolve(ACCOUNT_A);
    });
    expect(result.current).toBe('here');

    warnSpy.mockRestore();
    unmount();
  });

  it('resets state to checking on non-abort RPC failure and ignores MidenNameAbortedError', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockFetchDomainRecordAccount
      .mockResolvedValueOnce(ACCOUNT_A)
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValueOnce(ACCOUNT_B)
      .mockRejectedValueOnce(new MidenNameAbortedError());

    const { result, unmount } = renderHook(() => useMidenNameRecord(ACCOUNT_A, 'alice'));
    await flushMicrotasks();
    expect(result.current).toBe('here');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(MIDEN_NAME_RECORD_POLL_MS);
    });
    expect(result.current).toBe('checking');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(MIDEN_NAME_RECORD_POLL_MS);
    });
    expect(result.current).toBe('elsewhere');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(MIDEN_NAME_RECORD_POLL_MS);
    });
    expect(result.current).toBe('elsewhere');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    unmount();
  });

  it('returns none with zero RPC calls when Miden Name is unsupported', async () => {
    mockSupported = false;
    const { result, rerender, unmount } = renderHook(
      ({ refreshKey }) => useMidenNameRecord(ACCOUNT_A, 'alice', refreshKey),
      { initialProps: { refreshKey: '0' } }
    );

    expect(result.current).toBe('none');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MIDEN_NAME_RECORD_POLL_MS * 2);
    });
    expect(mockFetchDomainRecordAccount).not.toHaveBeenCalled();

    // Switching back to supported initiates reading immediately.
    mockSupported = true;
    mockFetchDomainRecordAccount.mockResolvedValueOnce(ACCOUNT_A);
    rerender({ refreshKey: '0' });
    expect(result.current).toBe('checking');
    await flushMicrotasks();
    expect(result.current).toBe('here');

    // Switching to unsupported stops polling and resets to none.
    mockSupported = false;
    rerender({ refreshKey: '0' });
    expect(result.current).toBe('none');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MIDEN_NAME_RECORD_POLL_MS * 2);
    });
    expect(mockFetchDomainRecordAccount).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('gates RPC reads and interval polling on usePageActive()', async () => {
    mockActive = false;
    const { result, rerender, unmount } = renderHook(({ label }) => useMidenNameRecord(ACCOUNT_A, label), {
      initialProps: { label: 'alice' }
    });

    expect(result.current).toBe('checking');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MIDEN_NAME_RECORD_POLL_MS * 3);
    });
    expect(mockFetchDomainRecordAccount).not.toHaveBeenCalled();

    // Becoming active runs the initial read and starts polling.
    mockActive = true;
    mockFetchDomainRecordAccount.mockResolvedValueOnce(ACCOUNT_A);
    rerender({ label: 'alice' });
    await flushMicrotasks();
    expect(result.current).toBe('here');
    expect(mockFetchDomainRecordAccount).toHaveBeenCalledTimes(1);

    mockFetchDomainRecordAccount.mockResolvedValueOnce(ACCOUNT_B);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MIDEN_NAME_RECORD_POLL_MS);
    });
    expect(result.current).toBe('elsewhere');
    expect(mockFetchDomainRecordAccount).toHaveBeenCalledTimes(2);

    // Transitioning back to inactive cancels polling and issues zero RPC calls.
    mockActive = false;
    rerender({ label: 'alice' });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MIDEN_NAME_RECORD_POLL_MS * 3);
    });
    expect(mockFetchDomainRecordAccount).toHaveBeenCalledTimes(2);

    // Changing label while inactive resets to checking without reading.
    rerender({ label: 'bob' });
    expect(result.current).toBe('checking');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MIDEN_NAME_RECORD_POLL_MS * 2);
    });
    expect(mockFetchDomainRecordAccount).toHaveBeenCalledTimes(2);

    // Re-activating while a previous read was in-flight cancels stale reads when deactivated.
    mockActive = true;
    const pending = deferred<string | null>();
    mockFetchDomainRecordAccount.mockReturnValueOnce(pending.promise);
    rerender({ label: 'bob' });
    expect(mockFetchDomainRecordAccount).toHaveBeenCalledTimes(3);

    mockActive = false;
    rerender({ label: 'bob' });
    await act(async () => {
      pending.resolve(ACCOUNT_A);
    });
    expect(result.current).toBe('checking');

    unmount();
  });
});
