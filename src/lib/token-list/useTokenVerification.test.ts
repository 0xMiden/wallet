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

/** Renders the hook for one id, which a test can change with `rerender({ id })`. */
const renderVerification = (id: string) =>
  renderHook((props: { id: string }) => useTokenVerification(props.id), { initialProps: { id } });

it('is unknown while the list loads', () => {
  mockLoad.mockReturnValue(new Promise(() => undefined));
  const { result } = renderVerification('listed');
  expect(result.current).toBe('unknown');
});

it('is unknown on a network with no list', async () => {
  mockLoad.mockResolvedValue(null);
  const { result } = renderVerification('anything');
  await waitFor(() => expect(mockLoad).toHaveBeenCalled());
  await act(async () => undefined);
  expect(result.current).toBe('unknown');
});

it('marks listed tokens verified and others unverified, normalizing both the list and the queried id', async () => {
  // The runtime hands over the ids as the list publishes them.
  mockLoad.mockResolvedValue(new Set(['Listed']));
  const { result, rerender } = renderVerification('other');
  await waitFor(() => expect(result.current).toBe('unverified'));
  rerender({ id: 'LISTED' });
  expect(result.current).toBe('verified');
});

it('treats the native token as verified even when the list omits it', async () => {
  mockLoad.mockResolvedValue(new Set(['listed']));
  const { result } = renderVerification('NATIVE');
  await waitFor(() => expect(result.current).toBe('verified'));
});

it('re-renders when the native id is discovered after mount', async () => {
  mockNative = null;
  mockLoad.mockResolvedValue(new Set(['listed']));
  let renders = 0;
  const { result } = renderHook(() => {
    renders += 1;
    return useTokenVerification('late-native');
  });
  await waitFor(() => expect(result.current).toBe('unverified'));
  const rendersBefore = renders;
  mockNative = 'late-native';
  act(() => mockNativeChanged?.('late-native'));
  expect(renders).toBeGreaterThan(rendersBefore);
  expect(result.current).toBe('verified');
});

it('treats the native token as verified once its id is cached, even when no change event fired', async () => {
  mockNative = null;
  mockLoad.mockResolvedValue(new Set(['listed']));
  const { result, rerender } = renderVerification('hydrated-native');
  await waitFor(() => expect(result.current).toBe('unverified'));
  // A storage hydrate fills the native-asset cache without firing onNativeAssetChanged.
  mockNative = 'hydrated-native';
  rerender({ id: 'hydrated-native' });
  expect(result.current).toBe('verified');
});

it('reloads when a refresh for the current network lands, and ignores other networks', async () => {
  mockLoad.mockResolvedValueOnce(new Set(['a'])).mockResolvedValueOnce(new Set(['a', 'b']));
  const { result } = renderVerification('b');
  await waitFor(() => expect(result.current).toBe('unverified'));
  act(() => mockUpdated?.('devnet'));
  expect(mockLoad).toHaveBeenCalledTimes(1);
  await act(async () => mockUpdated?.('testnet'));
  await waitFor(() => expect(result.current).toBe('verified'));
});

it('re-renders nothing when an update notice reloads an unchanged list', async () => {
  mockLoad.mockResolvedValue(new Set(['listed']));
  let renders = 0;
  const { result } = renderHook(() => {
    const verdict = useTokenVerification('listed');
    if (verdict === 'verified') renders += 1;
    return verdict;
  });
  await waitFor(() => expect(result.current).toBe('verified'));
  mockLoad.mockResolvedValue(new Set(['listed']));
  await act(async () => mockUpdated?.('testnet'));
  expect(mockLoad).toHaveBeenCalledTimes(2);
  expect(renders).toBe(1);
});

it('reloads for a new effective network on the next render', async () => {
  mockLoad.mockImplementation(async (network: string) => (network === 'testnet' ? new Set(['t']) : new Set(['d'])));
  const { result, rerender } = renderVerification('t');
  await waitFor(() => expect(result.current).toBe('verified'));
  mockNetwork = 'devnet';
  rerender({ id: 'd' });
  await waitFor(() => expect(result.current).toBe('verified'));
  rerender({ id: 't' });
  expect(result.current).toBe('unverified');
});

it('does not add its own visibilitychange listener (the runtime installs one per realm)', () => {
  const addEventListenerSpy = jest.spyOn(document, 'addEventListener');
  mockLoad.mockReturnValue(new Promise(() => undefined));
  renderVerification('a');
  renderVerification('b');
  renderVerification('c');
  const visibilityCalls = addEventListenerSpy.mock.calls.filter(([type]) => type === 'visibilitychange');
  expect(visibilityCalls).toHaveLength(0);
  addEventListenerSpy.mockRestore();
});

it('does not let a loaded network speak for another network still loading', async () => {
  mockLoad.mockImplementation((network: string) =>
    network === 'testnet' ? Promise.resolve(new Set(['t'])) : new Promise<Set<string> | null>(() => undefined)
  );
  const { result, rerender } = renderVerification('t');
  await waitFor(() => expect(result.current).toBe('verified'));
  mockNetwork = 'devnet';
  rerender({ id: 't' });
  expect(result.current).toBe('unknown');
});
