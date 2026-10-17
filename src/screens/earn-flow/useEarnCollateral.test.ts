import { act, renderHook, waitFor } from '@testing-library/react';

import { TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import { getNativeAssetMetadata, getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';

import { useEarnCollateral } from './useEarnCollateral';

const mockId = '0x4cbdcaffe75f0a317482224dae6436';
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => mockId }));
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => TEST_BRIDGE_CONFIG_SNAPSHOT
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => 'https://rpc.testnet.miden.io' }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => mockId,
  getNativeAssetMetadataSync: jest.fn(),
  getNativeAssetMetadata: jest.fn()
}));

it('waits for real native metadata and re-renders when the read completes', async () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  jest.mocked(getNativeAssetMetadata).mockImplementation(async () => {
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
    return { symbol: 'USDCX', decimals: 6 };
  });
  const { result } = renderHook(() => useEarnCollateral());
  expect(result.current).toBeNull();
  await waitFor(() => expect(result.current).toEqual({ faucetId: mockId, symbol: 'USDCx', decimals: 6 }));
});

it('keeps native collateral unavailable when metadata fails instead of spending the legacy token', async () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  jest.mocked(getNativeAssetMetadata).mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useEarnCollateral());
  await act(async () => {});
  expect(result.current).toBeNull();
});
