/** @jest-environment node */
import { chooseSwapCheckpoint, swapStepAttempted } from './mainnet-swap-artifacts.mjs';

const baseline = 42966766471;
const run = (id: number) => ({ id });
const artifact = (name: string, expired = false) => ({ name, expired });
const steps = (name: string, conclusion: string | null = 'success') => ({
  jobs: [{ steps: [{ name, status: 'completed', conclusion }] }]
});

describe('mainnet swap recovery artifact discovery', () => {
  it.each([
    'Run native mainnet round trip',
    'Run USDCx bridge loops',
    'Run the mainnet AggLayer loop',
    'Run mainnet round trip, USDCx bridge loops, and read-only 1Click preflight'
  ])('blocks fresh spending after an interrupted legacy stage: %s', async name => {
    const id = baseline + 1;
    await expect(
      chooseSwapCheckpoint(
        [run(id), run(baseline)],
        async () => ({ artifacts: [artifact(`mainnet-swap-final-${id}`)] }),
        async () => steps(name, 'cancelled'),
        baseline
      )
    ).rejects.toThrow(/legacy|unresolved/i);
  });
  it('does not hide an older failed legacy operation behind a newer complete swap artifact', async () => {
    const id = baseline + 2;
    await expect(
      chooseSwapCheckpoint(
        [run(id), run(id - 1), run(baseline)],
        async () => ({ artifacts: [artifact(`mainnet-swap-final-${id}`)] }),
        async prior => (prior === id ? { jobs: [] } : steps('Run USDCx bridge loops', 'failure')),
        baseline
      )
    ).rejects.toThrow(/legacy|unresolved/i);
  });
  it.each(['success', 'skipped'])('allows proven terminal or unused legacy activity: %s', async conclusion => {
    const id = baseline + 1;
    await expect(
      chooseSwapCheckpoint(
        [run(id), run(baseline)],
        async () => ({ artifacts: [artifact(`mainnet-swap-final-${id}`)] }),
        async () => steps('Run the mainnet AggLayer loop', conclusion),
        baseline
      )
    ).resolves.toEqual({ runId: id, name: `mainnet-swap-final-${id}`, bootstrap: false });
  });
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
  it.each(['forward', 'reverse'])('prefers the actual %s SDK snapshot over its older reviewed terms', async leg => {
    const id = baseline + 1;
    const name = `mainnet-swap-${leg}-sdk-authorized-${id}`;
    const found = await chooseSwapCheckpoint(
      [run(id)],
      async () => ({ artifacts: [artifact(`mainnet-swap-${leg}-authorized-${id}`), artifact(name)] }),
      async () => steps(`Run mainnet swap ${leg}`),
      baseline
    );
    expect(found).toEqual({ runId: id, name, bootstrap: false });
  });
  it.each(['forward', 'reverse'])('prefers the actual %s claim snapshot over earlier create authority', async leg => {
    const id = baseline + 1;
    const name = `mainnet-swap-${leg}-claim-sdk-authorized-${id}`;
    const found = await chooseSwapCheckpoint([run(id)], async () => ({ artifacts: [
      artifact(`mainnet-swap-${leg}-sdk-authorized-${id}`), artifact(name)
    ] }), async () => steps(`Run mainnet swap ${leg}`), baseline);
    expect(found).toEqual({ runId: id, name, bootstrap: false });
  });
  it.each([
    ['Upload swap SDK forward claim authority', 'forward'],
    ['Upload swap SDK reverse claim authority', 'reverse'],
    ['Upload recovered swap SDK return claim authority', 'reverse']
  ])('never falls back to create-only evidence after %s', async (name, leg) => {
    const id = baseline + 1;
    await expect(chooseSwapCheckpoint([run(id)], async () => ({ artifacts: [
      artifact(`mainnet-swap-${leg}-sdk-authorized-${id}`)
    ] }), async () => steps(name), baseline)).rejects.toThrow(/claim|missing|downgrade/i);
  });
  it.each(['forward', 'reverse'])('does not ignore an expired %s claim snapshot', async leg => {
    const id = baseline + 1;
    await expect(chooseSwapCheckpoint([run(id)], async () => ({ artifacts: [
      artifact(`mainnet-swap-${leg}-sdk-authorized-${id}`), artifact(`mainnet-swap-${leg}-claim-sdk-authorized-${id}`, true)
    ] }), async () => steps(`Run mainnet swap ${leg}`), baseline)).rejects.toThrow(/expired/i);
  });
  it('never downgrades an expired actual SDK snapshot to earlier symbolic terms', async () => {
    const id = baseline + 1;
    await expect(
      chooseSwapCheckpoint(
        [run(id)],
        async () => ({
          artifacts: [
            artifact(`mainnet-swap-forward-authorized-${id}`),
            artifact(`mainnet-swap-forward-sdk-authorized-${id}`, true)
          ]
        }),
        async () => steps('Run mainnet swap forward'),
        baseline
      )
    ).rejects.toThrow(/expired/i);
  });
  it.each([
    ['Upload swap SDK forward authority', 'forward'],
    ['Upload swap SDK reverse authority', 'reverse'],
    ['Upload recovered swap SDK return authority', 'reverse']
  ])('refuses missing actual authority after %s instead of falling back to a pre-SDK plan', async (upload, leg) => {
    const id = baseline + 1;
    await expect(
      chooseSwapCheckpoint(
        [run(id)],
        async () => ({ artifacts: [artifact(`mainnet-swap-${leg}-authorized-${id}`)] }),
        async () => steps(upload),
        baseline
      )
    ).rejects.toThrow(/SDK|missing|downgrade/i);
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
