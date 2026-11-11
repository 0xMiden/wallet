/** @jest-environment node */
import { db as walletDb } from 'lib/miden/repo';

import {
  quotedSwapMinimum,
  validateSwapEta,
  validateSwapReview,
  submitSwapOnce,
  resumeSwapAutoAcceptInPage,
  runPreparedSwap,
  cachedSolverRegistry
} from '../playwright/e2e/helpers/mainnet-swap-ui';

const price = () => ({
  offeredFaucet: 'a',
  requestedFaucet: 'b',
  offeredDecimals: 6,
  requestedDecimals: 6,
  marketPrice: '1',
  fillPrice: '0.99995',
  feePpm: 50,
  asOf: 1_000
});
const eta = () => ({
  offeredFaucet: 'a',
  requestedFaucet: 'b',
  offeredAmount: '1010000',
  requestedAmount: '1009444',
  settlementsRunning: true,
  fillStatus: 'full',
  priceBand: 'at_market',
  reason: null,
  fillableOfferedAmount: '1010000',
  fillableRequestedAmount: '1009444',
  expectedRequestedAmount: '1009949'
});

describe('restoring one recovered swap automation setting', () => {
  const identity = {
    id: 'resume-tx',
    orderId: '123',
    account: 'mm1account',
    offeredFaucet: 'mm1a',
    requestedFaucet: 'mm1b',
    offer: '1010000',
    minimumReceive: '1009000',
    initiatedAt: 1_000
  };
  let db: IDBDatabase;
  beforeEach(async () => {
    await walletDb.open();
    db = walletDb.backendDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('transactions', 'readwrite');
      tx.objectStore('transactions').put({
        id: identity.id,
        type: 'swap',
        status: 2,
        accountId: identity.account,
        faucetId: identity.offeredFaucet,
        amount: 1010000n,
        extraInputs: {
          orderId: 123n,
          requestedFaucetId: identity.requestedFaucet,
          requestedAmount: 1009000n,
          autoConsume: false
        }
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
  async function setting(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const request = db.transaction('transactions', 'readonly').objectStore('transactions').get(identity.id);
      request.onsuccess = () => resolve(request.result.extraInputs.autoConsume);
      request.onerror = () => reject(request.error);
    });
  }
  it('resumes auto-accept only for the exact identified order', async () => {
    await resumeSwapAutoAcceptInPage(identity);
    expect(await setting()).toBe(true);
  });
  it.each([{ account: 'foreign' }, { offeredFaucet: 'foreign' }, { minimumReceive: '999999' }])(
    'does not restore automation after identity changes: %p',
    async change => {
      await expect(resumeSwapAutoAcceptInPage({ ...identity, ...change })).rejects.toThrow(/identity/);
      expect(await setting()).toBe(false);
    }
  );
});

describe('accepted cached solver registry', () => {
  const pairs = {
    tokens: [
      { faucetId: `0x${'1'.repeat(30)}`, ticker: 'USDCX', decimals: 6, binanceAsset: 'USDC' },
      { faucetId: `0x${'2'.repeat(30)}`, ticker: 'ETH', decimals: 8, binanceAsset: 'ETH' }
    ],
    pairs: [{ faucetIds: [`0x${'1'.repeat(30)}`, `0x${'2'.repeat(30)}`] }]
  };
  const config = { body: { network: 'mainnet', version: 18, swap: { etaUrl: 'https://solver.example/base/' } } };
  const derived = { network: 'mainnet', version: 18, swap: { pairs: { state: 'ok', value: pairs } } };
  it('uses the accepted registry even when hydration made no new HTTP request', () => {
    expect(cachedSolverRegistry(config, derived)).toEqual({ service: 'https://solver.example/base', pairs });
  });
  it('refuses mismatched versions, networks, failed registry reads and insecure endpoints', () => {
    expect(() => cachedSolverRegistry(config, { ...derived, version: 17 })).toThrow();
    expect(() => cachedSolverRegistry(config, { ...derived, network: 'testnet' })).toThrow();
    expect(() => cachedSolverRegistry(config, { ...derived, swap: { pairs: { state: 'error' } } })).toThrow();
    expect(() =>
      cachedSolverRegistry({ body: { ...config.body, swap: { etaUrl: 'http://solver.example' } } }, derived)
    ).toThrow();
  });
});

describe('read-only preparation versus possibly submitted swaps', () => {
  it('records proven non-submission when preparation fails, but not when submitting fails', async () => {
    let unspent = 0;
    await expect(
      runPreparedSwap(
        async () => {
          throw new Error('quote outage');
        },
        () => {
          unspent++;
        }
      )
    ).rejects.toThrow('quote outage');
    expect(unspent).toBe(1);
    await expect(
      runPreparedSwap(
        async () => async () => {
          throw new Error('submission response lost');
        },
        () => {
          unspent++;
        }
      )
    ).rejects.toThrow('submission response lost');
    expect(unspent).toBe(1);
  });
});

describe('live nightly swap pre-sign boundary', () => {
  it('uses the wallet fill price and 5 bps slippage, rounding down in token base units', () => {
    expect(quotedSwapMinimum(price(), 'a', 'b', 6, 6, 1_010_000n, 1_000_000)).toBe(1_009_444n);
  });
  it.each(['stale', 'future', 'scale', 'pair', 'zero price'])('rejects %s price', mode => {
    const p = price();
    if (mode === 'stale') p.asOf = 900;
    if (mode === 'future') p.asOf = 1_031;
    if (mode === 'scale') p.offeredDecimals = 8;
    if (mode === 'pair') p.requestedFaucet = 'other';
    if (mode === 'zero price') p.fillPrice = '0';
    expect(() => quotedSwapMinimum(p, 'a', 'b', 6, 6, 1_010_000n, 1_000_000)).toThrow();
  });
  it('requires an exact fully fillable live order, not a partial or stale-pair response', () => {
    expect(() => validateSwapEta(eta(), 'a', 'b', 1_010_000n, 1_009_444n)).not.toThrow();
    for (const change of [
      { settlementsRunning: false },
      { fillStatus: 'partial' },
      { offeredAmount: '2' },
      { priceBand: 'tolerated' },
      { fillableOfferedAmount: '1000000' },
      { requestedFaucet: 'foreign' }
    ]) {
      expect(() => validateSwapEta({ ...eta(), ...change }, 'a', 'b', 1_010_000n, 1_009_444n)).toThrow();
    }
  });
  it('rejects drift below the uploaded minimum or a larger offer before signing', () => {
    expect(() => validateSwapReview(1_010_000n, 1_009_444n, 1_010_000n, 1_009_000n)).not.toThrow();
    expect(() => validateSwapReview(1_010_000n, 1_008_999n, 1_010_000n, 1_009_000n)).toThrow();
    expect(() => validateSwapReview(1_010_001n, 1_009_444n, 1_010_000n, 1_009_000n)).toThrow();
  });
  it('cannot submit twice even after the first submit loses its response', async () => {
    let submissions = 0;
    const submit = submitSwapOnce(async () => {
      submissions++;
      throw new Error('transport lost');
    });
    await expect(submit()).rejects.toThrow('transport lost');
    await expect(submit()).rejects.toThrow(/already attempted/);
    expect(submissions).toBe(1);
  });
});
