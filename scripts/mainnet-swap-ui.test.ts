/** @jest-environment node */
import { quotedSwapMinimum, validateSwapEta, validateSwapReview, submitSwapOnce } from '../playwright/e2e/helpers/mainnet-swap-ui';

const price = () => ({ offeredFaucet: 'a', requestedFaucet: 'b', offeredDecimals: 6, requestedDecimals: 6,
  marketPrice: '1', fillPrice: '0.99995', feePpm: 50, asOf: 1_000 });
const eta = () => ({ offeredFaucet: 'a', requestedFaucet: 'b', offeredAmount: '1010000', requestedAmount: '1009444',
  settlementsRunning: true, fillStatus: 'full', priceBand: 'at_market', reason: null,
  fillableOfferedAmount: '1010000', fillableRequestedAmount: '1009444', expectedRequestedAmount: '1009949' });

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
    for (const change of [{ settlementsRunning: false }, { fillStatus: 'partial' }, { offeredAmount: '2' },
      { priceBand: 'tolerated' }, { fillableOfferedAmount: '1000000' }, { requestedFaucet: 'foreign' }]) {
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
    const submit = submitSwapOnce(async () => { submissions++; throw new Error('transport lost'); });
    await expect(submit()).rejects.toThrow('transport lost');
    await expect(submit()).rejects.toThrow(/already attempted/);
    expect(submissions).toBe(1);
  });
});
