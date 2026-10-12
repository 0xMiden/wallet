import { act, renderHook, waitFor } from '@testing-library/react';

import { isAgglayerFaucetAllowed } from 'lib/agglayer/allowed-faucets';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { useAgglayerEligibility } from './useAgglayerEligibility';

let mockRpcUrl = '';
jest.mock('lib/agglayer/allowed-faucets', () => ({ isAgglayerFaucetAllowed: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => mockRpcUrl
}));

const configNaming = (midenBridge: string): BridgeConfigSnapshot => ({
  network: 'testnet',
  status: 'ready',
  config: {
    network: 'testnet',
    version: 1,
    evm: {},
    agglayer: { midenBridge },
    epoch: {},
    features: { earn: false, fastBridge: false, bridgeIn: true, bridgeOut: true }
  },
  derived: null,
  lastFetch: null
});
const BRIDGE = '0x3b66e20b5088f25133b69216484652';
const LOADING: BridgeConfigSnapshot = {
  network: 'testnet',
  status: 'loading',
  config: null,
  derived: null,
  lastFetch: null
};
let mockConfigSnapshot = configNaming(BRIDGE);
const mockConfigListeners = new Set<() => void>();
const publishConfig = (next: BridgeConfigSnapshot) => {
  mockConfigSnapshot = next;
  mockConfigListeners.forEach(listener => listener());
};
jest.mock('lib/remote-config/use-feature-availability', () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react');
  const subscribe = (listener: () => void) => {
    mockConfigListeners.add(listener);
    return () => {
      mockConfigListeners.delete(listener);
    };
  };
  return { useBridgeConfigSnapshot: () => useSyncExternalStore(subscribe, () => mockConfigSnapshot) };
});

beforeEach(() => {
  jest.resetAllMocks();
  mockRpcUrl = 'https://rpc.testnet.miden.io';
  mockConfigSnapshot = configNaming(BRIDGE);
});

it('turns allowed once a config naming the bridge loads, whatever a check before it found', async () => {
  publishConfig(LOADING);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.mocked(isAgglayerFaucetAllowed).mockImplementation(async () => {
    if (!mockConfigSnapshot.config?.agglayer.midenBridge) {
      throw new Error('The bridge config has no usable agglayer.midenBridge.');
    }
    return true;
  });
  const { result } = renderHook(() => useAgglayerEligibility('token'));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  act(() => publishConfig(configNaming(BRIDGE)));
  await waitFor(() => expect(result.current).toBe('allowed'));
  warn.mockRestore();
});

it('reports loading and asks no registry while the config names no bridge', async () => {
  publishConfig(LOADING);
  jest.mocked(isAgglayerFaucetAllowed).mockResolvedValue(true);
  const { result } = renderHook(() => useAgglayerEligibility('token'));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(result.current).toBe('loading');
  expect(isAgglayerFaucetAllowed).not.toHaveBeenCalled();
});

it.each<[string, BridgeConfigSnapshot]>([
  ['no config', { ...configNaming(BRIDGE), config: null }],
  ['a config without a bridge', { ...configNaming(BRIDGE), config: { ...configNaming(BRIDGE).config!, agglayer: {} } }]
])('settles as an error, asking no registry, once the snapshot is ready with %s', async (_case, snapshot) => {
  publishConfig(snapshot);
  jest.mocked(isAgglayerFaucetAllowed).mockResolvedValue(true);
  const { result } = renderHook(() => useAgglayerEligibility('token'));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(result.current).toBe('error');
  expect(isAgglayerFaucetAllowed).not.toHaveBeenCalled();
});

it('asks again, showing loading, once the config moves the bridge', async () => {
  const pending = new Promise<boolean>(() => {});
  jest.mocked(isAgglayerFaucetAllowed).mockResolvedValueOnce(true).mockReturnValueOnce(pending);
  const { result } = renderHook(() => useAgglayerEligibility('token'));
  await waitFor(() => expect(result.current).toBe('allowed'));
  act(() => publishConfig(configNaming('0x537c15a622074e91188aa894456c52')));
  expect(result.current).toBe('loading');
  expect(isAgglayerFaucetAllowed).toHaveBeenCalledTimes(2);
});

it('shows loading, then allows an approved token', async () => {
  jest.mocked(isAgglayerFaucetAllowed).mockResolvedValue(true);
  const { result } = renderHook(() => useAgglayerEligibility('token'));
  expect(result.current).toBe('loading');
  await waitFor(() => expect(result.current).toBe('allowed'));
});

it('blocks an unregistered token', async () => {
  jest.mocked(isAgglayerFaucetAllowed).mockResolvedValue(false);
  const { result } = renderHook(() => useAgglayerEligibility('token'));
  await waitFor(() => expect(result.current).toBe('unsupported'));
});

it('blocks a failed read', async () => {
  const failure = new Error('RPC unavailable');
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.mocked(isAgglayerFaucetAllowed).mockRejectedValue(failure);
  const { result } = renderHook(() => useAgglayerEligibility('token'));
  await waitFor(() => expect(result.current).toBe('error'));
  expect(warn.mock.calls.map(call => call[call.length - 1])).toContain(failure);
  warn.mockRestore();
});

it('does not apply an old approval to a newly selected token', async () => {
  let approveOldToken = (_allowed: boolean) => {};
  const oldCheck = new Promise<boolean>(resolve => {
    approveOldToken = resolve;
  });
  jest.mocked(isAgglayerFaucetAllowed).mockReturnValueOnce(oldCheck).mockResolvedValueOnce(false);
  const { result, rerender } = renderHook(({ id }) => useAgglayerEligibility(id), {
    initialProps: { id: 'old-token' }
  });
  rerender({ id: 'new-token' });
  expect(result.current).toBe('loading');
  await waitFor(() => expect(result.current).toBe('unsupported'));
  await act(async () => {
    approveOldToken(true);
    await oldCheck;
  });
  expect(result.current).toBe('unsupported');
});

it('shows loading for a newly selected token after the old one settled (#1276)', async () => {
  const pending = new Promise<boolean>(() => {});
  jest.mocked(isAgglayerFaucetAllowed).mockResolvedValueOnce(true).mockReturnValueOnce(pending);
  const { result, rerender } = renderHook(({ id }) => useAgglayerEligibility(id), {
    initialProps: { id: 'old-token' }
  });
  await waitFor(() => expect(result.current).toBe('allowed'));
  rerender({ id: 'new-token' });
  expect(result.current).toBe('loading');
});

it('shows loading after the endpoint changes (#1276)', async () => {
  const pending = new Promise<boolean>(() => {});
  jest.mocked(isAgglayerFaucetAllowed).mockResolvedValueOnce(true).mockReturnValueOnce(pending);
  const { result, rerender } = renderHook(() => useAgglayerEligibility('token'));
  await waitFor(() => expect(result.current).toBe('allowed'));
  mockRpcUrl = 'https://rpc.other.example';
  rerender();
  expect(result.current).toBe('loading');
});
