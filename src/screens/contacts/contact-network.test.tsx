import { act, renderHook } from '@testing-library/react';

import { contactNetwork, useContactBridgeNetworks } from './contact-network';

let mockNetwork = 'mainnet';
const mockListeners = new Set<() => void>();
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));
jest.mock('lib/remote-config/runtime', () => ({
  subscribeBridgeConfig: (listener: () => void) => {
    mockListeners.add(listener);
    return () => mockListeners.delete(listener);
  }
}));
jest.mock('utils/miden', () => ({
  detectAddressChain: (address: string) => (address.startsWith('0x') ? 'ethereum' : 'miden')
}));

beforeEach(() => {
  mockNetwork = 'mainnet';
});

it('offers every production external chain on Mainnet', () => {
  const { result } = renderHook(() => useContactBridgeNetworks());
  expect(result.current.map(network => network.id)).toEqual(['ethereum', 'base', 'arbitrum', 'arc', 'optimism']);
});

it.each(['testnet', 'devnet', 'localnet'])('keeps test-chain choices on %s', network => {
  mockNetwork = network;
  const { result } = renderHook(() => useContactBridgeNetworks());
  expect(result.current.map(network => network.id)).toEqual([
    'sepolia',
    'arc-testnet',
    'base-sepolia',
    'arbitrum-sepolia'
  ]);
});

it('updates choices when the effective network changes without a remount', () => {
  const { result } = renderHook(() => useContactBridgeNetworks());
  act(() => {
    mockNetwork = 'testnet';
    mockListeners.forEach(listener => listener());
  });
  expect(result.current.map(network => network.id)).toEqual([
    'sepolia',
    'arc-testnet',
    'base-sepolia',
    'arbitrum-sepolia'
  ]);
  act(() => {
    mockNetwork = 'mainnet';
    mockListeners.forEach(listener => listener());
  });
  expect(result.current.map(network => network.id)).toEqual(['ethereum', 'base', 'arbitrum', 'arc', 'optimism']);
});

it('retains a saved test-chain contact on Mainnet without offering other test chains', () => {
  const { result } = renderHook(() => useContactBridgeNetworks('base-sepolia'));
  expect(result.current.map(network => network.id)).toEqual([
    'base-sepolia',
    'ethereum',
    'base',
    'arbitrum',
    'arc',
    'optimism'
  ]);
  expect(contactNetwork('0xsynthetic', 'base-sepolia').bridgeNetwork?.id).toBe('base-sepolia');
});

it('retains a saved production contact on Testnet', () => {
  mockNetwork = 'testnet';
  const { result } = renderHook(() => useContactBridgeNetworks('ethereum'));
  expect(result.current.map(network => network.id)).toEqual([
    'sepolia',
    'arc-testnet',
    'base-sepolia',
    'arbitrum-sepolia',
    'ethereum'
  ]);
});

it('keeps legacy default resolution and Miden contacts unchanged', () => {
  expect(contactNetwork('0xsynthetic').bridgeNetwork?.id).toBe('ethereum');
  expect(contactNetwork('mm1synthetic', 'sepolia')).toEqual({ kind: 'miden' });
  const { result } = renderHook(() => useContactBridgeNetworks('unknown'));
  expect(result.current.map(network => network.id)).toEqual(['ethereum', 'base', 'arbitrum', 'arc', 'optimism']);
});
