import { renderHook } from '@testing-library/react';

import { getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';

import { useGasToken } from './useGasToken';

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => 'native-fee',
  getNativeAssetMetadataSync: jest.fn(() => null)
}));
jest.mock('lib/miden/front', () => ({
  MIDEN_METADATA: jest.requireActual('lib/miden/metadata/defaults').MIDEN_METADATA
}));
jest.mock('lib/platform', () => ({ isExtension: () => false }));

beforeEach(() => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
});

it('defaults fresh gas metadata to USDCX without trusting its scale', () => {
  const { result } = renderHook(() => useGasToken());
  expect(result.current).toMatchObject({
    logo: 'misc/token-logos/film.png',
    symbol: 'ф',
    assetName: 'miden',
    isDcpNetwork: true,
    metadata: { symbol: 'USDCX', name: 'USDCX', decimals: 6, scaleIsUnknown: true }
  });
});

it.each([
  { symbol: 'USDCX', decimals: 8, name: 'USDCX' },
  { symbol: 'MIDEN', decimals: 6, name: 'Miden' }
])('uses authoritative $symbol metadata on the next render', metadata => {
  const { result, rerender } = renderHook(() => useGasToken());
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(metadata);
  rerender();
  expect(result.current.metadata).toMatchObject({ ...metadata, scaleIsUnknown: false });
  expect(result.current.assetName).toBe('miden');
});

it('is callable as a plain function and preserves the descriptor fields', () => {
  const first = useGasToken();
  expect(useGasToken()).toEqual(first);
  expect(first.metadata).toMatchObject({ symbol: 'USDCX', scaleIsUnknown: true });
});
