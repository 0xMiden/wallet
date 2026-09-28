import { act, renderHook, waitFor } from '@testing-library/react';

import { useTokenVerification } from './useTokenVerification';

const mockLoad = jest.fn();
let mockUpdated: ((network: string) => void) | undefined;
jest.mock('./runtime', () => ({
  loadVerifiedFaucetIds: (network: string) => mockLoad(network),
  onTokenListUpdated: (listener: (network: string) => void) => {
    mockUpdated = listener;
    return () => {
      mockUpdated = undefined;
    };
  }
}));
let mockNetwork = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));
let mockNative: string | null = 'native';
let mockNativeChanged: ((id: string) => void) | undefined;
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => mockNative,
  onNativeAssetChanged: (fn: (id: string) => void) => {
    mockNativeChanged = fn;
    return () => undefined;
  }
}));
jest.mock('lib/miden/swap/tokens', () => ({ normalizedFaucetId: (id: string) => id.toLowerCase() }));

beforeEach(() => {
  mockLoad.mockReset();
  mockNetwork = 'testnet';
  mockNative = 'native';
});

it('is unknown while the list loads', () => {
  mockLoad.mockReturnValue(new Promise(() => undefined));
  const { result } = renderHook(() => useTokenVerification());
  expect(result.current('listed')).toBe('unknown');
});

it('is unknown on a network with no list', async () => {
  mockLoad.mockResolvedValue(null);
  const { result } = renderHook(() => useTokenVerification());
  await waitFor(() => expect(mockLoad).toHaveBeenCalled());
  await act(async () => undefined);
  expect(result.current('anything')).toBe('unknown');
});

it('marks listed tokens verified and others unverified, comparing normalized ids', async () => {
  mockLoad.mockResolvedValue(new Set(['listed']));
  const { result } = renderHook(() => useTokenVerification());
  await waitFor(() => expect(result.current('LISTED')).toBe('verified'));
  expect(result.current('other')).toBe('unverified');
});

it('treats the native token as verified even when the list omits it', async () => {
  mockLoad.mockResolvedValue(new Set(['listed']));
  const { result } = renderHook(() => useTokenVerification());
  await waitFor(() => expect(result.current('NATIVE')).toBe('verified'));
});

it('re-renders when the native id is discovered after mount', async () => {
  mockNative = null;
  mockLoad.mockResolvedValue(new Set(['listed']));
  let renders = 0;
  const { result } = renderHook(() => {
    renders += 1;
    return useTokenVerification();
  });
  await waitFor(() => expect(result.current('late-native')).toBe('unverified'));
  const rendersBefore = renders;
  mockNative = 'late-native';
  act(() => mockNativeChanged?.('late-native'));
  expect(renders).toBeGreaterThan(rendersBefore);
  expect(result.current('late-native')).toBe('verified');
});

it('treats the native token as verified once its id is cached, even when no change event fired', async () => {
  mockNative = null;
  mockLoad.mockResolvedValue(new Set(['listed']));
  const { result, rerender } = renderHook(() => useTokenVerification());
  await waitFor(() => expect(result.current('hydrated-native')).toBe('unverified'));
  // A storage hydrate fills the native-asset cache without firing onNativeAssetChanged.
  mockNative = 'hydrated-native';
  rerender();
  expect(result.current('hydrated-native')).toBe('verified');
});

it('reloads when a refresh for the current network lands, and ignores other networks', async () => {
  mockLoad.mockResolvedValueOnce(new Set(['a'])).mockResolvedValueOnce(new Set(['a', 'b']));
  const { result } = renderHook(() => useTokenVerification());
  await waitFor(() => expect(result.current('b')).toBe('unverified'));
  act(() => mockUpdated?.('devnet'));
  expect(mockLoad).toHaveBeenCalledTimes(1);
  await act(async () => mockUpdated?.('testnet'));
  await waitFor(() => expect(result.current('b')).toBe('verified'));
});

it('reloads for a new effective network on the next render', async () => {
  mockLoad.mockImplementation(async (network: string) => (network === 'testnet' ? new Set(['t']) : new Set(['d'])));
  const { result, rerender } = renderHook(() => useTokenVerification());
  await waitFor(() => expect(result.current('t')).toBe('verified'));
  mockNetwork = 'devnet';
  rerender();
  await waitFor(() => expect(result.current('d')).toBe('verified'));
  expect(result.current('t')).toBe('unverified');
});

it('does not let a loaded network speak for another network still loading', async () => {
  mockLoad.mockImplementation((network: string) =>
    network === 'testnet' ? Promise.resolve(new Set(['t'])) : new Promise<Set<string> | null>(() => undefined)
  );
  const { result, rerender } = renderHook(() => useTokenVerification());
  await waitFor(() => expect(result.current('t')).toBe('verified'));
  mockNetwork = 'devnet';
  rerender();
  expect(result.current('t')).toBe('unknown');
});
