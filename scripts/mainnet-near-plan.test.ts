/** @jest-environment node */
import type { OneClickAsset } from '../src/lib/one-click/types';
import { selectMainnetNearNativeAsset } from '../playwright/e2e/helpers/mainnet-near-plan';
const native = '0xe69e6ca6e39df1b10c1e5399399feb';
const asset: OneClickAsset = { assetId: `nep141:miden-${native}.omft.near`, blockchain: 'miden', symbol: 'USDCx', decimals: 6,
  faucetId: native, coingeckoId: 'usdcx' };
const unrelated: OneClickAsset = { ...asset, assetId: 'nep141:miden-0x111111111111111111111111111111.omft.near',
  faucetId: '0x111111111111111111111111111111', symbol: 'OTHER' };
it('selects the actual funded native binding rather than the first listed Miden asset', () => {
  expect(selectMainnetNearNativeAsset([unrelated, asset], native, 20000000n, 420n)).toEqual(asset);
});
it('refuses a catalog without the exact native identity rather than falling back to an unfunded first asset', () => {
  expect(() => selectMainnetNearNativeAsset([unrelated], native, 20000000n, 420n)).toThrow();
});
it('refuses duplicate eligible native bindings', () => {
  expect(() => selectMainnetNearNativeAsset([asset, { ...asset }], native, 20000000n, 420n)).toThrow();
});
it('rejects a different faucet even with a copied native asset ID and ticker', () => {
  expect(() => selectMainnetNearNativeAsset([{ ...asset, faucetId: unrelated.faucetId }], native, 20000000n, 420n)).toThrow();
});
it('refuses an unavailable existing principal instead of counting reserved gas as spendable funding', () => {
  expect(() => selectMainnetNearNativeAsset([asset], native, 420n, 420n)).toThrow();
});
it('does not silently trust different native decimals', () => {
  expect(() => selectMainnetNearNativeAsset([{ ...asset, decimals: 18 }], native, 20000000n, 420n)).toThrow();
});
it('does not authorize negative balance or fee facts', () => {
  expect(() => selectMainnetNearNativeAsset([asset], native, -1n, 420n)).toThrow();
  expect(() => selectMainnetNearNativeAsset([asset], native, 20000000n, -1n)).toThrow();
});
