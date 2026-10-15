/**
 * Coverage tests for `lib/miden-chain/faucet.ts`.
 *
 * `getFaucetUrl` resolves a network id to its faucet endpoint, and to none for a
 * network without a faucet (mainnet) or an unknown id. `./constants` pulls in
 * `@miden-sdk/miden-sdk/lazy`, which jest's moduleNameMapper redirects to the
 * repo's wasm mock — so no additional mocking is required here.
 */
import { MIDEN_FAUCET_ENDPOINTS, MIDEN_NETWORK_NAME } from './constants';
import { getFaucetUrl } from './faucet';

describe('miden-chain/faucet', () => {
  it('exports getFaucetUrl as a function', () => {
    expect(typeof getFaucetUrl).toBe('function');
  });

  describe('getFaucetUrl — known networks (map hit branch)', () => {
    it('returns the testnet faucet endpoint', () => {
      expect(getFaucetUrl(MIDEN_NETWORK_NAME.TESTNET)).toBe('https://faucet.testnet.miden.io');
      expect(getFaucetUrl(MIDEN_NETWORK_NAME.TESTNET)).toBe(MIDEN_FAUCET_ENDPOINTS.get(MIDEN_NETWORK_NAME.TESTNET));
    });

    it('returns the devnet faucet endpoint', () => {
      expect(getFaucetUrl(MIDEN_NETWORK_NAME.DEVNET)).toBe('https://faucet.devnet.miden.io');
    });

    it('returns the localnet faucet endpoint', () => {
      expect(getFaucetUrl(MIDEN_NETWORK_NAME.LOCALNET)).toBe('http://localhost:8080');
    });

    it('resolves every configured endpoint by its key', () => {
      for (const [networkId, url] of MIDEN_FAUCET_ENDPOINTS.entries()) {
        expect(getFaucetUrl(networkId)).toBe(url);
      }
    });
  });

  describe('getFaucetUrl - networks without a faucet', () => {
    it('resolves no faucet for mainnet, never another network faucet', () => {
      expect(MIDEN_FAUCET_ENDPOINTS.has(MIDEN_NETWORK_NAME.MAINNET)).toBe(false);
      expect(getFaucetUrl(MIDEN_NETWORK_NAME.MAINNET)).toBeUndefined();
    });

    it.each<[string]>([['does-not-exist'], [''], ['🙃 not a network']])('resolves no faucet for the id %j', id => {
      expect(getFaucetUrl(id)).toBeUndefined();
    });
  });
});
