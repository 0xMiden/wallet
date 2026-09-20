import type { Page } from '@playwright/test';

import { vaultBalance } from './balance-truth';

/**
 * Drives the real `page.evaluate` callback against a fake store. The fixture's second row is the
 * point: its symbol is reachable only through `assetsMetadata`, which is how the harness injects
 * metadata for the CLI-deployed faucet every spec trades. `pendingNoteTotal` has always counted
 * that row, so a `vaultBalance` that cannot see it makes a successful claim read as lost value.
 */
function makePage(state: unknown): Page {
  return {
    evaluate: (fn: (arg: { wanted: string }) => unknown, arg: { wanted: string }) => {
      (globalThis as { __TEST_STORE__?: unknown }).__TEST_STORE__ = { getState: () => state };
      try {
        return Promise.resolve(fn(arg));
      } finally {
        Reflect.deleteProperty(globalThis, '__TEST_STORE__');
      }
    }
  } as unknown as Page;
}

const state = {
  balances: {
    'account-a': [
      { tokenId: 'faucet-on-row', balance: 10, metadata: { symbol: 'TST', decimals: 8 } },
      { tokenId: 'faucet-in-cache', balance: 5 },
      { tokenId: 'faucet-foreign', balance: 3, metadata: { symbol: 'FOREIGN', decimals: 8 } }
    ]
  },
  assetsMetadata: {
    'faucet-in-cache': { symbol: 'TST', decimals: 8 },
    'faucet-foreign': { symbol: 'FOREIGN', decimals: 8 }
  }
};

it('counts a vault row whose symbol is reachable only through assetsMetadata', async () => {
  await expect(vaultBalance(makePage(state), 'TST')).resolves.toBe(1_500_000_000n);
});

it('takes decimals from the cache too, so the base-unit round trip stays exact', async () => {
  const cachedOnly = {
    balances: { 'account-a': [{ tokenId: 'faucet-in-cache', balance: 0.125 }] },
    assetsMetadata: { 'faucet-in-cache': { symbol: 'TST', decimals: 8 } }
  };
  await expect(vaultBalance(makePage(cachedOnly), 'TST')).resolves.toBe(12_500_000n);
});

it('excludes a foreign faucet', async () => {
  await expect(vaultBalance(makePage(state), 'FOREIGN')).resolves.toBe(300_000_000n);
});

it('answers 0n for a symbol the wallet does not hold', async () => {
  await expect(vaultBalance(makePage(state), 'NOPE')).resolves.toBe(0n);
});
