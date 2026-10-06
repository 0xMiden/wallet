import { getNativeAssetMetadata, getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';

import { MIDEN_METADATA, DEFAULT_TOKEN_METADATA } from './defaults';
import { getNativeDisplayMetadata, getNativeDisplayMetadataSync, nativeDisplayMetadata } from './native';
import { hasKnownScale } from './scale';

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => 'fee-native',
  getNativeAssetMetadataSync: jest.fn(() => ({ symbol: 'USDCX', decimals: 8 })),
  getNativeAssetMetadata: jest.fn(async () => ({ symbol: 'USDCX', decimals: 8 }))
}));

it('preserves authoritative symbol and scale over an old branding record', () => {
  expect(getNativeDisplayMetadataSync(MIDEN_METADATA)).toMatchObject({
    symbol: 'USDCX',
    name: 'USDCX',
    decimals: 8,
    scaleIsUnknown: false
  });
});
it('preserves the known metadata of a separate legacy display faucet', () => {
  const display = { name: 'Display', symbol: 'DISPLAY', decimals: 18 };
  expect(getNativeDisplayMetadataSync(display, 'legacy-display')).toBe(display);
});
it('keeps unresolved native scale provisional', () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValueOnce(null);
  expect(hasKnownScale(getNativeDisplayMetadataSync(DEFAULT_TOKEN_METADATA))).toBe(false);
  expect(hasKnownScale(nativeDisplayMetadata({ symbol: 'USDCX', decimals: 6, scaleIsUnknown: true }))).toBe(false);
});
it('retains the existing name of native MIDEN', () => {
  expect(nativeDisplayMetadata({ symbol: 'MIDEN', decimals: 8 }).name).toBe(MIDEN_METADATA.name);
});
it('hydrates chain metadata for an asynchronous caller', async () => {
  await expect(getNativeDisplayMetadata()).resolves.toMatchObject({ symbol: 'USDCX', decimals: 8 });
});
it('keeps asynchronous hydration failure unscaled', async () => {
  jest.mocked(getNativeAssetMetadata).mockRejectedValueOnce(new Error('RPC unavailable'));
  expect(hasKnownScale(await getNativeDisplayMetadata())).toBe(false);
});

it('labels a cold native identity as provisional USDCX until chain metadata resolves', () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValueOnce(null);
  const pending = getNativeDisplayMetadataSync();
  expect(pending).toMatchObject({ symbol: 'USDCX', name: 'USDCX', decimals: 6, scaleIsUnknown: true });
  expect(hasKnownScale(pending)).toBe(false);
  jest.mocked(getNativeAssetMetadataSync).mockReturnValueOnce({ symbol: 'USDCX', decimals: 6 });
  expect(getNativeDisplayMetadataSync()).toMatchObject({ symbol: 'USDCX', decimals: 6, scaleIsUnknown: false });
});

it('does not let generic native branding prove the provisional native scale', () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValueOnce(null);
  const pending = getNativeDisplayMetadataSync({ symbol: 'MIDEN', name: 'Miden', decimals: 8 }, 'fee-native');
  expect(pending).toMatchObject({ symbol: 'USDCX', name: 'USDCX', decimals: 6, scaleIsUnknown: true });
  expect(hasKnownScale(pending)).toBe(false);
});

it('keeps cached foreign MIDEN branding separate from the provisional native asset', () => {
  const foreign = { symbol: 'MIDEN', name: 'Foreign branding', decimals: 4 };
  expect(getNativeDisplayMetadataSync(foreign, 'legacy-display')).toBe(foreign);
  expect(hasKnownScale(foreign)).toBe(true);
});

it('uses provisional USDCX for asynchronous cold metadata', async () => {
  jest.mocked(getNativeAssetMetadata).mockResolvedValueOnce(null);
  const pending = await getNativeDisplayMetadata();
  expect(pending).toMatchObject({ symbol: 'USDCX', name: 'USDCX', decimals: 6, scaleIsUnknown: true });
  expect(hasKnownScale(pending)).toBe(false);
});

it('uses provisional USDCX when asynchronous metadata discovery rejects', async () => {
  jest.mocked(getNativeAssetMetadata).mockRejectedValueOnce(new Error('RPC unavailable'));
  const pending = await getNativeDisplayMetadata();
  expect(pending).toMatchObject({ symbol: 'USDCX', name: 'USDCX', decimals: 6, scaleIsUnknown: true });
  expect(hasKnownScale(pending)).toBe(false);
});
