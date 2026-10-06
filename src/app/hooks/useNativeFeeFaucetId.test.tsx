import { act, renderHook, waitFor } from '@testing-library/react';

import { getNativeAssetId, getNativeAssetIdSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';

import useNativeFeeFaucetId from './useNativeFeeFaucetId';

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: jest.fn(),
  getNativeAssetIdSync: jest.fn(),
  onNativeAssetChanged: jest.fn()
}));
jest.mock('lib/miden/assets', () => ({ getFaucetIdSetting: () => Promise.resolve('legacy-display-override') }));

const read = jest.mocked(getNativeAssetId);
const cached = jest.mocked(getNativeAssetIdSync);
const subscribe = jest.mocked(onNativeAssetChanged);
let notify: (id: string) => void;
let stop: jest.Mock;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.resetAllMocks();
  cached.mockReturnValue(null);
  read.mockResolvedValue('');
  stop = jest.fn();
  subscribe.mockImplementation(listener => {
    notify = listener;
    return stop;
  });
});

it('seeds the cached actual fee identity independently of the legacy display override', () => {
  cached.mockReturnValue('actual-fee-faucet');
  read.mockReturnValue(deferred<string>().promise);
  const { result } = renderHook(() => useNativeFeeFaucetId());
  expect(result.current).toBe('actual-fee-faucet');
});

it('keeps a notification result when the earlier mount read resolves last', async () => {
  const initial = deferred<string>();
  const current = deferred<string>();
  read.mockReturnValueOnce(initial.promise).mockReturnValueOnce(current.promise);
  const { result } = renderHook(() => useNativeFeeFaucetId());

  act(() => notify('current-native'));
  await act(async () => current.resolve('current-native'));
  expect(result.current).toBe('current-native');
  await act(async () => initial.resolve('obsolete-native'));
  expect(result.current).toBe('current-native');
});

it('keeps the newest notification when two event reads resolve out of order', async () => {
  const earlier = deferred<string>();
  const latest = deferred<string>();
  read.mockResolvedValueOnce('mounted-native').mockReturnValueOnce(earlier.promise).mockReturnValueOnce(latest.promise);
  const { result } = renderHook(() => useNativeFeeFaucetId());
  await waitFor(() => expect(result.current).toBe('mounted-native'));

  act(() => {
    notify('earlier-native');
    notify('latest-native');
  });
  await act(async () => latest.resolve('latest-native'));
  await act(async () => earlier.resolve('earlier-native'));
  expect(result.current).toBe('latest-native');
});

it('rerenders consumers for a same-ID metadata notification', async () => {
  cached.mockReturnValue('same-native');
  read.mockResolvedValue('same-native');
  let renders = 0;
  const { result } = renderHook(() => {
    renders += 1;
    return useNativeFeeFaucetId();
  });
  await waitFor(() => expect(result.current).toBe('same-native'));
  const beforeNotification = renders;
  await act(async () => notify('same-native'));
  expect(result.current).toBe('same-native');
  expect(renders).toBeGreaterThan(beforeNotification);
});

it('retains the cache after rejection and recovers on the next event', async () => {
  cached.mockReturnValue('cached-native');
  const failed = deferred<string>();
  read.mockReturnValueOnce(failed.promise).mockResolvedValueOnce('recovered-native');
  const { result } = renderHook(() => useNativeFeeFaucetId());
  await act(async () => failed.reject(new Error('identity read failed')));
  expect(result.current).toBe('cached-native');
  await act(async () => notify('recovered-native'));
  expect(result.current).toBe('recovered-native');
});

it('unsubscribes and ignores pending reads and callbacks after unmount', async () => {
  cached.mockReturnValue('cached-native');
  const pending = deferred<string>();
  read.mockReturnValue(pending.promise);
  const { result, unmount } = renderHook(() => useNativeFeeFaucetId());
  unmount();
  expect(stop).toHaveBeenCalledTimes(1);

  await act(async () => {
    notify('post-unmount-native');
    pending.resolve('post-unmount-native');
  });
  expect(result.current).toBe('cached-native');
});
