import { renderHook } from '@testing-library/react';

import { getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';

import { useNetworkFeeEstimate } from './useNetworkFeeEstimate';
import useVerificationBaseFee from './useVerificationBaseFee';
jest.unmock('lib/i18n/numbers');

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => 'actual-fee-faucet',
  getNativeAssetMetadataSync: jest.fn(() => ({ symbol: 'USDCX', decimals: 6 }))
}));
jest.mock('./useVerificationBaseFee', () => ({ __esModule: true, default: jest.fn(() => 7) }));
jest.mock('./useNativeFeeFaucetId', () => ({ __esModule: true, default: () => 'actual-fee-faucet' }));
jest.mock('lib/store', () => ({
  useWalletStore: (select: (state: { assetsMetadata: Record<string, unknown> }) => unknown) =>
    select({
      assetsMetadata: { 'legacy-display-faucet': { symbol: 'DISPLAY', name: 'Display', decimals: 8 } }
    })
}));
jest.mock('lib/miden/front', () => ({ MIDEN_METADATA: { symbol: 'MIDEN', decimals: 6 } }));
jest.mock('lib/platform', () => ({ isExtension: () => false, isMobile: () => false }));

beforeEach(() => {
  jest.mocked(useVerificationBaseFee).mockReturnValue(7);
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
});

it('uses real native metadata resolution and formatting for the devnet fee reserve', () => {
  const { result } = renderHook(() => useNetworkFeeEstimate());
  expect(result.current).toBe('0.00021 USDCX');
});

it('uses authoritative non-six scale rather than the legacy display override', () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 8 });
  const { result } = renderHook(() => useNetworkFeeEstimate());
  expect(result.current).toBe('0.0000021 USDCX');
});

it.each([null, 0])('omits a fee for base fee %s', baseFee => {
  jest.mocked(useVerificationBaseFee).mockReturnValue(baseFee);
  const { result } = renderHook(() => useNetworkFeeEstimate());
  expect(result.current).toBeUndefined();
});

it('omits the amount while authoritative native decimals are unresolved', () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  const { result } = renderHook(() => useNetworkFeeEstimate());
  expect(result.current).toBeUndefined();
});
