/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import {
  remainingMainnetLoopBudget,
  realizedMainnetLoopLoss,
  cappedMainnetRecoveryBudget
} from '../playwright/e2e/helpers/mainnet-loop-budget';

it.each([
  ['1218022', 1_218_022n],
  ['2000000', 1_237_031n],
  [undefined, 1_237_031n]
])('bounds the original recovery allowance by the current dispatch cap (%s)', (configured, expected) => {
  expect(cappedMainnetRecoveryBudget('1237031', configured)).toBe(expected);
});

it.each(['0', '-1', '1e6', '2000001'])('refuses invalid current recovery allowance %s', configured => {
  expect(() => cappedMainnetRecoveryBudget('1237031', configured)).toThrow('Invalid remaining mainnet task loss allowance');
});

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

describe('bridge-only same-run budget and account evidence', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.MAINNET_LOOP_BRIDGES_ONLY = 'true';
    process.env.MAINNET_LOOP_LOSS_BUDGET_USD_MICROS = '1953919';
  });
  afterEach(() => {
    process.env = { ...original };
  });
  it.each([
    { provider: 'swap', checkpoint: undefined },
    evidence('swap', '986', { sourceRunId: '99', account: 'historical' })
  ])('starts Epoch with the remaining allowance and no fresh swap: %#', swap => {
    expect(remainingMainnetLoopBudget('100', 'epoch', [swap])).toBe(1_953_919n);
    expect(remainingMainnetLoopBudget('100', 'near', [swap, evidence('epoch', '500')])).toBe(1_953_419n);
  });
  it('rejects unexpected fresh swap cost instead of silently excluding it', () => {
    expect(() => remainingMainnetLoopBudget('100', 'epoch', [evidence('swap', '986')])).toThrow();
  });
  it.each([
    1,
    evidence('swap', '0', { sourceRunId: '99', phase: 'forward-submitted' }).checkpoint,
    evidence('swap', '0', { sourceRunId: undefined }).checkpoint,
    evidence('swap', '0', { sourceRunId: '99', phase: undefined }).checkpoint
  ])('does not ignore malformed or unresolved historical swap evidence: %#', checkpoint => {
    expect(() => remainingMainnetLoopBudget('100', 'epoch', [{ provider: 'swap', checkpoint }])).toThrow();
  });
  it.each([
    undefined,
    evidence('epoch', '500', { sourceRunId: '99' }).checkpoint,
    evidence('epoch', '500', { phase: 'forward-submitted' }).checkpoint,
    evidence('epoch', '1953920').checkpoint
  ])('still requires settled same-run Epoch cost before NEAR: %#', checkpoint => {
    expect(() =>
      remainingMainnetLoopBudget('100', 'near', [
        { provider: 'swap', checkpoint: undefined },
        { provider: 'epoch', checkpoint }
      ])
    ).toThrow();
  });
  it.each([
    ['tests/mainnet/mainnet-epoch-loop.spec.ts', 'Epoch and swap must use the same existing Guardian account'],
    [
      'helpers/mainnet-near-runtime.ts',
      'Native NEAR and both predecessor costs must belong to the same existing Guardian'
    ]
  ])('does not require a skipped swap account in the actual preparation guard: %s', (path, message) => {
    const source = readFileSync(resolve(__dirname, '../playwright/e2e', path), 'utf8');
    const end = source.indexOf(message);
    expect(end).toBeGreaterThan(0);
    const guard = source.slice(source.lastIndexOf('if (', end), source.indexOf(';', end) + 1);
    const context = {
      account: 'guardian',
      runId: '100',
      predecessor: undefined,
      swap: undefined,
      epoch: evidence('epoch', '0').checkpoint
    };
    expect(() => runInNewContext(guard, context)).not.toThrow();
    const foreign = evidence('swap', '0', { account: 'foreign' }).checkpoint;
    expect(() => runInNewContext(guard, { ...context, predecessor: foreign, swap: foreign })).toThrow();
  });
});

describe('explicit remaining task allowance after original recovery', () => {
  const key = 'MAINNET_LOOP_LOSS_BUDGET_USD_MICROS';
  const original = process.env[key];
  afterEach(() => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  });
  it('deducts current-run predecessors from the reduced allowance, never resets it to $2', () => {
    process.env[key] = '1999500';
    expect(remainingMainnetLoopBudget('100', 'swap', [])).toBe(1_999_500n);
    expect(remainingMainnetLoopBudget('100', 'epoch', [evidence('swap', '905')])).toBe(1_998_595n);
    expect(remainingMainnetLoopBudget('100', 'near', [evidence('swap', '905'), evidence('epoch', '500')])).toBe(
      1_998_095n
    );
    expect(() => remainingMainnetLoopBudget('100', 'epoch', [evidence('swap', '1999501')])).toThrow();
  });
  it.each(['', '0', '-1', '2000001', '02000000', '1e6', '1.5', 'unknown'])(
    'rejects an unsafe explicit allowance %s',
    value => {
      process.env[key] = value;
      expect(() => remainingMainnetLoopBudget('100', 'swap', [])).toThrow();
    }
  );
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
