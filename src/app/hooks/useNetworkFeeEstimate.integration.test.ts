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
const mockAssetsMetadata: Record<string, unknown> = {
  'legacy-display-faucet': { symbol: 'DISPLAY', name: 'Display', decimals: 8 }
};
jest.mock('lib/store', () => ({
  useWalletStore: (select: (state: { assetsMetadata: Record<string, unknown> }) => unknown) =>
    select({
      assetsMetadata: mockAssetsMetadata
    })
}));
jest.mock('lib/miden/front', () => ({ MIDEN_METADATA: { symbol: 'MIDEN', decimals: 6 } }));
jest.mock('lib/platform', () => ({ isExtension: () => false, isMobile: () => false }));

beforeEach(() => {
  delete mockAssetsMetadata['actual-fee-faucet'];
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

it('withholds the fresh provisional fee until chain decimals resolve', () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  const { result, rerender } = renderHook(() => useNetworkFeeEstimate());
  expect(result.current).toBeUndefined();
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
  rerender();
  expect(result.current).toBe('0.00021 USDCX');
});

it('does not format a guessed fee from generic actual-native MIDEN branding', () => {
  mockAssetsMetadata['actual-fee-faucet'] = { symbol: 'MIDEN', name: 'Miden', decimals: 8 };
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  const { result } = renderHook(() => useNetworkFeeEstimate());
  expect(result.current).toBeUndefined();
});

it('keeps an unknown USDCX scale separate from its unit quote', () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6, scaleIsUnknown: true });
  const { result } = renderHook(() => useNetworkFeeEstimate());
  expect(result.current).toBeUndefined();
});
