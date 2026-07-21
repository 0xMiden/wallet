/**
 * Coverage tests for `lib/miden-chain/faucet.ts`.
 *
 * `getFaucetUrl` resolves a network id to its faucet endpoint, falling back to
 * the DEFAULT_NETWORK endpoint when the id is unknown. `./constants` pulls in
 * `@miden-sdk/miden-sdk/lazy`, which jest's moduleNameMapper redirects to the
 * repo's wasm mock — so no additional mocking is required here.
 */
import { DEFAULT_NETWORK, MIDEN_FAUCET_ENDPOINTS, MIDEN_NETWORK_NAME } from './constants';
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

  describe('getFaucetUrl — unknown networks (fallback branch)', () => {
    const fallback = MIDEN_FAUCET_ENDPOINTS.get(DEFAULT_NETWORK)!;

    it('falls back to the DEFAULT_NETWORK endpoint for an unmapped id', () => {
      expect(getFaucetUrl('does-not-exist')).toBe(fallback);
    });

    it('falls back for mainnet, which has no faucet endpoint configured', () => {
      // MAINNET is a valid network name but is intentionally absent from
      // MIDEN_FAUCET_ENDPOINTS, so it must exercise the nullish-coalescing fallback.
      expect(MIDEN_FAUCET_ENDPOINTS.has(MIDEN_NETWORK_NAME.MAINNET)).toBe(false);
      expect(getFaucetUrl(MIDEN_NETWORK_NAME.MAINNET)).toBe(fallback);
    });

    it('falls back for empty-string and arbitrary junk ids', () => {
      expect(getFaucetUrl('')).toBe(fallback);
      expect(getFaucetUrl('🙃 not a network')).toBe(fallback);
    });

    it('fallback endpoint is a non-empty string', () => {
      expect(typeof fallback).toBe('string');
      expect(fallback.length).toBeGreaterThan(0);
    });
  });
});
