/** @jest-environment node */
import { mainnetOneClickPriceId } from '../playwright/e2e/helpers/mainnet-one-click-prices';
import type { OneClickAsset, OneClickMidenAssetConfig } from '../src/lib/one-click/types';

const verifiedNative: OneClickMidenAssetConfig = {
  assetId: 'nep141:miden-0xe69e6ca6e39df1b10c1e5399399feb.omft.near',
  faucetId: '0xe69e6ca6e39df1b10c1e5399399feb',
  decimals: 6
};
function native(): OneClickAsset {
  return { ...verifiedNative, blockchain: 'miden', symbol: 'USDCX', coingeckoId: 'usdcx' };
}
it('prices the verified native identity using its USD-coin backing without changing the provider asset', () => {
  const asset = native();
  expect(mainnetOneClickPriceId(asset, verifiedNative)).toBe('usd-coin');
  expect(asset.coingeckoId).toBe('usdcx');
  expect(asset.assetId).toBe(verifiedNative.assetId);
});
it('does not map a different USDCX ticker to the verified native backing', () => {
  const asset = { ...native(), assetId: 'nep141:miden-other.omft.near', coingeckoId: 'another-price-id' };
  expect(mainnetOneClickPriceId(asset, verifiedNative)).toBe('another-price-id');
});
it.each([{ faucetId: '0x000000000000000000000000000001' }, { decimals: 8 }, { blockchain: 'arb' }])(
  'rejects conflicting metadata under the verified native id: %j',
  changed => {
    expect(() => mainnetOneClickPriceId({ ...native(), ...changed }, verifiedNative)).toThrow();
  }
);
it('preserves independently priced USDT0 identity rather than replacing it by ticker', () => {
  const asset: OneClickAsset = {
    assetId: 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near',
    blockchain: 'arb',
    symbol: 'USDT0',
    decimals: 6,
    coingeckoId: 'usdt0'
  };
  expect(mainnetOneClickPriceId(asset, verifiedNative)).toBe('usdt0');
});
