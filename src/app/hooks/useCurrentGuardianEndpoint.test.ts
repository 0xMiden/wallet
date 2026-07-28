import { act, renderHook, waitFor } from '@testing-library/react';

import { fetchFromStorage, onStorageChanged } from 'lib/miden/front';

import {
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

const mockFetchFromStorage = fetchFromStorage as jest.MockedFunction<typeof fetchFromStorage>;
const mockOnStorageChanged = onStorageChanged as jest.MockedFunction<typeof onStorageChanged>;

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchFromStorage.mockResolvedValue(undefined);
  mockOnStorageChanged.mockReturnValue(jest.fn());
});

it('loads the stored endpoint and refreshes it on demand', async () => {
  mockFetchFromStorage.mockResolvedValueOnce('https://first.guardian').mockResolvedValueOnce('https://next.guardian');
  const { result } = renderHook(() => useCurrentGuardianEndpoint());

  await waitFor(() => expect(result.current.endpoint).toBe('https://first.guardian'));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.endpoint).toBe('https://next.guardian'));
  expect(mockFetchFromStorage).toHaveBeenCalledTimes(2);
});

it('falls back to an empty endpoint when storage rejects', async () => {
  mockFetchFromStorage.mockRejectedValue(new Error('storage unavailable'));
  const { result } = renderHook(() => useCurrentGuardianEndpoint());

  await waitFor(() => expect(mockFetchFromStorage).toHaveBeenCalled());
  expect(result.current.endpoint).toBe('');
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
  expect(result.current.endpoint).toBe('');

  unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('matches guardian options across network endpoints', () => {
  expect(guardianOptionForEndpoint('https://dev.guardian.example')?.name).toBe('Guardian One');
  expect(guardianOptionForEndpoint('https://custom.guardian')).toBeUndefined();
});

it('formats guardian hosts and preserves invalid custom values', () => {
  expect(guardianEndpointHost('https://guardian.example/path')).toBe('guardian.example');
  expect(guardianEndpointHost('custom guardian')).toBe('custom guardian');
});
