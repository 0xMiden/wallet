import { renderHook } from '@testing-library/react';

import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import {
  guardianEndpointDisplayName,
  guardianEndpointHost,
  guardianOptionForEndpoint,
  useCurrentGuardianEndpoint
} from './useCurrentGuardianEndpoint';

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

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveDefaultGuardianEndpoint: () => 'https://default.guardian.example',
  getEffectiveNetworkName: () => 'testnet'
}));

beforeEach(() => {
  useWalletStore.setState({ currentAccount: null });
});

// Same answer as the backend's `resolveGuardianEndpoint`, which `initiate` stamps
// as `previousGuardianEndpoint`. Stopping at '' made the current provider read
// "Unknown" and let the same-endpoint guards compare against ''.
it('falls back to the effective default endpoint when the account names none', () => {
  const { result } = renderHook(() => useCurrentGuardianEndpoint());

  expect(result.current.endpoint).toBe('https://default.guardian.example');
});

it('uses the per-account guardianEndpoint', () => {
  useWalletStore.setState({
    currentAccount: {
      publicKey: '0xabc',
      name: 'Guardian Account',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      authScheme: 'ecdsa',
      guardianEndpoint: 'https://switched.guardian'
    }
  });
  const { result } = renderHook(() => useCurrentGuardianEndpoint());

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

// A stored endpoint can be a host-case spelling of a built-in's literal (typed
// by a user, or written by an older build); it must still resolve to that
// built-in, the same way RotateGuardian and ChooseGuardian compare endpoints.
it('matches a host-case spelling of a built-in endpoint', () => {
  expect(guardianOptionForEndpoint('https://Test.Guardian.Example')?.name).toBe('Guardian One');
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
