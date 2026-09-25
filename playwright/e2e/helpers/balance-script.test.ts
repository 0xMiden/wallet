import { buildBalanceTotalScript } from './balance-script';

/**
 * Runs the emitted body the way `cdp.eval` does, so these cases exercise the real script rather
 * than a description of it. The three rows are the point: one symbol on the row, one reachable
 * only through `assetsMetadata`, one foreign. A fixture where every row carries its own metadata
 * passes with or without the fallback and so proves nothing.
 */
function runScript(script: string, state: unknown): number {
  (globalThis as { __TEST_STORE__?: unknown }).__TEST_STORE__ = { getState: () => state };
  try {
    return new Function(script)() as number;
  } finally {
    Reflect.deleteProperty(globalThis, '__TEST_STORE__');
  }
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

it('counts a row whose symbol is reachable only through assetsMetadata', () => {
  expect(runScript(buildBalanceTotalScript('TST'), state)).toBe(15);
});

it('totals every asset when no symbol is requested', () => {
  expect(runScript(buildBalanceTotalScript(), state)).toBe(18);
});

it('excludes a foreign faucet that shares neither symbol', () => {
  expect(runScript(buildBalanceTotalScript('FOREIGN'), state)).toBe(3);
});

it('matches the symbol case-insensitively', () => {
  expect(runScript(buildBalanceTotalScript('tst'), state)).toBe(15);
});

it('answers 0 when the store is absent rather than throwing', () => {
  expect(new Function(buildBalanceTotalScript('TST'))()).toBe(0);
});
