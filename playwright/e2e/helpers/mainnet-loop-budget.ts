import { tokenValueUsdMicro } from './mainnet-one-click-plan';

export type MainnetLoopProvider = 'swap' | 'epoch' | 'near';
export interface PortfolioSample {
  identity: string;
  decimals: number;
  usdMicros: bigint;
  before: bigint;
  after: bigint;
}
export const MAINNET_LOOP_LOSS_CAP = 2_000_000n;
const PRECEDING: Record<MainnetLoopProvider, readonly MainnetLoopProvider[]> = {
  swap: [],
  epoch: ['swap'],
  near: ['swap', 'epoch']
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function remainingMainnetLoopBudget(
  runId: string,
  provider: MainnetLoopProvider,
  completed: readonly unknown[]
): bigint {
  const expected = PRECEDING[provider];
  if (
    typeof runId !== 'string' ||
    !/^\d{1,20}$/.test(runId) ||
    !Array.isArray(expected) ||
    !Array.isArray(completed) ||
    completed.length !== expected.length
  ) {
    throw new Error('Missing same-run predecessor evidence for the shared mainnet budget');
  }
  const seen = new Set<string>();
  let account: string | undefined;
  let spent = 0n;
  for (const entry of completed) {
    if (
      !record(entry) ||
      typeof entry.provider !== 'string' ||
      !expected.some(name => name === entry.provider) ||
      seen.has(entry.provider) ||
      !record(entry.checkpoint)
    ) {
      throw new Error('Unexpected or duplicate mainnet loop cost evidence');
    }
    const state = entry.checkpoint;
    if (
      state.version !== 1 ||
      state.phase !== 'complete' ||
      state.sourceRunId !== runId ||
      typeof state.account !== 'string' ||
      !state.account ||
      state.account.length > 128 ||
      state.account.trim() !== state.account ||
      (account !== undefined && state.account !== account) ||
      typeof state.realizedCostUsdMicros !== 'string' ||
      !/^(0|[1-9]\d{0,19})$/.test(state.realizedCostUsdMicros)
    ) {
      throw new Error('Incomplete, stale or foreign-account mainnet loop cost evidence');
    }
    seen.add(entry.provider);
    account = state.account;
    spent += BigInt(state.realizedCostUsdMicros);
    if (spent > MAINNET_LOOP_LOSS_CAP) throw new Error('Combined mainnet loop loss exceeds $2');
  }
  return MAINNET_LOOP_LOSS_CAP - spent;
}

export function realizedMainnetLoopLoss(samples: readonly PortfolioSample[]): bigint {
  if (!samples.length) throw new Error('No mainnet portfolio balance evidence');
  const seen = new Map<string, PortfolioSample>();
  let loss = 0n;
  for (const sample of samples) {
    if (
      !sample.identity ||
      sample.identity.length > 160 ||
      !/^[a-z0-9:_-]+$/.test(sample.identity) ||
      !Number.isSafeInteger(sample.decimals) ||
      sample.decimals < 0 ||
      sample.decimals > 38 ||
      typeof sample.before !== 'bigint' ||
      sample.before < 0n ||
      typeof sample.after !== 'bigint' ||
      sample.after < 0n ||
      typeof sample.usdMicros !== 'bigint' ||
      sample.usdMicros <= 0n
    ) {
      throw new Error('Invalid mainnet portfolio balance or price');
    }
    const prior = seen.get(sample.identity);
    if (prior) {
      if (
        prior.before !== sample.before ||
        prior.after !== sample.after ||
        prior.decimals !== sample.decimals ||
        prior.usdMicros !== sample.usdMicros
      ) {
        throw new Error('Conflicting samples for the same mainnet asset');
      }
      continue;
    }
    seen.set(sample.identity, sample);
    const delta = sample.before - sample.after;
    loss +=
      delta >= 0n
        ? tokenValueUsdMicro(delta, sample.decimals, sample.usdMicros, true)
        : -tokenValueUsdMicro(-delta, sample.decimals, sample.usdMicros, false);
  }
  return loss > 0n ? loss : 0n;
}
