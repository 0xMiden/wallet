/** @jest-environment node */
import { canonicalMainnetLoopFaucet, qualifyMainnetLoopConfig } from '../playwright/e2e/helpers/mainnet-loop-config';
import { parseBridgeConfig } from '../src/lib/remote-config/schema';

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
    arbitrum: { chainId: 42161, bridges: { epoch: { depositEnabled: true, withdrawalEnabled: true, tokens: { USDC: { contractAddress: usdc } } } } }
  }
});
const tokens = () => ({ tokens: [{ network: 'mainnet', symbol: 'USDCX', faucetId: native, decimals: 6 }] });
const catalog = () => [
  { assetId: nativeAsset, blockchain: 'miden', symbol: 'USDCX', decimals: 6, contractAddress: hex },
  { assetId: evmAsset, blockchain: 'arb', symbol: 'USDC', decimals: 6, contractAddress: usdc }
];

describe('mainnet faucet identity across config and wallet-cache formats', () => {
  it.each([native, `${native}_qr7qqq9wr6w`, hex])('uses one canonical identity for %s', id => {
    expect(canonicalMainnetLoopFaucet(id)).toBe(hex);
  });
  it.each(['mtst1other', ` ${native}`, '0x123'])('rejects an invalid or other-network reference: %s', id => {
    expect(() => canonicalMainnetLoopFaucet(id)).toThrow();
  });
});

describe('nightly-only mainnet NEAR configuration', () => {
  it('produces a production-parseable overlay from the published Bech32 token-list identity', () => {
    const published = {
      ...document(),
      supportedEvmChains: {
        arbitrum: {
          chainId: 42161,
          bridges: {
            epoch: {
              depositEnabled: true,
              withdrawalEnabled: true,
              tokens: { USDC: { contractAddress: usdc } }
            }
          }
        }
      }
    };
    expect(parseBridgeConfig(published, 'mainnet')).not.toBeNull();
    const snapshot = qualifyMainnetLoopConfig(published, catalog(), tokens());
    expect(parseBridgeConfig(snapshot, 'mainnet')?.nearIntents).toEqual({
      serviceUrl: 'https://1click.chaindefuser.com',
      midenAssets: [{ id: 'usdcx', assetId: nativeAsset, faucetId: hex, decimals: 6 }],
      chains: [
        {
          id: 'arb',
          name: 'Arbitrum',
          addressKind: 'evm',
          tokens: [{ symbol: 'USDC', assetId: evmAsset, decimals: 6, contractAddress: usdc, miden: ['usdcx'] }]
        }
      ]
    });
  });
  it.each(['http://insecure.example', 'http://localhost:8787', 'https://user@1click.example'])(
    'rejects an insecure provider rather than replacing its URL silently: %s',
    serviceUrl => {
      const unsafe = { ...document(), nearIntents: { serviceUrl } };
      expect(() => qualifyMainnetLoopConfig(unsafe, catalog(), tokens())).toThrow();
    }
  );
  it('keeps a published HTTPS provider and ignores the retired swap.oneClick section', () => {
    const published = {
      ...document(),
      swap: { etaUrl: 'https://solver.example', oneClick: { serviceUrl: 'http://insecure.example' } },
      nearIntents: { serviceUrl: 'https://proxy.example' }
    };
    const snapshot = parseBridgeConfig(qualifyMainnetLoopConfig(published, catalog(), tokens()), 'mainnet');
    expect(snapshot?.nearIntents?.serviceUrl).toBe('https://proxy.example');
  });
  it('writes no fee fields: fees are set up on the partner key', () => {
    const snapshot = qualifyMainnetLoopConfig(document(), catalog(), tokens());
    expect(JSON.stringify(snapshot)).not.toMatch(/appFees|feePolicy/);
  });
  it('keys each token by its live symbol and maps a published USDT to a live USDT0', () => {
    const usdt = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
    const published = {
      ...document(),
      supportedEvmChains: {
        ...document().supportedEvmChains,
        arbitrum: {
          chainId: 42161,
          bridges: { epoch: { depositEnabled: true, withdrawalEnabled: true, tokens: { USDC: { contractAddress: usdc }, USDT: { contractAddress: usdt } } } }
        },
        ethereum: {
          chainId: 1,
          bridges: { epoch: { depositEnabled: true, withdrawalEnabled: true, tokens: { USDC: { contractAddress: `0x${'a'.repeat(40)}` } } } }
        }
      }
    };
    const live = [
      ...catalog(),
      { assetId: `nep141:arb-${usdt}.omft.near`, blockchain: 'arb', symbol: 'USDT0', decimals: 6, contractAddress: usdt },
      {
        assetId: `nep141:eth-0x${'a'.repeat(40)}.omft.near`,
        blockchain: 'eth',
        symbol: 'USDC',
        decimals: 6,
        contractAddress: `0x${'a'.repeat(40)}`
      }
    ];
    const parsed = parseBridgeConfig(qualifyMainnetLoopConfig(published, live, tokens()), 'mainnet');
    expect(parsed?.nearIntents?.chains.map(chain => [chain.id, chain.name, chain.tokens.map(t => t.symbol)])).toEqual([
      ['eth', 'Ethereum', ['USDC']],
      ['arb', 'Arbitrum', ['USDC', 'USDT0']]
    ]);
    expect(parsed?.nearIntents?.chains[1]?.tokens[1]).toMatchObject({ assetId: `nep141:arb-${usdt}.omft.near` });
  });
  it('enables real NEAR bindings without mutating the public document or unrelated routes', () => {
    const original = document();
    const before = structuredClone(original);
    expect(qualifyMainnetLoopConfig(original, catalog(), tokens())).toEqual({
      ...before,
      features: { ...before.features, nearIntents: true },
      nearIntents: {
        serviceUrl: 'https://1click.chaindefuser.com',
        midenAssets: { usdcx: { assetId: nativeAsset, faucetId: hex, decimals: 6 } },
        chains: {
          arb: {
            name: 'Arbitrum',
            addressKind: 'evm',
            tokens: { USDC: { assetId: evmAsset, decimals: 6, contractAddress: usdc, miden: ['usdcx'] } }
          }
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
