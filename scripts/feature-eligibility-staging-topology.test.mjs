import assert from 'node:assert/strict';
import test from 'node:test';

import {
  exerciseTopologyScenarios,
  findTopologyBundle,
  topologyCleanupBudget,
  topologyIdentity,
  topologyRecoveryIdentity
} from './feature-eligibility-staging-topology.mjs';
import { TOPOLOGY_SCENARIOS } from '../services/feature-eligibility/staging-topology.mjs';
import { createTopologyApiBudget } from '../services/feature-eligibility/staging-topology-preflight.mjs';

const context = Object.freeze({
  repository: '0xMiden/wallet',
  workflowPath: '.github/workflows/feature-eligibility-topology.yml',
  ref: 'refs/heads/main',
  eventName: 'workflow_dispatch',
  runId: '123',
  runAttempt: '1',
  sourceSha: 'a'.repeat(40)
});

test('topology identity accepts only this repository main workflow dispatch', () => {
  assert.deepEqual(topologyIdentity(context), {
    repository: context.repository,
    workflowPath: context.workflowPath,
    runId: context.runId,
    runAttempt: context.runAttempt,
    sourceSha: context.sourceSha
  });
  assert.throws(() => topologyIdentity({ ...context, ref: 'refs/heads/branch' }), /untrusted_workflow_context/);
  assert.throws(() => topologyIdentity({ ...context, repository: 'fork/wallet' }), /untrusted_workflow_context/);
});

test('recovery identity preserves the validated original run identity', () => {
  const recovery = { schema: 1, runId: '456', runAttempt: '1' };
  const previous = { schema: 1, identity: { ...topologyIdentity(context), runId: '456' } };
  const selected = { selectedRunId: '456', selectedRunAttempt: '1' };

  assert.deepEqual(topologyRecoveryIdentity({ recovery, previous, ...selected }), previous.identity);
  assert.throws(
    () => topologyRecoveryIdentity({ recovery: { ...recovery, runId: '457' }, previous, ...selected }),
    /recovery_identity_mismatch/
  );
  assert.throws(
    () => topologyRecoveryIdentity({ recovery: { ...recovery, runAttempt: '2' }, previous, ...selected }),
    /recovery_identity_mismatch/
  );
  assert.throws(
    () => topologyRecoveryIdentity({ recovery, previous, selectedRunId: '458', selectedRunAttempt: '1' }),
    /recovery_identity_mismatch/
  );
  assert.throws(
    () => topologyRecoveryIdentity({ recovery, previous: { ...previous, identity: { ...previous.identity, sourceSha: 'invalid' } }, ...selected }),
    /recovery_identity_mismatch/
  );
});

test('cleanup recovery carries the original cleanup deadline and consumed request counts', () => {
  const previousReads = {
    preflight: 240,
    cleanup: 12,
    total: 252,
    elapsedMs: 155_000,
    preflightStartedAt: 1_000,
    preflightDeadlineAt: 121_000,
    cleanupStartedAt: 120_000,
    cleanupDeadlineAt: 240_000,
    preflightElapsedMs: 155_000,
    cleanupElapsedMs: 35_000
  };

  assert.deepEqual(
    topologyCleanupBudget({ previousReads, preflightStartedAt: 1_000, now: () => 300_000 }),
    {
      cleanupStartedAt: 120_000,
      initialCalls: { preflight: 240, cleanup: 12 }
    }
  );
});

test('cleanup refuses to spend provider reads without a valid predecessor budget', () => {
  assert.throws(
    () => topologyCleanupBudget({ preflightStartedAt: 1_000, now: () => 300_000 }),
    /cleanup_budget_lineage_unavailable/
  );
  assert.throws(
    () =>
      topologyCleanupBudget({
        previousReads: { preflight: 240, cleanup: 12 },
        preflightStartedAt: 1_000,
        now: () => 300_000
      }),
    /cleanup_budget_lineage_unavailable/
  );
});

