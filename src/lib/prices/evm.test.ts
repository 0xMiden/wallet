import { evmPriceSymbolFor, evmQuote } from './evm';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => ({
    config: {
      supportedEvmChains: {
        ethereum: { chainId: 1, bridges: { usdcx: { tokens: { USDC: { contractAddress: '0xaabb' } } } } },
        base: {
          chainId: 8453,
          bridges: { epoch: { tokens: { ETH: { contractAddress: '0x0000000000000000000000000000000000000000' } } } }
        }
      }
    },
    derived: {
      chains: {
        8453: {
          epoch: {
            tokens: { ETH: { state: 'ok', value: { symbol: 'ETH', decimals: 18, midenFaucetId: 'verified-eth' } } }
          }
        },
        1: {
          agglayer: {
            evmNetworkId: { state: 'ok', value: 0 },
            tokens: {
              state: 'ok',
              value: [
                {
                  originToken: '0x0000000000000000000000000000000000000000',
                  midenFaucetId: 'verified-eth',
                  originNetwork: 0
                },
                { originToken: '0xcccc', midenFaucetId: 'unpriced-token', originNetwork: 0 }
              ]
            }
          }
        }
      }
    }
  })
}));
jest.mock('lib/miden/swap/tokens', () => ({
  priceSymbolFor: (id: string) => (id === 'verified-eth' ? 'ETH' : undefined)
}));

describe('EVM quote identity', () => {
  it('matches Circle USDC by configured chain and contract case-insensitively', () => {
    expect(evmPriceSymbolFor(1, '0xAABB')).toBe('USDC');
    expect(evmPriceSymbolFor(2, '0xaabb')).toBeUndefined();
    expect(evmPriceSymbolFor(1, '0xforged')).toBeUndefined();
  });
  it('requires a priced registry faucet for native and arbitrary assets', () => {
    expect(evmPriceSymbolFor(1, '0x0000000000000000000000000000000000000000')).toBe('ETH');
    expect(evmPriceSymbolFor(1, '0xcccc')).toBeUndefined();
    expect(evmPriceSymbolFor(undefined, '0xaabb')).toBeUndefined();
  });
  it("prices an Epoch route's native coin at the zero address as the Miden token it settles into", () => {
    expect(evmPriceSymbolFor(8453, '0x0000000000000000000000000000000000000000')).toBe('ETH');
  });
  it('uses the actual USDC feed instead of assuming a dollar', () => {
    const quote = { price: 0.97, change24h: 0, percentageChange24h: 0, observedAt: Date.now() };
    expect(evmQuote({ USDC: quote }, 1, '0xaabb')).toBe(quote);
    expect(evmQuote({}, 1, '0xaabb')).toBeUndefined();
  });
});
