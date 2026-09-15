import { runStressDriver, type StressOptions } from './stress-driver';
import type { TimelineRecorder } from '../harness/timeline-recorder';
import type { ChromeWalletPageApi } from '../helpers/wallet-page';

const TRACKED_FAUCET = 'tracked-faucet';

function snapshot(totalReportable: number) {
  return {
    balance: totalReportable,
    pendingNotes: [],
    pendingSum: 0,
    totalReportable,
    pendingTxCount: 0,
    unidentified: 0
  };
}

describe('runStressDriver balance scope', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('ignores same-symbol foreign faucet dust in per-operation divergence tracking', async () => {
    jest.useFakeTimers();
    const tracked = { A: 10, B: 10 };
    const foreign = { A: 100, B: 200 };
    const makeWallet = (label: 'A' | 'B'): ChromeWalletPageApi =>
      ({
        page: {},
        quickBalanceSnapshot: async (scope?: { faucetId?: string }) =>
          snapshot(tracked[label] + (scope?.faucetId === TRACKED_FAUCET ? 0 : foreign[label])),
        sendTokens: async ({ amount }: { amount: string }) => {
          const receiver = label === 'A' ? 'B' : 'A';
          tracked[label] -= Number(amount);
          tracked[receiver] += Number(amount);
          foreign.A += 5;
        },
        claimAllNotes: async () => undefined
      }) as unknown as ChromeWalletPageApi;
    const walletA = makeWallet('A');
    const walletB = makeWallet('B');
    const opts: StressOptions = {
      numNotes: 1,
      delayMinMs: 0,
      delayMaxMs: 0,
      privateRatio: 0,
      sendAmountMin: 1,
      sendAmountMax: 1,
      claimAfterSendProb: 0,
      idleEvery: 0,
      idleMinMs: 0,
      idleMaxMs: 0,
      lockEvery: 0,
      reloadEvery: 0,
      concurrentProb: 0,
      perTurnSendTimeoutMs: 30_000,
      transportFailProb: 0,
      seed: 1
    };
    const inputs: Parameters<typeof runStressDriver>[0] = {
      walletA,
      walletB,
      addressA: 'account-a',
      addressB: 'account-b',
      tokenSymbol: 'TST',
      faucetId: TRACKED_FAUCET
    };
    const timeline = { emit: jest.fn() } as unknown as TimelineRecorder;

    const resultPromise = runStressDriver(inputs, timeline, opts);
    await jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.completed).toBe(1);
    expect(result.firstDivergenceOp).toBeNull();
  });
});