test('a second cleanup continuation cannot regain reads spent by its predecessor', async () => {
  let calls = 0;
  const makeBudget = previousReads => {
    const { cleanupStartedAt, initialCalls } = topologyCleanupBudget({
      previousReads,
      preflightStartedAt: 1_000,
      now: () => 130_000
    });
    return createTopologyApiBudget(
      async () => {
        calls++;
        return {};
      },
      {
        now: () => 130_000,
        startedAt: 1_000,
        cleanupStartedAt,
        initialCalls
      }
    );
  };
  const predecessor = {
    preflight: 250,
    cleanup: 249,
    total: 499,
    elapsedMs: 129_000,
    preflightStartedAt: 1_000,
    preflightDeadlineAt: 121_000,
    cleanupStartedAt: 120_000,
    cleanupDeadlineAt: 240_000,
    preflightElapsedMs: 129_000,
    cleanupElapsedMs: 10_000
  };
  const first = makeBudget(predecessor);
  await first.cleanup('/account');
  const predecessorStats = first.stats();
  const second = makeBudget(predecessorStats);

  await assert.rejects(second.cleanup('/account'), /budget/);
  assert.equal(calls, 1);
  const continuedStats = second.stats();
  assert.equal(continuedStats.preflight, predecessorStats.preflight);
  assert.equal(continuedStats.cleanup, predecessorStats.cleanup);
  assert.equal(continuedStats.cleanupStartedAt, predecessorStats.cleanupStartedAt);
  assert.equal(continuedStats.cleanupDeadlineAt, predecessorStats.cleanupDeadlineAt);
});

test('topology bundle selects the exact worker entrypoint inside the dry-run output directory', () => {
  assert.equal(
    findTopologyBundle({
      metafile: {
        inputs: {},
        outputs: {
          '/tmp/bundle/worker.mjs': {
            entryPoint: '/repo/services/feature-eligibility/staging-topology-worker.mjs',
            imports: []
          }
        }
      },
      bundleDirectory: '/tmp/bundle',
      sourceFile: 'services/feature-eligibility/staging-topology-worker.mjs',
      cwd: '/repo'
    }),
    '/tmp/bundle/worker.mjs'
  );
  assert.throws(
    () =>
      findTopologyBundle({
        metafile: {
          inputs: {},
          outputs: {
            '/tmp/other/worker.mjs': {
              entryPoint: '/repo/services/feature-eligibility/staging-topology-worker.mjs',
              imports: []
            }
          }
        },
        bundleDirectory: '/tmp/bundle',
        sourceFile: 'services/feature-eligibility/staging-topology-worker.mjs',
        cwd: '/repo'
      }),
    /bundle_outside_directory/
  );
});

test('topology exercise sends each fixed scenario once and rejects non-passing responses', async () => {
  const calls = [];
  const results = await exerciseTopologyScenarios({
    baseUrl: 'https://miden-elig-topology-123-1.example.workers.dev',
    bearer: 'b'.repeat(32),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const scenario = new URL(url).pathname.split('/').at(-1);
      const status = scenario === TOPOLOGY_SCENARIOS[2] ? 'failed' : 'passed';
      return new Response(JSON.stringify({ scenario, status }), { status: 200 });
    }
  });

  assert.equal(calls.length, TOPOLOGY_SCENARIOS.length);
  assert.deepEqual(
    calls.map(({ url }) => new URL(url).pathname.split('/').at(-1)),
    TOPOLOGY_SCENARIOS
  );
  for (const { options } of calls) {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${'b'.repeat(32)}`);
    assert.equal(options.body, undefined);
  }
  assert.equal(results.length, TOPOLOGY_SCENARIOS.length);
  assert.equal(results[2].result, 'failed');
  assert.equal(results.filter(result => result.result === 'passed').length, TOPOLOGY_SCENARIOS.length - 1);
});

test('topology exercise stops after a transport failure without retrying a scenario', async () => {
  const calls = [];
  const results = await exerciseTopologyScenarios({
    baseUrl: 'https://miden-elig-topology-123-1.example.workers.dev',
    bearer: 'b'.repeat(32),
    fetchImpl: async url => {
      calls.push(url);
      throw new Error('network unavailable');
    }
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(results, [{ scenario: TOPOLOGY_SCENARIOS[0], result: 'unavailable' }]);
});
