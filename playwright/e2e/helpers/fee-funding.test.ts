import type { Page } from '@playwright/test';

import { ensureFeeFunded } from './fee-funding';

jest.mock('@playwright/test', () => ({
  expect: (actual: unknown, message?: string) => ({
    toBeGreaterThan: (minimum: bigint) => {
      try {
        expect(actual).toBeGreaterThan(minimum);
      } catch (error) {
        throw new Error(`${message}\n${String(error)}`);
      }
    }
  })
}));

const feeFaucetId = 'mdev1aqq7uydvt3kd3uguak79c3y92y337l2v_qr7qqq9wr6w';
const otherFaucetId = 'mdev1aqq7uydvt3kd3uguak79c3y92y337l2v_qr7qqq9wr6x';

interface Row {
  tokenId: string;
  balance: number;
  metadata: { symbol: string; decimals: number };
}

function fixture(opts: { rows?: Row[]; feeId?: string | null; charges?: boolean } = {}) {
  const state = { balances: { account: opts.rows ?? [] } };
  let discoveredId = opts.feeId === undefined ? feeFaucetId : opts.feeId;
  const page = {
    evaluate: async <Arg>(fn: (arg: Arg) => unknown, arg: Arg) => {
      const previousStore = Reflect.get(globalThis, '__TEST_STORE__');
      const previousChrome = Reflect.get(globalThis, 'chrome');
      Reflect.set(globalThis, '__TEST_STORE__', { getState: () => state });
      Reflect.set(globalThis, 'chrome', {
        storage: { local: { get: async () => ({ 'native_asset_id:v4:devnet': discoveredId }) } }
      });
      try {
        return await fn(arg);
      } finally {
        Reflect.set(globalThis, '__TEST_STORE__', previousStore);
        Reflect.set(globalThis, 'chrome', previousChrome);
      }
    },
    waitForTimeout: jest.fn(async () => undefined)
  } as unknown as Page;
  const funder = {
    init: async () => undefined,
    fundAccountForFees: async () => undefined,
    chainCharges: async () => opts.charges ?? true
  };
  const wallet = { page, claimAllNotes: jest.fn(async () => undefined) };
  return { funder, wallet, state, discover: (id: string) => (discoveredId = id) };
}

it('accepts a spendable balance of the wallet-discovered fee faucet with another symbol', async () => {
  const { funder, wallet } = fixture({
    rows: [{ tokenId: feeFaucetId, balance: 99.999888, metadata: { symbol: 'USDCX', decimals: 6 } }]
  });
  await expect(ensureFeeFunded(funder, wallet, 'recipient', { attempts: 1 })).resolves.toBe(99_999_888n);
});

it('waits for funding to become spendable after claiming its note', async () => {
  const { funder, wallet, state } = fixture();
  wallet.claimAllNotes.mockImplementation(async () => {
    state.balances.account.push({
      tokenId: feeFaucetId,
      balance: 1.25,
      metadata: { symbol: 'USDCX', decimals: 6 }
    });
  });
  await expect(ensureFeeFunded(funder, wallet, 'recipient', { attempts: 1 })).resolves.toBe(1_250_000n);
});

it('rejects an account that holds MIDEN from a different faucet but no fee asset', async () => {
  const { funder, wallet } = fixture({
    rows: [{ tokenId: otherFaucetId, balance: 10, metadata: { symbol: 'MIDEN', decimals: 8 } }]
  });
  await expect(ensureFeeFunded(funder, wallet, 'recipient', { attempts: 1 })).rejects.toThrow(
    'was never funded for fees'
  );
});

it('returns on a zero-fee chain before reading the fee identity or claiming notes', async () => {
  const { funder, wallet } = fixture({ charges: false, feeId: null });
  wallet.page.evaluate = async () => {
    throw new Error('zero-fee fixture must not need a balance oracle');
  };
  wallet.claimAllNotes.mockImplementation(async () => {
    throw new Error('zero-fee fixture must not claim funding');
  });
  await expect(ensureFeeFunded(funder, wallet, 'recipient')).resolves.toBe(0n);
});

it('reports missing fee discovery rather than treating any symbol as native', async () => {
  const { funder, wallet } = fixture({ feeId: null });
  await expect(ensureFeeFunded(funder, wallet, 'recipient', { attempts: 1 })).rejects.toThrow(
    /recipient[\s\S]*fee faucet.*discover/i
  );
});

it('allows the wallet fee cache to be discovered asynchronously', async () => {
  const { funder, wallet, discover } = fixture({
    feeId: null,
    rows: [{ tokenId: feeFaucetId, balance: 1, metadata: { symbol: 'USDCX', decimals: 6 } }]
  });
  wallet.page.waitForTimeout = async () => {
    discover(feeFaucetId);
  };
  await expect(ensureFeeFunded(funder, wallet, 'recipient', { attempts: 2 })).resolves.toBe(1_000_000n);
});
