import { act, renderHook, waitFor } from '@testing-library/react';

import { fetchFromStorage, onStorageChanged } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import {
  guardianEndpointDisplayName,
  guardianEndpointHost,
  guardianOptionForEndpoint,
  useCurrentGuardianEndpoint
} from './useCurrentGuardianEndpoint';

jest.mock('lib/miden/front', () => ({
  fetchFromStorage: jest.fn(),
  onStorageChanged: jest.fn()
}));

jest.mock('lib/miden-chain/constants', () => ({
  GUARDIAN_OPTIONS: [
    {
      name: 'Guardian One',
      endpoint: new Map([
        ['testnet', 'https://test.guardian.example'],
        ['devnet', 'https://dev.guardian.example']
      ])
    }
  ]
}));

jest.mock('lib/settings/constants', () => ({
  GUARDIAN_URL_STORAGE_KEY: 'guardian_url_setting'
}));

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveDefaultGuardianEndpoint: () => 'https://default.guardian.example',
  getEffectiveNetworkName: () => 'testnet'
}));

const mockFetchFromStorage = fetchFromStorage as jest.MockedFunction<typeof fetchFromStorage>;
const mockOnStorageChanged = onStorageChanged as jest.MockedFunction<typeof onStorageChanged>;

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchFromStorage.mockResolvedValue(undefined);
  mockOnStorageChanged.mockReturnValue(jest.fn());
  useWalletStore.setState({ currentAccount: null });
});

it('loads the stored endpoint and refreshes it on demand', async () => {
  mockFetchFromStorage.mockResolvedValueOnce('https://first.guardian').mockResolvedValueOnce('https://next.guardian');
  const { result } = renderHook(() => useCurrentGuardianEndpoint());

  await waitFor(() => expect(result.current.endpoint).toBe('https://first.guardian'));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.endpoint).toBe('https://next.guardian'));
  expect(mockFetchFromStorage).toHaveBeenCalledTimes(2);
});

// Third branch of the backend's `resolveGuardianEndpoint`, which this hook is
// documented to mirror. Stopping at '' made the UI disagree with the record the
// switch was about to write: the current provider showed as "Unknown" and the
// same-endpoint guards compared against '' and never fired, so a pre-#408
// Guardian account could queue a switch onto the Guardian it already had.
it('falls back to the effective default endpoint when neither source has one', async () => {
  const { result } = renderHook(() => useCurrentGuardianEndpoint());

  await waitFor(() => expect(mockFetchFromStorage).toHaveBeenCalled());
  expect(result.current.endpoint).toBe('https://default.guardian.example');
});

it('falls back to the effective default when storage rejects', async () => {
  mockFetchFromStorage.mockRejectedValue(new Error('storage unavailable'));
  const { result } = renderHook(() => useCurrentGuardianEndpoint());

  await waitFor(() => expect(mockFetchFromStorage).toHaveBeenCalled());
  expect(result.current.endpoint).toBe('https://default.guardian.example');
});

it('reacts to storage changes and unsubscribes on unmount', async () => {
  const unsubscribe = jest.fn();
  let onChange: ((next: string | null | undefined) => void) | undefined;
  mockOnStorageChanged.mockImplementation((_key, callback) => {
    onChange = callback;
    return unsubscribe;
  });
  const { result, unmount } = renderHook(() => useCurrentGuardianEndpoint());
  await waitFor(() => expect(onChange).toBeDefined());

  act(() => onChange?.('https://changed.guardian'));
  expect(result.current.endpoint).toBe('https://changed.guardian');
  act(() => onChange?.(undefined));
  expect(result.current.endpoint).toBe('https://default.guardian.example');

  unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('prefers the per-account guardianEndpoint over the legacy global key', async () => {
  mockFetchFromStorage.mockResolvedValue('https://stale.global.guardian');
  useWalletStore.setState({
    currentAccount: {
      publicKey: '0xabc',
      name: 'Guardian Account',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      guardianEndpoint: 'https://switched.guardian'
    }
  });
  const { result } = renderHook(() => useCurrentGuardianEndpoint());

  await waitFor(() => expect(mockFetchFromStorage).toHaveBeenCalled());
  expect(result.current.endpoint).toBe('https://switched.guardian');
});

it('matches guardian options only on the EFFECTIVE network endpoint', () => {
  expect(guardianOptionForEndpoint('https://test.guardian.example')?.name).toBe('Guardian One');
  // The same provider's endpoint on ANOTHER network is, on this network, just a
  // custom URL — the any-network match is what branded a custom localhost
  // guardian as "OpenZeppelin" (its LOCALNET endpoint) on devnet builds.
  expect(guardianOptionForEndpoint('https://dev.guardian.example')).toBeUndefined();
  expect(guardianOptionForEndpoint('https://custom.guardian')).toBeUndefined();
});

it('formats guardian hosts and preserves invalid custom values', () => {
  expect(guardianEndpointHost('https://guardian.example/path')).toBe('guardian.example');
  expect(guardianEndpointHost('custom guardian')).toBe('custom guardian');
});

it('formats known, custom, and missing endpoints for Guardian transitions', () => {
  expect(guardianEndpointDisplayName('https://test.guardian.example', 'Unknown')).toBe('Guardian One');
  expect(guardianEndpointDisplayName('https://custom.guardian.example/path', 'Unknown')).toBe(
    'custom.guardian.example'
  );
  expect(guardianEndpointDisplayName(undefined, 'Unknown')).toBe('Unknown');
});
