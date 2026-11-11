/** @jest-environment node */
import { remainingMainnetLoopBudget, realizedMainnetLoopLoss } from '../playwright/e2e/helpers/mainnet-loop-budget';

const evidence = (provider: string, cost: string, changes: Record<string, unknown> = {}) => ({
  provider,
  checkpoint: {
    version: 1,
    sourceRunId: '100',
    account: 'guardian',
    phase: 'complete',
    realizedCostUsdMicros: cost,
    ...changes
  }
});
const sample = (identity = 'miden:native') => ({
  identity,
  decimals: 6,
  usdMicros: 1_000_000n,
  before: 10_000_000n,
  after: 9_999_095n
});

describe('combined mainnet loop loss budget', () => {
  it('starts swaps at $2 and deducts every completed predecessor before later providers', () => {
    expect(remainingMainnetLoopBudget('100', 'swap', [])).toBe(2_000_000n);
    expect(remainingMainnetLoopBudget('100', 'epoch', [evidence('swap', '905')])).toBe(1_999_095n);
    expect(remainingMainnetLoopBudget('100', 'near', [evidence('swap', '905'), evidence('epoch', '500')])).toBe(
      1_998_595n
    );
    expect(remainingMainnetLoopBudget('100', 'epoch', [evidence('swap', '2000000')])).toBe(0n);
  });
  it.each(
    [
      [],
      [evidence('epoch', '0')],
      [evidence('swap', '0'), evidence('swap', '0')],
      [evidence('swap', '-1')],
      [evidence('swap', '1.5')],
      [evidence('swap', '2000001')],
      [evidence('swap', '0', { sourceRunId: '99' })],
      [evidence('swap', '0', { phase: 'forward-submitted' })],
      [evidence('swap', '0', { account: '' })],
      [evidence('swap', '0', { realizedCostUsdMicros: undefined })]
    ].map(entries => ({ entries }))
  )('rejects missing, stale, ambiguous or overspent epoch evidence %#', ({ entries }) => {
    expect(() => remainingMainnetLoopBudget('100', 'epoch', entries)).toThrow();
  });
  it('rejects foreign-account and missing predecessor evidence for NEAR', () => {
    expect(() => remainingMainnetLoopBudget('100', 'near', [evidence('swap', '905')])).toThrow();
    expect(() =>
      remainingMainnetLoopBudget('100', 'near', [evidence('swap', '905'), evidence('epoch', '0', { account: 'other' })])
    ).toThrow();
    expect(() => remainingMainnetLoopBudget('', 'swap', [])).toThrow();
  });
});

describe('cross-chain portfolio loss', () => {
  it('counts principal/native overlap once and includes EVM all-in gas at 18 decimals', () => {
    expect(
      realizedMainnetLoopLoss([
        sample(),
        sample(),
        {
          identity: 'evm:42161:native',
          decimals: 18,
          usdMicros: 2_000_000_000n,
          before: 1_000_000_000_000_000n,
          after: 999_990_000_000_000n
        }
      ])
    ).toBe(925n);
  });
  it('offsets owned dust and never turns a profit into additional spending authorization', () => {
    expect(realizedMainnetLoopLoss([sample(), { ...sample('evm:42161:usdc'), after: 10_000_005n }])).toBe(900n);
    expect(realizedMainnetLoopLoss([{ ...sample(), after: 11_000_000n }])).toBe(0n);
  });
  it('rejects conflicting duplicate samples and invalid balances or prices', () => {
    expect(() => realizedMainnetLoopLoss([sample(), { ...sample(), after: 0n }])).toThrow();
    for (const entry of [
      { ...sample(), usdMicros: 0n },
      { ...sample(), after: -1n },
      { ...sample(), before: -1n },
      { ...sample(), decimals: 39 },
      { ...sample(), identity: '' }
    ])
      expect(() => realizedMainnetLoopLoss([entry])).toThrow();
    expect(() => realizedMainnetLoopLoss([])).toThrow();
  });
});
