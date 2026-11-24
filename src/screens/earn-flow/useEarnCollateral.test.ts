import { act, renderHook, waitFor } from '@testing-library/react';

import { TEST_BRIDGE_CONFIG_SNAPSHOT, TEST_MIDEN_USDC } from 'lib/epoch/testing/bridge-config';
import {
  getNativeAssetMetadata,
  getNativeAssetMetadataSync,
  type NativeAssetChainMetadata
} from 'lib/miden-chain/native-asset';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { useEarnCollateralState } from './useEarnCollateral';

const mockId = '0x4cbdcaffe75f0a317482224dae6436';
const USDCX: NativeAssetChainMetadata = { symbol: 'USDCX', decimals: 6 };
const NATIVE_COLLATERAL = { faucetId: mockId, symbol: 'USDCx', decimals: 6 };
const RESOLVED = { state: 'resolved', collateral: NATIVE_COLLATERAL };
const LOADING = { state: 'loading', collateral: null };
const UNAVAILABLE = { state: 'unavailable', collateral: null };
const mockNativeListeners = new Set<() => void>();
let mockSnapshot: BridgeConfigSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
let mockRpc = 'https://rpc.testnet.miden.io';
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => mockId }));
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => mockSnapshot
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => mockRpc }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => mockId,
  getNativeAssetMetadataSync: jest.fn(),
  getNativeAssetMetadata: jest.fn(),
  onNativeAssetChanged: (listener: () => void) => {
    mockNativeListeners.add(listener);
    return () => {
      mockNativeListeners.delete(listener);
    };
  }
}));

// What native-asset.ts does when it adopts metadata: cache it, then emit on its change channel.
const adoptMetadata = (metadata: NativeAssetChainMetadata) => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(metadata);
  mockNativeListeners.forEach(listener => listener());
};

beforeEach(() => {
  jest.mocked(getNativeAssetMetadataSync).mockReset();
  jest.mocked(getNativeAssetMetadata).mockReset();
  mockSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
  mockRpc = 'https://rpc.testnet.miden.io';
});

it('waits for real native metadata and re-renders when the module adopts it', async () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  jest.mocked(getNativeAssetMetadata).mockImplementation(async () => {
    await Promise.resolve();
    adoptMetadata(USDCX);
    return USDCX;
  });
  const { result } = renderHook(() => useEarnCollateralState());
  expect(result.current).toEqual(LOADING);
  await waitFor(() => expect(result.current).toEqual(RESOLVED));
});

it('stays loading while the first read is in flight', async () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  jest.mocked(getNativeAssetMetadata).mockImplementation(() => new Promise(() => {}));
  const { result } = renderHook(() => useEarnCollateralState());
  await act(async () => {});
  expect(getNativeAssetMetadata).toHaveBeenCalledTimes(1);
  expect(result.current).toEqual(LOADING);
});

it('keeps native collateral unavailable when metadata fails instead of spending the legacy token', async () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  jest.mocked(getNativeAssetMetadata).mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useEarnCollateralState());
  await act(async () => {});
  expect(result.current).toEqual(UNAVAILABLE);
});

it('reads a native asset that is not USDCx as unavailable without asking for it again', async () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'OTHER', decimals: 6 });
  const { result } = renderHook(() => useEarnCollateralState());
  await act(async () => {});
  expect(result.current).toEqual(UNAVAILABLE);
  expect(getNativeAssetMetadata).not.toHaveBeenCalled();
});

it('reads another endpoint afresh after a failed read', async () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  jest.mocked(getNativeAssetMetadata).mockRejectedValue(new Error('offline'));
  const { result, rerender } = renderHook(() => useEarnCollateralState());
  await act(async () => {});
  expect(result.current).toEqual(UNAVAILABLE);

  jest.mocked(getNativeAssetMetadata).mockImplementation(() => new Promise(() => {}));
  mockRpc = 'https://rpc.custom.example';
  rerender();
  await act(async () => {});
  expect(result.current).toEqual(LOADING);
});

describe('off Testnet', () => {
  const devnet: BridgeConfigSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, network: 'devnet' };
  const derived = TEST_BRIDGE_CONFIG_SNAPSHOT.derived;
  if (!derived) throw new Error('The test derivation is missing');

  it.each<[string, BridgeConfigSnapshot]>([
    ['the configured collateral', devnet],
    ['a document still loading', { ...devnet, status: 'loading', config: null, derived: null }],
    ['a document still being derived', { ...devnet, derived: null }],
    [
      'an output faucet that is absent',
      { ...devnet, derived: { ...derived, epoch: { ...derived.epoch, midenUsdcFaucet: { state: 'absent' } } } }
    ]
  ])('spends the native asset, never the document collateral, with %s', (_name, snapshot) => {
    mockSnapshot = snapshot;
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue(USDCX);
    const { result } = renderHook(() => useEarnCollateralState());
    expect(result.current).toEqual(RESOLVED);
    expect(result.current).not.toEqual({ state: 'resolved', collateral: TEST_MIDEN_USDC });
  });

  it('waits for the native metadata off Testnet as it does on it', () => {
    mockSnapshot = devnet;
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
    jest.mocked(getNativeAssetMetadata).mockResolvedValue(null);
    const { result } = renderHook(() => useEarnCollateralState());
    expect(result.current).toEqual(LOADING);
    expect(getNativeAssetMetadata).toHaveBeenCalled();
  });
});

describe('on a fake clock', () => {
  const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('neither re-renders nor reads again once the metadata is known', async () => {
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue(USDCX);
    jest.mocked(getNativeAssetMetadata).mockResolvedValue(USDCX);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useEarnCollateralState();
    });
    await advance(0);
    const settledRenders = renders;
    const settledReads = jest.mocked(getNativeAssetMetadata).mock.calls.length;

    await advance(30_000);

    expect(renders).toBe(settledRenders);
    expect(getNativeAssetMetadata).toHaveBeenCalledTimes(settledReads);
    expect(result.current).toEqual(RESOLVED);
  });

  it('asks again every 30 s while the metadata is missing and re-renders when it changes', async () => {
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
    jest.mocked(getNativeAssetMetadata).mockResolvedValue(null);
    const { result } = renderHook(() => useEarnCollateralState());
    await advance(0);
    expect(getNativeAssetMetadata).toHaveBeenCalledTimes(1);
    // A read that adopted nothing failed as surely as one that threw.
    expect(result.current).toEqual(UNAVAILABLE);

    await advance(30_000);
    expect(getNativeAssetMetadata).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(UNAVAILABLE);

    act(() => adoptMetadata(USDCX));
    expect(result.current).toEqual(RESOLVED);

    await advance(60_000);
    expect(getNativeAssetMetadata).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed read unavailable while the retry 30 s later is still in flight', async () => {
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
    jest.mocked(getNativeAssetMetadata).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useEarnCollateralState());
    await advance(0);
    expect(result.current).toEqual(UNAVAILABLE);

    jest.mocked(getNativeAssetMetadata).mockImplementation(() => new Promise(() => {}));
    await advance(30_000);
    expect(getNativeAssetMetadata).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(UNAVAILABLE);
  });
});
