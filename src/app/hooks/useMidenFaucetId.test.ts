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
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useMidenFaucetId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

    let changeListener!: (id: string) => void | Promise<void>;
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

    let changeListener!: (id: string) => void | Promise<void>;
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

    // Listener fired after cancellation — the guard skips the state write.
    expect(result.current).toBe('initial-faucet-id');
  });
});
