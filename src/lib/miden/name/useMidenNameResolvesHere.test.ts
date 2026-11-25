import { act, renderHook } from '@testing-library/react';

import { useMidenNameResolvesHere } from './useMidenNameResolvesHere';

let mockSupported = true;
let mockNetwork = 'testnet';
const endpointListeners = new Set<() => void>();
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => mockNetwork,
  subscribeEffectiveEndpoints: (listener: () => void) => {
    endpointListeners.add(listener);
    return () => {
      endpointListeners.delete(listener);
    };
  }
}));
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
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

const ACCOUNT_A = 'mtst1accounta_0';
const ACCOUNT_B = 'mtst1accountb_0';

beforeEach(() => {
  jest.clearAllMocks();
  mockSupported = true;
  mockNetwork = 'testnet';
});

describe('useMidenNameResolvesHere', () => {
  it('synchronously resets on query change, ignores stale reads, and reacts to endpoint-support toggles', async () => {
    const first = deferred<string | null>();
    mockFetchDomainRecordAccount.mockReturnValueOnce(first.promise);

    const frames: boolean[] = [];
    const { result, rerender, unmount } = renderHook(
      ({ accountId, label }) => {
        const value = useMidenNameResolvesHere(accountId, label);
        frames.push(value);
        return value;
      },
      { initialProps: { accountId: ACCOUNT_A, label: 'alice' } }
    );

    expect(result.current).toBe(false);
    await act(async () => {
      first.resolve(ACCOUNT_A);
    });
    expect(result.current).toBe(true);

    // Switching account must synchronously return false on the very first transition render frame.
    const second = deferred<string | null>();
    mockFetchDomainRecordAccount.mockReturnValueOnce(second.promise);
    frames.length = 0;
    rerender({ accountId: ACCOUNT_B, label: 'alice' });
    expect(frames[0]).toBe(false);

    // Switching unsupported clears immediately, and toggling supported back re-queries without rerender.
    mockSupported = false;
    await act(async () => {
      for (const listener of endpointListeners) listener();
    });
    expect(result.current).toBe(false);

    // Resolving the stale second request after support dropped must not flip to true.
    await act(async () => {
      second.resolve(ACCOUNT_B);
    });
    expect(result.current).toBe(false);

    mockSupported = true;
    mockFetchDomainRecordAccount.mockResolvedValueOnce(ACCOUNT_B);
    await act(async () => {
      for (const listener of endpointListeners) listener();
    });
    expect(result.current).toBe(true);
    unmount();
  });

  it('returns false in every render once support drops while the result is true, then reads again when it returns', async () => {
    mockFetchDomainRecordAccount.mockResolvedValueOnce(ACCOUNT_A);
    const frames: boolean[] = [];
    const { result, unmount } = renderHook(() => {
      const value = useMidenNameResolvesHere(ACCOUNT_A, 'alice');
      frames.push(value);
      return value;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(true);

    mockSupported = false;
    frames.length = 0;
    act(() => {
      for (const listener of endpointListeners) listener();
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames).not.toContain(true);
    expect(result.current).toBe(false);

    mockSupported = true;
    mockFetchDomainRecordAccount.mockResolvedValueOnce(ACCOUNT_A);
    await act(async () => {
      for (const listener of endpointListeners) listener();
    });
    expect(result.current).toBe(true);
    unmount();
  });

  it('returns false in the same render and reads again when the network changes while support stays true', async () => {
    mockFetchDomainRecordAccount.mockResolvedValueOnce(ACCOUNT_A);
    const frames: boolean[] = [];
    const { result, unmount } = renderHook(() => {
      const value = useMidenNameResolvesHere(ACCOUNT_A, 'alice');
      frames.push(value);
      return value;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(true);

    mockNetwork = 'mainnet';
    mockFetchDomainRecordAccount.mockResolvedValueOnce(null);
    frames.length = 0;
    act(() => {
      for (const listener of endpointListeners) listener();
    });
    // Every render after the change, including the one before any effect runs, hides the previous network's result.
    expect(frames.length).toBeGreaterThan(0);
    expect(frames).not.toContain(true);
    expect(result.current).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
    expect(mockFetchDomainRecordAccount).toHaveBeenCalledTimes(2);
    unmount();
  });
});
