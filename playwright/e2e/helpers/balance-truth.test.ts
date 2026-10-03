import type { Page } from '@playwright/test';

import {
  vaultBalance,
  vaultBalanceByFaucetId,
  waitForVaultBalance,
  waitForVaultBalanceByFaucetId,
  walletDiscoveredBaseFee,
  walletDiscoveredNativeFaucetId
} from './balance-truth';

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

it('rejects a symbol balance whose base units exceed safe integer precision', async () => {
  const unsafe = {
    balances: {
      account: [{ tokenId: 'faucet-on-row', balance: 9_007_199_254.740992, metadata: { symbol: 'TST', decimals: 6 } }]
    }
  };
  await expect(vaultBalance(makePage(unsafe), 'TST')).rejects.toThrow('safe integer');
});

it('keeps the unconsumed-note diagnostic when a symbol balance never settles', async () => {
  let now = 0;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  const page = makePage(state);
  page.waitForTimeout = async delay => {
    now += delay;
  };
  try {
    await expect(waitForVaultBalance(page, 'TST', 1n, { timeoutMs: 2_000 })).rejects.toThrow(
      /actual vault:\s+1500000000\n {2}unconsumed notes for TST: 0 base units/
    );
  } finally {
    clock.mockRestore();
  }
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
  // The same-symbol foreign row already holds the target, so only a waiter that reads the requested faucet polls.
  const poll = jest.fn(async () => {
    balances.balances.account[0]!.balance = 2;
  });
  page.waitForTimeout = poll;
  await expect(waitForVaultBalanceByFaucetId(page, feeFaucetId, 2_000_000n)).resolves.toBeUndefined();
  expect(poll).toHaveBeenCalledTimes(1);
});

it('fails with expected and actual amounts when only a foreign faucet holds the target', async () => {
  const balances = {
    balances: {
      account: [
        { tokenId: feeFaucetId, balance: 1, metadata: { decimals: 6 } },
        { tokenId: otherFaucetId, balance: 2, metadata: { decimals: 6 } }
      ]
    }
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

/** A page whose extension storage holds `entries`, in insertion order, the order `Object.keys` reports. */
function cachePage(entries: Record<string, unknown>): Page {
  return {
    evaluate: async <Arg>(fn: (arg: Arg) => unknown, arg: Arg) => {
      const previous = Reflect.get(globalThis, 'chrome');
      Reflect.set(globalThis, 'chrome', { storage: { local: { get: async () => ({ ...entries }) } } });
      try {
        return await fn(arg);
      } finally {
        Reflect.set(globalThis, 'chrome', previous);
      }
    }
  } as unknown as Page;
}

describe.each([
  {
    name: 'walletDiscoveredNativeFaucetId',
    read: walletDiscoveredNativeFaucetId,
    stale: 'native_asset_id:v3:https://rpc.devnet.miden.io',
    current: 'native_asset_id:v4:https://rpc.devnet.miden.io|devnet',
    otherScope: 'native_asset_id:v4:https://rpc.testnet.miden.io|testnet',
    value: feeFaucetId,
    staleValue: otherFaucetId
  },
  {
    name: 'walletDiscoveredBaseFee',
    read: walletDiscoveredBaseFee,
    stale: 'native_asset_fee:v0:https://rpc.devnet.miden.io',
    current: 'native_asset_fee:v1:https://rpc.devnet.miden.io|devnet',
    otherScope: 'native_asset_fee:v1:https://rpc.testnet.miden.io|testnet',
    value: 10_000,
    staleValue: 250
  }
])('$name', ({ read, stale, current, otherScope, value, staleValue }) => {
  it('returns the current-version entry, not a stale one stored before it', async () => {
    await expect(read(cachePage({ [stale]: staleValue, [current]: value }))).resolves.toBe(value);
  });

  it('refuses two current-version scopes instead of letting key order pick one', async () => {
    await expect(read(cachePage({ [current]: value, [otherScope]: staleValue }))).rejects.toThrow('ambiguous');
  });

  it('answers null when the wallet has not discovered it', async () => {
    await expect(read(cachePage({ [stale]: staleValue }))).resolves.toBeNull();
  });
});
