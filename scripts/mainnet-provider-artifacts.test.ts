/** @jest-environment node */
import {
  chooseSwapCheckpoint,
  swapStepAttempted,
  knownUnspentEpochPreAuthorization
} from './mainnet-swap-artifacts.mjs';

const baseline = 42966766471;
const runs = [{ id: baseline + 2 }, { id: baseline + 1 }, { id: baseline }];
const artifact = (name: string, expired = false) => ({ name, expired });
const jobs = (name: string, conclusion = 'cancelled') => ({
  jobs: [{ steps: [{ name, status: 'completed', conclusion }] }]
});

describe('known failed Epoch pre-authorization', () => {
  const digest = '8ec4e65e7f1f912ef290881fe65b69158af56838b0afd3b93bb6fb73f65646ef';
  const now = Date.parse('2026-11-14T17:25:00Z');
  const run = () => ({
    id: 43619310746,
    repository: { id: 853430876 },
    workflow_id: 391951744,
    head_sha: '9fbe3807bcdd68ce728ed15bc3ab98c63815fba4',
    head_branch: 'wiktor/nightly-swap-loop',
    event: 'workflow_dispatch',
    run_attempt: 1,
    status: 'completed',
    conclusion: 'failure'
  });
  const originalJobs = () => ({
    jobs: [
      {
        name: 'Chrome mainnet round trip',
        status: 'completed',
        conclusion: 'failure',
        steps: [
          ['Prepare mainnet Epoch loop', 'success'],
          ['Run mainnet epoch forward', 'success'],
          ['Upload Epoch native forward authority', 'failure'],
          ['Upload Epoch SDK forward authority', 'skipped'],
          ['Wait for mainnet Epoch forward', 'skipped'],
          ['Run mainnet epoch reverse', 'skipped'],
          ['Upload Epoch reverse authority', 'skipped'],
          ['Upload mainnet epoch signed EVM 1', 'skipped'],
          ['Upload mainnet epoch signed EVM 2', 'skipped'],
          ['Upload mainnet epoch signed EVM 3', 'skipped'],
          ['Upload mainnet epoch native return claim', 'skipped'],
          ['Wait for mainnet Epoch return', 'skipped']
        ]
          .concat([
            ['Upload mainnet epoch signed EVM 1', 'skipped'],
            ['Upload mainnet epoch signed EVM 2', 'skipped'],
            ['Upload mainnet epoch signed EVM 3', 'skipped'],
            ['Upload mainnet epoch native return claim', 'skipped']
          ])
          .map(([name, conclusion]) => ({ name, status: 'completed', conclusion }))
      }
    ]
  });
  it('recognizes only the exact expired no-authority checkpoint and original failed first gate', () => {
    expect(knownUnspentEpochPreAuthorization(digest, run(), originalJobs(), now)).toBe(true);
  });
  it.each([
    { id: 43619310747 },
    { repository: { id: 1 } },
    { workflow_id: 1 },
    { head_sha: 'a'.repeat(40) },
    { head_branch: 'main' },
    { event: 'schedule' },
    { run_attempt: 2 },
    { status: 'in_progress' },
    { conclusion: 'cancelled' }
  ])('rejects changed original run metadata %j', changed => {
    expect(knownUnspentEpochPreAuthorization(digest, { ...run(), ...changed }, originalJobs(), now)).toBe(false);
  });
  it('rejects any changed raw checkpoint, including hidden authority, amount, nonce or deadline fields', () => {
    expect(knownUnspentEpochPreAuthorization('a'.repeat(64), run(), originalJobs(), now)).toBe(false);
  });
  it.each(['success', 'skipped', 'cancelled'])('rejects a %s first native gate', conclusion => {
    const result = originalJobs();
    result.jobs[0]!.steps[2]!.conclusion = conclusion;
    expect(knownUnspentEpochPreAuthorization(digest, run(), result, now)).toBe(false);
  });
  it.each([3, 4, 5, 6, 7, 8, 9, 10, 11])('rejects attempted downstream step %i', index => {
    const result = originalJobs();
    result.jobs[0]!.steps[index]!.conclusion = 'success';
    expect(knownUnspentEpochPreAuthorization(digest, run(), result, now)).toBe(false);
  });
  it('rejects duplicate or missing native gates and jobs', () => {
    const result = originalJobs();
    result.jobs[0]!.steps.push({ ...result.jobs[0]!.steps[2]! });
    expect(knownUnspentEpochPreAuthorization(digest, run(), result, now)).toBe(false);
    result.jobs[0]!.steps = result.jobs[0]!.steps.filter(step => step.name !== 'Upload Epoch native forward authority');
    expect(knownUnspentEpochPreAuthorization(digest, run(), result, now)).toBe(false);
    expect(knownUnspentEpochPreAuthorization(digest, run(), { jobs: [] }, now)).toBe(false);
    expect(
      knownUnspentEpochPreAuthorization(digest, run(), { jobs: [...originalJobs().jobs, ...originalJobs().jobs] }, now)
    ).toBe(false);
  });
  it('requires exactly both skipped recovery and fresh EVM uploads, not missing or extra occurrences', () => {
    const missing = originalJobs();
    missing.jobs[0]!.steps = missing.jobs[0]!.steps.slice(0, 12);
    expect(knownUnspentEpochPreAuthorization(digest, run(), missing, now)).toBe(false);
    const extra = originalJobs();
    extra.jobs[0]!.steps.push({ ...extra.jobs[0]!.steps[7]! });
    expect(knownUnspentEpochPreAuthorization(digest, run(), extra, now)).toBe(false);
  });
  it('requires exactly both skipped native return-claim uploads', () => {
    const missing = originalJobs();
    missing.jobs[0]!.steps.pop();
    expect(knownUnspentEpochPreAuthorization(digest, run(), missing, now)).toBe(false);
    const extra = originalJobs();
    extra.jobs[0]!.steps.push({ ...extra.jobs[0]!.steps[10]! });
    expect(knownUnspentEpochPreAuthorization(digest, run(), extra, now)).toBe(false);
  });
  it('does not recognize a live original window or invalid observation time', () => {
    for (const time of [Date.parse('2026-11-14T17:24:34.674Z'), NaN])
      expect(knownUnspentEpochPreAuthorization(digest, run(), originalJobs(), time)).toBe(false);
  });
});

