import { act, renderHook, waitFor } from '@testing-library/react';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { getNativeAssetIdSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';

import useMidenFaucetId from './useMidenFaucetId';

jest.mock('lib/miden/assets', () => ({
  getFaucetIdSetting: jest.fn()
}));

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(),
  onNativeAssetChanged: jest.fn()
}));

const mockGetFaucetIdSetting = getFaucetIdSetting as jest.MockedFunction<typeof getFaucetIdSetting>;
const mockGetNativeAssetIdSync = getNativeAssetIdSync as jest.MockedFunction<typeof getNativeAssetIdSync>;
const mockOnNativeAssetChanged = onNativeAssetChanged as jest.MockedFunction<typeof onNativeAssetChanged>;

/** Creates a promise whose resolution is controlled by the returned `resolve`. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useMidenFaucetId', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Safe defaults; individual tests override as needed.
    mockGetNativeAssetIdSync.mockReturnValue(null);
    mockGetFaucetIdSetting.mockResolvedValue(null);
    mockOnNativeAssetChanged.mockReturnValue(jest.fn());
  });

  it('seeds initial state from getNativeAssetIdSync (non-null)', () => {
    mockGetNativeAssetIdSync.mockReturnValue('sync-faucet-id');
    // Pending promise so the mount effect never overwrites the seed value.
    mockGetFaucetIdSetting.mockReturnValue(deferred<string | null>().promise);

    const { result } = renderHook(() => useMidenFaucetId());

    expect(result.current).toBe('sync-faucet-id');
    expect(mockGetNativeAssetIdSync).toHaveBeenCalledTimes(1);
  });

  it('seeds initial state as null when getNativeAssetIdSync returns null', () => {
    mockGetNativeAssetIdSync.mockReturnValue(null);
    mockGetFaucetIdSetting.mockReturnValue(deferred<string | null>().promise);

    const { result } = renderHook(() => useMidenFaucetId());

    expect(result.current).toBeNull();
  });

  it('updates state with the resolved faucet id after mount', async () => {
    mockGetNativeAssetIdSync.mockReturnValue(null);
    mockGetFaucetIdSetting.mockResolvedValue('resolved-faucet-id');

    const { result } = renderHook(() => useMidenFaucetId());

    await waitFor(() => expect(result.current).toBe('resolved-faucet-id'));
    expect(mockGetFaucetIdSetting).toHaveBeenCalledTimes(1);
    expect(mockOnNativeAssetChanged).toHaveBeenCalledTimes(1);
    expect(mockOnNativeAssetChanged).toHaveBeenCalledWith(expect.any(Function));
  });

  it('re-reads the faucet id when the native-asset change listener fires', async () => {
    mockGetNativeAssetIdSync.mockReturnValue(null);
    mockGetFaucetIdSetting.mockResolvedValue('initial-faucet-id');

    let changeListener!: (id: string) => void;
    mockOnNativeAssetChanged.mockImplementation(fn => {
      changeListener = fn;
      return jest.fn();
    });

    const { result } = renderHook(() => useMidenFaucetId());

    await waitFor(() => expect(result.current).toBe('initial-faucet-id'));

    mockGetFaucetIdSetting.mockResolvedValue('changed-faucet-id');
    await act(async () => {
      await changeListener('some-new-id');
    });

    expect(result.current).toBe('changed-faucet-id');
  });

  it('unsubscribes from the change listener on unmount', () => {
    const unsub = jest.fn();
    mockGetNativeAssetIdSync.mockReturnValue(null);
    mockGetFaucetIdSetting.mockReturnValue(deferred<string | null>().promise);
    mockOnNativeAssetChanged.mockReturnValue(unsub);

    const { unmount } = renderHook(() => useMidenFaucetId());

    expect(unsub).not.toHaveBeenCalled();
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('does not apply the mount fetch result if unmounted before it resolves', async () => {
    mockGetNativeAssetIdSync.mockReturnValue('seed-id');
    const { promise, resolve } = deferred<string | null>();
    mockGetFaucetIdSetting.mockReturnValue(promise);

    const { result, unmount } = renderHook(() => useMidenFaucetId());

    // Cancel before the in-flight fetch settles.
    unmount();

    await act(async () => {
      resolve('late-value');
      await promise;
    });

    // The cancelled guard prevents the stale write; state stays at the seed.
    expect(result.current).toBe('seed-id');
  });

  it('does not apply a change-listener fetch result after unmount', async () => {
    mockGetNativeAssetIdSync.mockReturnValue(null);
    mockGetFaucetIdSetting.mockResolvedValue('initial-faucet-id');

    let changeListener!: (id: string) => void;
    mockOnNativeAssetChanged.mockImplementation(fn => {
      changeListener = fn;
      return jest.fn();
    });

    const { result, unmount } = renderHook(() => useMidenFaucetId());

    await waitFor(() => expect(result.current).toBe('initial-faucet-id'));

    unmount();

    mockGetFaucetIdSetting.mockResolvedValue('post-unmount-value');
    await act(async () => {
      await changeListener('another-id');
    });

    // Listener fired after cancellation - the guard skips the state write.
    expect(result.current).toBe('initial-faucet-id');
  });

  it('keeps a notification result when the earlier mount read resolves last', async () => {
    const initial = deferred<string | null>();
    const current = deferred<string | null>();
    mockGetFaucetIdSetting.mockReturnValueOnce(initial.promise).mockReturnValueOnce(current.promise);
    let notify!: (id: string) => void;
    mockOnNativeAssetChanged.mockImplementation(listener => {
      notify = listener;
      return jest.fn();
    });
    const { result } = renderHook(() => useMidenFaucetId());

    act(() => {
      notify('current-native');
    });
    await act(async () => current.resolve('current-display'));
    expect(result.current).toBe('current-display');
    await act(async () => initial.resolve('obsolete-display'));
    expect(result.current).toBe('current-display');
  });

  it('keeps the newest notification when two event reads resolve out of order', async () => {
    const earlier = deferred<string | null>();
    const latest = deferred<string | null>();
    mockGetFaucetIdSetting
      .mockResolvedValueOnce('mounted-display')
      .mockReturnValueOnce(earlier.promise)
      .mockReturnValueOnce(latest.promise);
    let notify!: (id: string) => void;
    mockOnNativeAssetChanged.mockImplementation(listener => {
      notify = listener;
      return jest.fn();
    });
    const { result } = renderHook(() => useMidenFaucetId());
    await waitFor(() => expect(result.current).toBe('mounted-display'));

    act(() => {
      notify('earlier-native');
      notify('latest-native');
    });
    await act(async () => latest.resolve('latest-display'));
    await act(async () => earlier.resolve('earlier-display'));
    expect(result.current).toBe('latest-display');
  });

  it('retains the explicit display override when native identity changes', async () => {
    mockGetNativeAssetIdSync.mockReturnValue('actual-fee-faucet');
    mockGetFaucetIdSetting.mockResolvedValue('explicit-display-override');
    let notify!: (id: string) => void;
    mockOnNativeAssetChanged.mockImplementation(listener => {
      notify = listener;
      return jest.fn();
    });
    const { result } = renderHook(() => useMidenFaucetId());
    await waitFor(() => expect(result.current).toBe('explicit-display-override'));
    await act(async () => notify('new-actual-fee-faucet'));
    expect(result.current).toBe('explicit-display-override');
  });

  it('rerenders consumers for a same-ID metadata notification', async () => {
    mockGetFaucetIdSetting.mockResolvedValue('same-faucet');
    let notify!: (id: string) => void;
    mockOnNativeAssetChanged.mockImplementation(listener => {
      notify = listener;
      return jest.fn();
    });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useMidenFaucetId();
    });
    await waitFor(() => expect(result.current).toBe('same-faucet'));
    const beforeNotification = renders;
    await act(async () => notify('same-faucet'));
    expect(result.current).toBe('same-faucet');
    expect(renders).toBeGreaterThan(beforeNotification);
  });

  it('keeps the cached identity after a rejected read and recovers on notification', async () => {
    mockGetNativeAssetIdSync.mockReturnValue('cached-display');
    const failed = deferred<string | null>();
    mockGetFaucetIdSetting.mockReturnValueOnce(failed.promise).mockResolvedValueOnce('recovered-display');
    let notify!: (id: string) => void;
    mockOnNativeAssetChanged.mockImplementation(listener => {
      notify = listener;
      return jest.fn();
    });
    const { result } = renderHook(() => useMidenFaucetId());
    await act(async () => failed.reject(new Error('identity read failed')));
    expect(result.current).toBe('cached-display');
    await act(async () => notify('recovered-native'));
    expect(result.current).toBe('recovered-display');
  });
});
