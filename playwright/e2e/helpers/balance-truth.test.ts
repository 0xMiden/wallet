import type { Page } from '@playwright/test';

import { vaultBalance, vaultBalanceByFaucetId, waitForVaultBalanceByFaucetId } from './balance-truth';

/**
 * Drives the real `page.evaluate` callback against a fake store. The fixture's second row is the
 * point: its symbol is reachable only through `assetsMetadata`, which is how the harness injects
 * metadata for the CLI-deployed faucet every spec trades. `pendingNoteTotal` has always counted
 * that row, so a `vaultBalance` that cannot see it makes a successful claim read as lost value.
 */
function makePage(state: unknown): Page {
  return {
    evaluate: <Arg>(fn: (arg: Arg) => unknown, arg: Arg) => {
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

const feeFaucetId = 'mdev1aqq7uydvt3kd3uguak79c3y92y337l2v_qr7qqq9wr6w';
const otherFaucetId = 'mdev1aqq7uydvt3kd3uguak79c3y92y337l2v_qr7qqq9wr6x';

it('reads the configured fee asset even when its symbol is not MIDEN', async () => {
  const balances = {
    balances: {
      account: [
        { tokenId: feeFaucetId, balance: 99.999888, metadata: { symbol: 'USDCX', decimals: 6 } },
        { tokenId: otherFaucetId, balance: 20, metadata: { symbol: 'MIDEN', decimals: 8 } }
      ]
    }
  };
  await expect(vaultBalanceByFaucetId(makePage(balances), feeFaucetId)).resolves.toBe(99_999_888n);
});

it('does not combine distinct faucets with the same symbol', async () => {
  const balances = {
    balances: {
      account: [
        { tokenId: feeFaucetId, balance: 1.25, metadata: { symbol: 'TST', decimals: 6 } },
        { tokenId: otherFaucetId, balance: 10, metadata: { symbol: 'TST', decimals: 8 } }
      ]
    }
  };
  await expect(vaultBalanceByFaucetId(makePage(balances), feeFaucetId)).resolves.toBe(1_250_000n);
});

it.each([
  [6, 125_000n],
  [8, 12_500_000n]
])('uses cached metadata precision of %i decimals without requiring a symbol', async (decimals, expected) => {
  const balances = {
    balances: { account: [{ tokenId: feeFaucetId, balance: 0.125 }] },
    assetsMetadata: { [feeFaucetId]: { decimals } }
  };
  await expect(vaultBalanceByFaucetId(makePage(balances), feeFaucetId)).resolves.toBe(expected);
});

it('adds only rows for the exact faucet across account projections', async () => {
  const balances = {
    balances: {
      a: [{ tokenId: feeFaucetId, balance: 1.25, metadata: { decimals: 6 } }],
      b: [{ tokenId: feeFaucetId, balance: 0.125, metadata: { decimals: 6 } }]
    }
  };
  await expect(vaultBalanceByFaucetId(makePage(balances), feeFaucetId)).resolves.toBe(1_375_000n);
});

it('prefers the fee row decimals over stale cached metadata', async () => {
  const balances = {
    balances: { account: [{ tokenId: feeFaucetId, balance: 0.125, metadata: { decimals: 6 } }] },
    assetsMetadata: { [feeFaucetId]: { decimals: 8 } }
  };
  await expect(vaultBalanceByFaucetId(makePage(balances), feeFaucetId)).resolves.toBe(125_000n);
});

it('fails when a held fee asset has no known decimals rather than guessing zero precision', async () => {
  const balances = { balances: { account: [{ tokenId: feeFaucetId, balance: 2 }] } };
  await expect(vaultBalanceByFaucetId(makePage(balances), feeFaucetId)).rejects.toThrow('token decimals');
});

it.each([otherFaucetId, feeFaucetId.split('_')[0]!, feeFaucetId.toUpperCase()])(
  'does not treat %s as the full canonical faucet identity',
  async tokenId => {
    const balances = {
      balances: { account: [{ tokenId, balance: 2, metadata: { symbol: 'USDCX', decimals: 6 } }] }
    };
    await expect(vaultBalanceByFaucetId(makePage(balances), feeFaucetId)).resolves.toBe(0n);
  }
);

it('rejects a fee balance that cannot round-trip to its declared decimals', async () => {
  const balances = {
    balances: { account: [{ tokenId: feeFaucetId, balance: 0.0000001, metadata: { decimals: 6 } }] }
  };
  await expect(vaultBalanceByFaucetId(makePage(balances), feeFaucetId)).rejects.toThrow('does not round-trip');
});

it('rejects a fee balance whose base units exceed safe integer precision', async () => {
  const balances = {
    balances: { account: [{ tokenId: feeFaucetId, balance: 9_007_199_254.740992, metadata: { decimals: 6 } }] }
  };
  await expect(vaultBalanceByFaucetId(makePage(balances), feeFaucetId)).rejects.toThrow('safe integer');
});

it('waits for the exact faucet balance rather than a same-symbol balance', async () => {
  const balances = {
    balances: {
      account: [
        { tokenId: feeFaucetId, balance: 0, metadata: { symbol: 'TST', decimals: 6 } },
        { tokenId: otherFaucetId, balance: 2, metadata: { symbol: 'TST', decimals: 6 } }
      ]
    }
  };
  const page = makePage(balances);
  page.waitForTimeout = async () => {
    balances.balances.account[0]!.balance = 2;
  };
  await expect(waitForVaultBalanceByFaucetId(page, feeFaucetId, 2_000_000n)).resolves.toBeUndefined();
});

it('fails with expected and actual amounts when the faucet balance never settles', async () => {
  const balances = {
    balances: { account: [{ tokenId: feeFaucetId, balance: 1, metadata: { decimals: 6 } }] }
  };
  let now = 0;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  const page = makePage(balances);
  page.waitForTimeout = async delay => {
    now += delay;
  };
  try {
    await expect(waitForVaultBalanceByFaucetId(page, feeFaucetId, 2_000_000n, { timeoutMs: 2_000 })).rejects.toThrow(
      /expected vault: 2000000[\s\S]*actual vault:\s+1000000/
    );
  } finally {
    clock.mockRestore();
  }
});
