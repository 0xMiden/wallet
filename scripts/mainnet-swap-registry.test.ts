/** @jest-environment node */
import { cachedSolverRegistry } from '../playwright/e2e/helpers/mainnet-swap-ui';

const USDCX = '0xe69e6ca6e39df1b10c1e5399399feb';
const USDT = '0x5cb79d29507d3ad17bb6dc60279e89';
const config = { body: { network: 'mainnet', version: 3, swap: { etaUrl: 'https://solver.example.com/' } } };
const derived = {
  network: 'mainnet',
  version: 3,
  swap: {
    pairs: {
      state: 'ok',
      value: {
        tokens: [
          { faucetId: USDCX, ticker: 'USDCX', decimals: 6, binanceAsset: 'USDC' },
          { faucetId: USDT, ticker: 'USDT', decimals: 6, binanceAsset: 'USDT' }
        ],
        pairs: [{ name: 'USDCX-USDT', binanceSymbol: 'USDCUSDT', faucetIds: [USDCX, USDT] }]
      }
    }
  }
};
const tokenList = {
  fetchedAt: 1,
  body: { tokens: [{ network: 'mainnet', faucetId: USDT, symbol: 'USDT', decimals: 6 }] }
};

describe('cachedSolverRegistry token list', () => {
  it('reports the registry as not fully hydrated while no token list is cached', () => {
    const registry = cachedSolverRegistry(config, derived, [undefined, undefined]);
    expect(registry.tokenListLoaded).toBe(false);
    expect(registry.priceAssets.size).toBe(0);
  });

  it('reports a cached token list and prices the tokens the wallet feed does not quote', () => {
    const registry = cachedSolverRegistry(config, derived, [undefined, tokenList]);
    expect(registry.tokenListLoaded).toBe(true);
    expect(registry.priceAssets.get(USDT)).toBe('USDT');
  });

  it('does not count an unreadable cached entry as a loaded list', () => {
    expect(cachedSolverRegistry(config, derived, [{ fetchedAt: 1, body: { tokens: 'nope' } }]).tokenListLoaded).toBe(
      false
    );
  });
});
