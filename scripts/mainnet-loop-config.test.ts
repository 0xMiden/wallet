/** @jest-environment node */
import { qualifyMainnetLoopConfig } from '../playwright/e2e/helpers/mainnet-loop-config';

const native = 'mm1arnfum9xuwwlrvgvrefejwvlavn3vk24';
const hex = '0xe69e6ca6e39df1b10c1e5399399feb';
const usdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const nativeAsset = `nep141:miden-${hex}.omft.near`;
const evmAsset = `nep141:arb-${usdc}.omft.near`;
jest.mock('@miden-sdk/miden-sdk', () => ({
  Address: {
    fromBech32: (value: string) => {
      if (value !== 'mm1arnfum9xuwwlrvgvrefejwvlavn3vk24') throw new Error('Invalid test address');
      return { accountId: () => ({ toString: () => '0xe69e6ca6e39df1b10c1e5399399feb' }) };
    }
  }
}));
const document = () => ({
  network: 'mainnet',
  version: 18,
  features: { nearIntents: false, bridgeIn: true },
  swap: { etaUrl: 'https://solver.example' },
  'bridge-providers': { epoch: { allocatorUrl: 'https://mainnet-api.epochprotocol.xyz' } },
  supportedEvmChains: {
    arbitrum: { chainId: 42161, bridges: { usdcx: { tokens: { USDC: { contractAddress: usdc } } } } }
  }
});
const tokens = () => ({ tokens: [{ network: 'mainnet', symbol: 'USDCX', faucetId: native, decimals: 6 }] });
const catalog = () => [
  { assetId: nativeAsset, blockchain: 'miden', symbol: 'USDCX', decimals: 6, contractAddress: hex },
  { assetId: evmAsset, blockchain: 'arb', symbol: 'USDC', decimals: 6, contractAddress: usdc }
];

describe('nightly-only mainnet NEAR configuration', () => {
  it('rejects an insecure provider rather than replacing its URL silently', () => {
    const original = document();
    const unsafe = { ...original, swap: { ...original.swap, oneClick: { serviceUrl: 'http://insecure.example' } } };
    expect(() => qualifyMainnetLoopConfig(unsafe, catalog(), tokens())).toThrow();
  });
  it('preserves explicitly configured provider fees and the real HTTPS service', () => {
    const original = document();
    const oneClick = { serviceUrl: 'https://1click.chaindefuser.com', appFees: [{ recipient: 'configured.near', fee: 20 }] };
    expect(qualifyMainnetLoopConfig({ ...original, swap: { ...original.swap, oneClick } }, catalog(), tokens()))
      .toMatchObject({ swap: { oneClick } });
  });
  it('enables real NEAR bindings without mutating the public document or unrelated routes', () => {
    const original = document();
    const before = structuredClone(original);
    expect(qualifyMainnetLoopConfig(original, catalog(), tokens())).toEqual({
      ...before,
      features: { ...before.features, nearIntents: true },
      swap: {
        ...before.swap,
        oneClick: {
          serviceUrl: 'https://1click.chaindefuser.com',
          midenAssets: [{ assetId: nativeAsset, faucetId: native, decimals: 6 }],
          evmAssets: [
            { assetId: evmAsset, blockchain: 'arb', chainId: 42161, contractAddress: usdc, decimals: 6, symbol: 'USDC' }
          ]
        }
      }
    });
    expect(original).toEqual(before);
  });
  it.each([
    { ...document(), network: 'testnet' },
    { ...document(), version: 0 },
    { ...document(), supportedEvmChains: {} }
  ])('refuses an invalid or unsupported mainnet document %#', doc => {
    expect(() => qualifyMainnetLoopConfig(doc, catalog(), tokens())).toThrow();
  });
  it('requires an unambiguous verified native faucet and exact live asset identity', () => {
    expect(() => qualifyMainnetLoopConfig(document(), catalog(), { tokens: [] })).toThrow();
    expect(() =>
      qualifyMainnetLoopConfig(document(), catalog(), { tokens: [...tokens().tokens, ...tokens().tokens] })
    ).toThrow();
    expect(() =>
      qualifyMainnetLoopConfig(document(), [{ ...catalog()[0], assetId: 'fake' }, catalog()[1]], tokens())
    ).toThrow();
    expect(() =>
      qualifyMainnetLoopConfig(document(), [{ ...catalog()[0], decimals: 8 }, catalog()[1]], tokens())
    ).toThrow();
    expect(() => qualifyMainnetLoopConfig(document(), [...catalog(), catalog()[0]], tokens())).toThrow();
  });
  it('does not trust an EVM symbol or decimals without the published contract binding', () => {
    expect(() =>
      qualifyMainnetLoopConfig(
        document(),
        [catalog()[0], { ...catalog()[1], contractAddress: `0x${'1'.repeat(40)}` }],
        tokens()
      )
    ).toThrow();
    expect(() =>
      qualifyMainnetLoopConfig(document(), [catalog()[0], { ...catalog()[1], decimals: 18 }], tokens())
    ).toThrow();
  });
});
