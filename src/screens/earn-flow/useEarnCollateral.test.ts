import { act, renderHook, waitFor } from '@testing-library/react';

import { TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import {
  getNativeAssetMetadata,
  getNativeAssetMetadataSync,
  type NativeAssetChainMetadata
} from 'lib/miden-chain/native-asset';

import { useEarnCollateral } from './useEarnCollateral';

const mockId = '0x4cbdcaffe75f0a317482224dae6436';
const USDCX: NativeAssetChainMetadata = { symbol: 'USDCX', decimals: 6 };
const NATIVE_COLLATERAL = { faucetId: mockId, symbol: 'USDCx', decimals: 6 };
const mockNativeListeners = new Set<() => void>();
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => mockId }));
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => TEST_BRIDGE_CONFIG_SNAPSHOT
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => 'https://rpc.testnet.miden.io' }));
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
});

it('waits for real native metadata and re-renders when the module adopts it', async () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  jest.mocked(getNativeAssetMetadata).mockImplementation(async () => {
    await Promise.resolve();
    adoptMetadata(USDCX);
    return USDCX;
  });
  const { result } = renderHook(() => useEarnCollateral());
  expect(result.current).toBeNull();
  await waitFor(() => expect(result.current).toEqual(NATIVE_COLLATERAL));
});

it('keeps native collateral unavailable when metadata fails instead of spending the legacy token', async () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  jest.mocked(getNativeAssetMetadata).mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useEarnCollateral());
  await act(async () => {});
  expect(result.current).toBeNull();
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
      return useEarnCollateral();
    });
    await advance(0);
    const settledRenders = renders;
    const settledReads = jest.mocked(getNativeAssetMetadata).mock.calls.length;

    await advance(30_000);

    expect(renders).toBe(settledRenders);
    expect(getNativeAssetMetadata).toHaveBeenCalledTimes(settledReads);
    expect(result.current).toEqual(NATIVE_COLLATERAL);
  });

  it('asks again every 30 s while the metadata is missing and re-renders when it changes', async () => {
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
    jest.mocked(getNativeAssetMetadata).mockResolvedValue(null);
    const { result } = renderHook(() => useEarnCollateral());
    await advance(0);
    expect(getNativeAssetMetadata).toHaveBeenCalledTimes(1);

    await advance(30_000);
    expect(getNativeAssetMetadata).toHaveBeenCalledTimes(2);
    expect(result.current).toBeNull();

    act(() => adoptMetadata(USDCX));
    expect(result.current).toEqual(NATIVE_COLLATERAL);

    await advance(60_000);
    expect(getNativeAssetMetadata).toHaveBeenCalledTimes(2);
  });
});