describe('provider-scoped mainnet recovery discovery', () => {
  it('never substitutes a swap artifact or swap attempt for Epoch evidence', async () => {
    const selected = await chooseSwapCheckpoint(
      runs,
      async id => ({ artifacts: [artifact(`mainnet-${id === baseline + 2 ? 'swap' : 'epoch'}-final-${id}`)] }),
      async () => jobs('Run mainnet swap forward'),
      baseline,
      'epoch'
    );
    expect(selected).toEqual({ runId: baseline + 1, name: `mainnet-epoch-final-${baseline + 1}`, bootstrap: false });
  });
  it('blocks a cancelled Epoch attempt without its own checkpoint even when swap state exists', async () => {
    await expect(
      chooseSwapCheckpoint(
        runs,
        async id => ({ artifacts: [artifact(`mainnet-swap-final-${id}`)] }),
        async () => jobs('Run mainnet epoch forward'),
        baseline,
        'epoch'
      )
    ).rejects.toThrow(/missing/);
  });
  it('does not replace expired Epoch authorization with an older completed round trip', async () => {
    await expect(
      chooseSwapCheckpoint(
        runs,
        async id => ({
          artifacts: [
            artifact(`mainnet-epoch-${id === baseline + 2 ? 'forward-authorized' : 'final'}-${id}`, id === baseline + 2)
          ]
        }),
        async () => jobs('Run mainnet epoch forward'),
        baseline,
        'epoch'
      )
    ).rejects.toThrow(/expired/);
  });
  it.each(['swap', 'epoch', 'near'])(
    'never downgrades an attempted %s return to its earlier forward authority',
    async provider => {
      const prefix = provider === 'near' ? '1click' : provider;
      await expect(
        chooseSwapCheckpoint(
          runs,
          async id => ({ artifacts: [artifact(`mainnet-${prefix}-forward-authorized-${id}`)] }),
          async () => jobs(`Run mainnet ${provider} reverse`),
          baseline,
          provider
        )
      ).rejects.toThrow(/missing|reverse|return/i);
    }
  );
  it('retains final Epoch SDK authority ahead of its earlier queued collateral snapshot', async () => {
    const selected = await chooseSwapCheckpoint(
      runs,
      async id => ({
        artifacts: [
          artifact(`mainnet-epoch-forward-authorized-${id}`),
          artifact(`mainnet-epoch-forward-sdk-authorized-${id}`)
        ]
      }),
      async () => jobs('Upload Epoch SDK forward authority', 'success'),
      baseline,
      'epoch'
    );
    expect(selected.name).toBe(`mainnet-epoch-forward-sdk-authorized-${baseline + 2}`);
  });
  it('never downgrades a signed Epoch attempt to its earlier queued collateral authorization', async () => {
    await expect(
      chooseSwapCheckpoint(
        runs,
        async id => ({ artifacts: [artifact(`mainnet-epoch-forward-authorized-${id}`)] }),
        async () => jobs('Upload Epoch SDK forward authority', 'success'),
        baseline,
        'epoch'
      )
    ).rejects.toThrow(/missing|SDK|signed/i);
  });
  it('selects the latest signed Epoch journal before an older reverse authorization', async () => {
    const selected = await chooseSwapCheckpoint(
      runs,
      async id => ({
        artifacts: [
          artifact(`mainnet-epoch-reverse-authorized-${id}`),
          artifact(`mainnet-epoch-reverse-signed-1-${id}`),
          artifact(`mainnet-epoch-reverse-signed-3-${id}`),
          artifact(`mainnet-epoch-reverse-signed-2-${id}`)
        ]
      }),
      async () => jobs('Run mainnet epoch reverse'),
      baseline,
      'epoch'
    );
    expect(selected.name).toBe(`mainnet-epoch-reverse-signed-3-${baseline + 2}`);
  });
  it('refuses an expired signed Epoch journal instead of restoring an older unsigned authority', async () => {
    await expect(
      chooseSwapCheckpoint(
        runs,
        async id => ({
          artifacts: [
            artifact(`mainnet-epoch-reverse-signed-3-${id}`, true),
            artifact(`mainnet-epoch-reverse-signed-2-${id}`),
            artifact(`mainnet-epoch-reverse-authorized-${id}`)
          ]
        }),
        async () => jobs('Run mainnet epoch reverse'),
        baseline,
        'epoch'
      )
    ).rejects.toThrow(/expired/);
  });
  it('refuses a missing later signed journal even when an earlier authorization survived', async () => {
    await expect(
      chooseSwapCheckpoint(
        runs,
        async id => ({
          artifacts: [
            artifact(`mainnet-epoch-reverse-signed-2-${id}`),
            artifact(`mainnet-epoch-reverse-authorized-${id}`)
          ]
        }),
        async () => jobs('Upload mainnet epoch signed EVM 3', 'success'),
        baseline,
        'epoch'
      )
    ).rejects.toThrow(/missing|journal/i);
  });
  it('retains the existing 1Click authorization artifact names for NEAR recovery', async () => {
    const selected = await chooseSwapCheckpoint(
      runs,
      async id => ({
        artifacts: [artifact(`mainnet-1click-execute-started-${id}`), artifact(`mainnet-1click-preflight-${id}`)]
      }),
      async () => ({ jobs: [] }),
      baseline,
      'near'
    );
    expect(selected).toEqual({
      runId: baseline + 2,
      name: `mainnet-1click-execute-started-${baseline + 2}`,
      bootstrap: false
    });
  });
  it('does not downgrade an attempted native NEAR send to its earlier read-only preflight when exact forward authority is missing', async () => {
    await expect(
      chooseSwapCheckpoint(
        runs,
        async id => ({ artifacts: [artifact(`mainnet-1click-preflight-${id}`)] }),
        async () => jobs('Run mainnet near forward'),
        baseline,
        'near'
      )
    ).rejects.toThrow(/missing|forward/i);
  });
  it('can recover later complete return authority without requiring a deleted older native forward snapshot', async () => {
    const selected = await chooseSwapCheckpoint(
      runs,
      async id => ({ artifacts: [artifact(`mainnet-1click-return-authorized-${id}`)] }),
      async () => jobs('Run mainnet near forward'),
      baseline,
      'near'
    );
    expect(selected.name).toBe(`mainnet-1click-return-authorized-${baseline + 2}`);
  });
  it('does not bootstrap past an uncheckpointed legacy funded 1Click stage', async () => {
    await expect(
      chooseSwapCheckpoint(
        runs,
        async () => ({ artifacts: [] }),
        async () => jobs('Run funded 1Click swap-out and swap-back acceptance'),
        baseline,
        'near'
      )
    ).rejects.toThrow(/missing/);
  });
  describe.each(['epoch', 'near'])('%s exact staged claim/refund authorization', provider => {
    const prefix = provider === 'near' ? '1click' : provider;
    it.each(['return-authorized', 'refund-authorized'])(
      'restores the newest %s snapshot before older stages',
      async stage => {
        const selected = await chooseSwapCheckpoint(
          runs,
          async id => ({
            artifacts: [
              artifact(`mainnet-${prefix}-${id === baseline + 2 ? stage : 'final'}-${id}`),
              artifact(`mainnet-${prefix}-reverse-authorized-${id}`)
            ]
          }),
          async () => ({ jobs: [] }),
          baseline,
          provider
        );
        expect(selected).toEqual({
          runId: baseline + 2,
          name: `mainnet-${prefix}-${stage}-${baseline + 2}`,
          bootstrap: false
        });
      }
    );
    it.each(['return-authorized', 'refund-authorized'])(
      'refuses expired %s rather than falling back to another authorization',
      async stage => {
        await expect(
          chooseSwapCheckpoint(
            runs,
            async id => ({
              artifacts: [
                artifact(`mainnet-${prefix}-${stage}-${id}`, true),
                artifact(`mainnet-${prefix}-reverse-authorized-${id}`)
              ]
            }),
            async () => ({ jobs: [] }),
            baseline,
            provider
          )
        ).rejects.toThrow(/expired/);
      }
    );
    it.each(['fresh-return', 'recovered-return', 'refund'])(
      'never downgrades an attempted actual %s claim to a pre-claim snapshot',
      async kind => {
        const name =
          kind === 'fresh-return'
            ? `Upload mainnet ${provider} native return claim`
            : `Authorize original ${provider} ${kind === 'refund' ? 'refund' : 'return claim'}`;
        await expect(
          chooseSwapCheckpoint(
            runs,
            async id => ({ artifacts: [artifact(`mainnet-${prefix}-reverse-signed-1-${id}`)] }),
            async () => jobs(name, 'success'),
            baseline,
            provider
          )
        ).rejects.toThrow(/missing|claim|refund/i);
      }
    );
    it('does not mistake a no-op recovery launcher for a funded claim or discard the earlier final checkpoint', async () => {
      const selected = await chooseSwapCheckpoint(
        runs,
        async id => ({ artifacts: id === baseline + 1 ? [artifact(`mainnet-${prefix}-final-${id}`)] : [] }),
        async () => jobs(`Recover prior mainnet ${provider === 'epoch' ? 'Epoch' : 'NEAR'}`, 'success'),
        baseline,
        provider
      );
      expect(selected.name).toBe(`mainnet-${prefix}-final-${baseline + 1}`);
    });
    it('rejects contradictory live return and refund authorities without a final snapshot', async () => {
      await expect(
        chooseSwapCheckpoint(
          runs,
          async id => ({
            artifacts: [
              artifact(`mainnet-${prefix}-return-authorized-${id}`),
              artifact(`mainnet-${prefix}-refund-authorized-${id}`)
            ]
          }),
          async () => ({ jobs: [] }),
          baseline,
          provider
        )
      ).rejects.toThrow(/contradictory/i);
    });
  });
  it('classifies only the requested provider and includes its running reverse stage', () => {
    expect(swapStepAttempted(jobs('Run mainnet epoch forward'), 'forward', 'epoch')).toBe(true);
    expect(swapStepAttempted(jobs('Run mainnet swap forward'), 'forward', 'epoch')).toBe(false);
    expect(
      swapStepAttempted(
        { jobs: [{ steps: [{ name: 'Run mainnet near reverse', status: 'in_progress', conclusion: null }] }] },
        'reverse',
        'near'
      )
    ).toBe(true);
  });
  it.each(['__proto__', 'constructor', '../swap', '1click'])(
    'refuses an unrecognized provider %s before bootstrap',
    async provider => {
      await expect(
        chooseSwapCheckpoint(
          [{ id: baseline }],
          async () => ({ artifacts: [] }),
          async () => ({ jobs: [] }),
          baseline,
          provider
        )
      ).rejects.toThrow(/provider/i);
    }
  );
});
