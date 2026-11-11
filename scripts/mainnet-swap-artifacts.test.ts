/** @jest-environment node */
import { chooseSwapCheckpoint, swapStepAttempted } from './mainnet-swap-artifacts.mjs';

const baseline = 42966766471;
const run = (id: number) => ({ id });
const artifact = (name: string, expired = false) => ({ name, expired });
const steps = (name: string, conclusion: string | null = 'success') => ({
  jobs: [{ steps: [{ name, status: 'completed', conclusion }] }]
});

describe('mainnet swap recovery artifact discovery', () => {
  it('prefers final then reverse authorization within the latest run, including failed runs', async () => {
    const result = await chooseSwapCheckpoint(
      [run(baseline + 2), run(baseline + 1), run(baseline)],
      async id => ({
        artifacts: [
          artifact(`mainnet-swap-forward-authorized-${id}`),
          artifact(`mainnet-swap-reverse-authorized-${id}`),
          artifact(`mainnet-swap-final-${id}`)
        ]
      }),
      async () => steps('Run mainnet swap forward'),
      baseline
    );
    expect(result).toEqual({ runId: baseline + 2, name: `mainnet-swap-final-${baseline + 2}`, bootstrap: false });
  });
  it('does not skip a newer potentially funded run in favor of an older complete one', async () => {
    await expect(
      chooseSwapCheckpoint(
        [run(baseline + 2), run(baseline + 1)],
        async id => ({ artifacts: id === baseline + 1 ? [artifact(`mainnet-swap-final-${id}`)] : [] }),
        async () => steps('Run mainnet swap forward', 'cancelled'),
        baseline
      )
    ).rejects.toThrow(/missing/);
  });
  it('does not fall back from expired authorization', async () => {
    await expect(
      chooseSwapCheckpoint(
        [run(baseline + 1)],
        async id => ({ artifacts: [artifact(`mainnet-swap-forward-authorized-${id}`, true)] }),
        async () => steps('Run mainnet swap forward'),
        baseline
      )
    ).rejects.toThrow(/expired/);
  });
  it('skips a failed setup that provably never reached either funded stage', async () => {
    const result = await chooseSwapCheckpoint(
      [run(baseline + 1), run(baseline)],
      async () => ({ artifacts: [] }),
      async () => steps('Run mainnet swap forward', 'skipped'),
      baseline
    );
    expect(result.bootstrap).toBe(true);
  });
  it('refuses to bootstrap when the bounded history does not reach the verified pre-swap baseline', async () => {
    await expect(
      chooseSwapCheckpoint(
        [run(baseline + 1)],
        async () => ({ artifacts: [] }),
        async () => ({ jobs: [] }),
        baseline
      )
    ).rejects.toThrow(/baseline/);
  });
  it('treats a running or cancelled funded stage as attempted, but not a skipped stage', () => {
    expect(swapStepAttempted(steps('Run mainnet swap reverse', 'cancelled'), 'reverse')).toBe(true);
    expect(swapStepAttempted(steps('Run mainnet swap reverse', 'skipped'), 'reverse')).toBe(false);
    expect(
      swapStepAttempted(
        { jobs: [{ steps: [{ name: 'Run mainnet swap forward', status: 'in_progress', conclusion: null }] }] },
        'forward'
      )
    ).toBe(true);
  });
});
