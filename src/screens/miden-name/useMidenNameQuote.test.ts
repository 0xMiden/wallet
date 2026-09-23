import { act, renderHook } from '@testing-library/react';

import type { MidenNameQuote } from 'lib/miden/name/reads';

import { MIDEN_NAME_QUOTE_DEBOUNCE_MS, useMidenNameQuote } from './useMidenNameQuote';

const mockFetchMidenNameQuote = jest.fn<Promise<MidenNameQuote>, [string]>();
jest.mock('lib/miden/name/reads', () => ({
  fetchMidenNameQuote: (label: string) => mockFetchMidenNameQuote(label)
}));

function quote(label: string, overrides: Partial<MidenNameQuote> = {}): MidenNameQuote {
  return {
    label,
    available: true,
    priceBaseUnits: 20_000_000n,
    networkFeeBaseUnits: 210n,
    scriptAllowed: true,
    blockNum: 1,
    ...overrides
  };
}

interface Deferred {
  resolve: (value: MidenNameQuote) => void;
  reject: (error: Error) => void;
}

function deferQuote(): Deferred {
  const deferred: Deferred = { resolve: () => undefined, reject: () => undefined };
  mockFetchMidenNameQuote.mockImplementationOnce(
    () =>
      new Promise<MidenNameQuote>((resolve, reject) => {
        deferred.resolve = resolve;
        deferred.reject = reject;
      })
  );
  return deferred;
}

async function flush(ms = MIDEN_NAME_QUOTE_DEBOUNCE_MS) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

describe('useMidenNameQuote', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockFetchMidenNameQuote.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is idle for an empty input and reads nothing', async () => {
    const { result } = renderHook(() => useMidenNameQuote(''));
    await flush();
    expect(result.current.status).toBe('idle');
    expect(mockFetchMidenNameQuote).not.toHaveBeenCalled();
  });

  it.each([
    ['Al!ce', 'invalid-chars'],
    ['a'.repeat(22), 'too-long']
  ])('is invalid for %s and reads nothing', async (input, reason) => {
    const { result } = renderHook(() => useMidenNameQuote(input));
    await flush();
    expect(result.current.status).toBe('invalid');
    expect(result.current.reason).toBe(reason);
    expect(mockFetchMidenNameQuote).not.toHaveBeenCalled();
  });

  it('normalizes the input (case, spaces, the .miden suffix)', async () => {
    mockFetchMidenNameQuote.mockResolvedValueOnce(quote('alice'));
    const { result } = renderHook(() => useMidenNameQuote('  Alice.miden '));
    await flush();
    expect(mockFetchMidenNameQuote).toHaveBeenCalledWith('alice');
    expect(result.current.label).toBe('alice');
    expect(result.current.status).toBe('available');
  });

  it('debounces: only the last input in 350 ms is read', async () => {
    mockFetchMidenNameQuote.mockResolvedValue(quote('alice'));
    const { rerender } = renderHook(({ input }) => useMidenNameQuote(input), { initialProps: { input: 'a' } });
    await flush(100);
    rerender({ input: 'al' });
    await flush(100);
    rerender({ input: 'alice' });
    await flush(MIDEN_NAME_QUOTE_DEBOUNCE_MS - 1);
    expect(mockFetchMidenNameQuote).not.toHaveBeenCalled();
    await flush(1);
    expect(mockFetchMidenNameQuote).toHaveBeenCalledTimes(1);
    expect(mockFetchMidenNameQuote).toHaveBeenCalledWith('alice');
  });

  it('ignores a late result for an old label (abort on change)', async () => {
    const first = deferQuote();
    const second = deferQuote();
    const { result, rerender } = renderHook(({ input }) => useMidenNameQuote(input), {
      initialProps: { input: 'bob' }
    });
    await flush();
    rerender({ input: 'alice' });
    await flush();
    expect(mockFetchMidenNameQuote).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(quote('bob', { available: false }));
    });
    expect(result.current.status).toBe('checking');
    expect(result.current.label).toBe('alice');

    await act(async () => {
      second.resolve(quote('alice'));
    });
    expect(result.current.status).toBe('available');
    expect(result.current.quote?.label).toBe('alice');
  });

  it('ignores a result that arrives after unmount', async () => {
    const pending = deferQuote();
    const { result, unmount } = renderHook(() => useMidenNameQuote('alice'));
    await flush();
    const before = result.current.status;
    unmount();
    await act(async () => {
      pending.resolve(quote('alice'));
    });
    expect(before).toBe('checking');
  });

  it.each<[string, Partial<MidenNameQuote>, string]>([
    ['available', {}, 'available'],
    ['taken', { available: false }, 'taken'],
    ['unsupported', { scriptAllowed: false }, 'unsupported']
  ])('maps a %s quote', async (_name, overrides, status) => {
    mockFetchMidenNameQuote.mockResolvedValueOnce(quote('alice', overrides));
    const { result } = renderHook(() => useMidenNameQuote('alice'));
    await flush();
    expect(result.current.status).toBe(status);
  });

  it('is error when the read fails, and keeps the last quote', async () => {
    mockFetchMidenNameQuote.mockResolvedValueOnce(quote('bob'));
    mockFetchMidenNameQuote.mockRejectedValueOnce(new Error('rpc down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result, rerender } = renderHook(({ input }) => useMidenNameQuote(input), {
      initialProps: { input: 'bob' }
    });
    await flush();
    rerender({ input: 'alice' });
    expect(result.current.status).toBe('checking');
    expect(result.current.quote?.label).toBe('bob');
    await flush();
    expect(result.current.status).toBe('error');
    expect(result.current.quote?.label).toBe('bob');
    warn.mockRestore();
  });

  it('recheck reads the same label again', async () => {
    mockFetchMidenNameQuote.mockResolvedValueOnce(quote('alice'));
    mockFetchMidenNameQuote.mockResolvedValueOnce(quote('alice', { available: false }));
    const { result } = renderHook(() => useMidenNameQuote('alice'));
    await flush();
    expect(result.current.status).toBe('available');
    act(() => result.current.recheck());
    await flush();
    expect(mockFetchMidenNameQuote).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('taken');
  });
});
