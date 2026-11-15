import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  exerciseTopologyScenarios,
  findTopologyBundle,
  topologyCleanupBudget,
  topologyIdentity,
  topologyRecoveryIdentity
} from './feature-eligibility-staging-topology.mjs';
import * as topologyRunner from './feature-eligibility-staging-topology.mjs';
import { buildTopologyManifest } from '../services/feature-eligibility/staging-topology-manifest.mjs';
import { TOPOLOGY_SCENARIOS } from '../services/feature-eligibility/staging-topology.mjs';
import { createTopologyApiBudget } from '../services/feature-eligibility/staging-topology-preflight.mjs';

const EXPECTED_TOPOLOGY_SCENARIOS = Object.freeze([
  'cache_reuse',
  'colo_isolation',
  'shared_budget',
  'rate_refusal',
  'wired_rate',
  'native_rate',
  'failure_behavior',
  'restart_day'
]);

const accountId = 'a'.repeat(32);

const context = Object.freeze({
  repository: '0xMiden/wallet',
  workflowPath: '.github/workflows/feature-eligibility-topology.yml',
  ref: 'refs/heads/main',
  eventName: 'workflow_dispatch',
  runId: '123',
  runAttempt: '1',
  sourceSha: 'a'.repeat(40)
});

async function preparedTestRun() {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), 'topology-recovery-test-'));
  const identity = topologyIdentity(context);
  const bundle = new Uint8Array([1, 2, 3]);
  const startedAt = Date.now();
  const expiresAt = startedAt + 8 * 60_000;
  const maxRuns = EXPECTED_TOPOLOGY_SCENARIOS.length;
  const manifest = buildTopologyManifest({ identity, bundle, now: startedAt, expiresAt, maxRuns, inventory: [] });
  const accountSha256 = createHash('sha256').update(accountId).digest('hex');
  const directory = path.join(runnerTemp, 'eligibility-topology-prepared');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'staging-topology-worker.mjs'), bundle, { mode: 0o600 });
  await writeFile(
    path.join(directory, 'prepared.json'),
    `${JSON.stringify({ schema: 1, identity, accountSha256, startedAt, preflightCalls: 1, expiresAt, maxRuns, manifest })}\n`,
    { mode: 0o600 }
  );
  return {
    runnerTemp,
    identity,
    manifest,
    startedAt,
    accountSha256,
    env: {
      GITHUB_REPOSITORY: context.repository,
      GITHUB_REF: context.ref,
      GITHUB_EVENT_NAME: context.eventName,
      GITHUB_RUN_ID: context.runId,
      GITHUB_RUN_ATTEMPT: context.runAttempt,
      GITHUB_SHA: context.sourceSha,
      RUNNER_TEMP: runnerTemp,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: 'token-sentinel'.repeat(3)
    }
  };
}

function topologyBindings(manifest) {
  return [
    ...Object.entries(manifest.config.vars).map(([name, text]) => ({ name, type: 'plain_text', text })),
    { name: 'TOPOLOGY_BEARER', type: 'secret_text' },
    ...manifest.config.durable_objects.bindings.map((binding, index) => ({
      name: binding.name,
      type: 'durable_object_namespace',
      class_name: binding.class_name,
      namespace_id: String(index + 1)
    })),
    ...manifest.config.ratelimits.map(rate => ({ ...rate, type: 'ratelimit' }))
  ];
}

function syntheticReadApi({ manifest, targetAbsentFirst = false, scriptSettings }) {
  const calls = [];
  let settingsReads = 0;
  const settingsPath = `/workers/scripts/${manifest.scriptName}/settings`;
  return {
    calls,
    api: async requestPath => {
      calls.push(requestPath);
      if (requestPath === '/account') return { success: true, errors: [], result: { id: accountId } };
      if (requestPath === settingsPath) {
        settingsReads++;
        if (targetAbsentFirst && settingsReads === 1)
          return { status: 404, body: { success: false, errors: [{ code: 10007 }] } };
        return { success: true, errors: [], result: { bindings: topologyBindings(manifest) } };
      }
      if (requestPath === `/workers/scripts/${manifest.scriptName}/script-settings`)
        return { success: true, errors: [], result: scriptSettings };
      return null;
    }
  };
}

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
  assert.deepEqual(TOPOLOGY_SCENARIOS, EXPECTED_TOPOLOGY_SCENARIOS);
  const calls = [];
  const results = await exerciseTopologyScenarios({
    baseUrl: 'https://miden-elig-topology-123-1.example.workers.dev',
    bearer: 'b'.repeat(32),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const scenario = new URL(url).pathname.split('/').at(-1);
      const status = scenario === 'shared_budget' ? 'failed' : 'passed';
      return new Response(JSON.stringify({ scenario, status }), { status: 200 });
    }
  });

  assert.equal(calls.length, EXPECTED_TOPOLOGY_SCENARIOS.length);
  assert.deepEqual(
    calls.map(({ url }) => new URL(url).pathname.split('/').at(-1)),
    EXPECTED_TOPOLOGY_SCENARIOS
  );
  for (const { options } of calls) {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${'b'.repeat(32)}`);
    assert.equal(options.body, undefined);
  }
  assert.equal(results.length, EXPECTED_TOPOLOGY_SCENARIOS.length);
  assert.equal(results.find(({ scenario }) => scenario === 'shared_budget')?.result, 'failed');
  assert.equal(
    results.filter(result => result.result === 'passed').length,
    EXPECTED_TOPOLOGY_SCENARIOS.length - 1
  );
});

test('topology exercise stops after a transport failure without retrying a scenario', async () => {
  assert.deepEqual(TOPOLOGY_SCENARIOS, EXPECTED_TOPOLOGY_SCENARIOS);
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
  assert.deepEqual(results, [{ scenario: 'cache_reuse', result: 'unavailable' }]);
});

test('execution writes only sanitized ownership diagnostics while staying fail-closed', async t => {
  assert.equal(typeof topologyRunner.execute, 'function');
  const prepared = await preparedTestRun();
  try {
    const fixture = syntheticReadApi({
      manifest: prepared.manifest,
      targetAbsentFirst: true,
      scriptSettings: { logpush: false, observability: null, tail_consumers: [] }
    });
    const scenarioRequests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      scenarioRequests.push({ url: String(url), method: options?.method });
      throw new Error('scenario_transport_blocked');
    });
    let deployments = 0;
    const exitCode = await topologyRunner.execute(prepared.env, {
      createReadApi: () => fixture.api,
      runCommand: async () => {
        deployments++;
        return { code: 0 };
      }
    });
    const result = JSON.parse(
      await readFile(path.join(prepared.runnerTemp, 'eligibility-topology-result', 'result.json'), 'utf8')
    );

    assert.equal(exitCode, 1);
    assert.equal(result.ownership, 'not_observed');
    assert.equal(result.reason, 'deployed_worker_ownership_not_verified');
    assert.deepEqual(result.ownershipDiagnostic, { gate: 'script_observability', form: 'null' });
    assert.equal(deployments, 1);
    assert.equal(scenarioRequests.filter(({ url }) => url.includes('/scenario/')).length, 0);

    const counterfactual = await exerciseTopologyScenarios({
      baseUrl: 'https://miden-elig-topology-123-1.example.workers.dev',
      bearer: 'b'.repeat(32)
    });
    assert.deepEqual(counterfactual, [{ scenario: 'cache_reuse', result: 'unavailable' }]);
    assert.equal(scenarioRequests.length, 1);
    assert.equal(scenarioRequests[0].method, 'POST');
    assert.equal(scenarioRequests[0].url, 'https://miden-elig-topology-123-1.example.workers.dev/scenario/cache_reuse');
  } finally {
    await rm(prepared.runnerTemp, { recursive: true, force: true });
  }
});

test('execution posts all fixed scenarios to the observed route with its deployed bearer', async t => {
  const prepared = await preparedTestRun();
  try {
    const { manifest } = prepared;
    const basePath = `/workers/scripts/${manifest.scriptName}`;
    const baseUrl = `https://${manifest.scriptName}.observed-topology.workers.dev`;
    const namespaces = manifest.config.durable_objects.bindings.map((binding, index) => ({
      id: String(index + 1).padStart(32, '0'),
      class: binding.class_name,
      script: manifest.scriptName,
      use_sqlite: true
    }));
    const bindings = topologyBindings(manifest).map(binding =>
      binding.type === 'durable_object_namespace'
        ? { ...binding, namespace_id: namespaces.find(row => row.class === binding.class_name).id }
        : binding
    );
    const page = (result, perPage) => ({
      success: true,
      errors: [],
      result,
      result_info: { page: 1, per_page: perPage, count: result.length, total_pages: 1, total_count: result.length }
    });
    let deployments = 0;
    let expectedBearer;
    const scenarioRequests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      scenarioRequests.push({ url: String(url), options });
      const scenario = new URL(url).pathname.split('/').at(-1);
      return new Response(JSON.stringify({ scenario, status: 'passed' }), { status: 200 });
    });
    const exitCode = await topologyRunner.execute(prepared.env, {
      createReadApi: () => async requestPath => {
        if (requestPath === '/account') return { success: true, errors: [], result: { id: accountId } };
        if (requestPath === `${basePath}/settings`) {
          return deployments === 0
            ? { status: 404, body: { success: false, errors: [{ code: 10007 }] } }
            : { success: true, errors: [], result: { bindings } };
        }
        if (requestPath === `${basePath}/script-settings`)
          return {
            success: true,
            errors: [],
            result: { logpush: false, observability: manifest.config.observability, tail_consumers: [] }
          };
        if (requestPath === `${basePath}/content/v2`) return { sha256: manifest.bundleSha256 };
        if (requestPath === '/workers/scripts?page=1&per_page=100')
          return page([{ id: manifest.scriptName }], 100);
        if (requestPath === '/workers/durable_objects/namespaces?page=1&per_page=1000')
          return page(namespaces, 1000);
        if (requestPath === '/workers/subdomain')
          return { success: true, errors: [], result: { subdomain: 'observed-topology' } };
        if (requestPath === `${basePath}/subdomain`)
          return { success: true, errors: [], result: { enabled: true, previews_enabled: false } };
        assert.fail(`unexpected synthetic API path: ${requestPath}`);
      },
      runCommand: async (_executable, args) => {
        deployments++;
        const secretsFile = args[args.indexOf('--secrets-file') + 1];
        expectedBearer = JSON.parse(await readFile(secretsFile, 'utf8')).TOPOLOGY_BEARER;
        return { code: 0 };
      }
    });
    const result = JSON.parse(
      await readFile(path.join(prepared.runnerTemp, 'eligibility-topology-result', 'result.json'), 'utf8')
    );

    assert.equal(exitCode, 0);
    assert.equal(result.reason, 'complete');
    assert.equal(result.ownership, 'verified');
    assert.equal(deployments, 1);
    assert.equal(typeof expectedBearer, 'string');
    assert.ok(expectedBearer.length >= 32);
    assert.equal(scenarioRequests.length, EXPECTED_TOPOLOGY_SCENARIOS.length);
    assert.deepEqual(
      scenarioRequests.map(({ url }) => url),
      EXPECTED_TOPOLOGY_SCENARIOS.map(scenario => `${baseUrl}/scenario/${scenario}`)
    );
    for (const { options } of scenarioRequests) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, `Bearer ${expectedBearer}`);
      assert.equal(options.body, undefined);
    }
    assert.deepEqual(
      result.scenarioResults,
      EXPECTED_TOPOLOGY_SCENARIOS.map(scenario => ({ scenario, result: 'passed' }))
    );
  } finally {
    await rm(prepared.runnerTemp, { recursive: true, force: true });
  }
});

test('cleanup writes a sanitized ownership diagnostic without deleting or contacting a provider', async () => {
  assert.equal(typeof topologyRunner.cleanup, 'function');
  const prepared = await preparedTestRun();
  try {
    await writeFile(
      path.join(prepared.runnerTemp, 'eligibility-topology-prepared', 'run-state.json'),
      `${JSON.stringify({
        schema: 1,
        identity: prepared.identity,
        accountSha256: prepared.accountSha256,
        startedAt: prepared.startedAt,
        preflightCalls: 1,
        cleanupCalls: 0,
        cleanupStartedAt: null,
        cleanupDeadlineAt: null,
        deploymentAttempted: false,
        deploymentExitCode: null,
        phase: 'ready'
      })}\n`
    );
    const fixture = syntheticReadApi({
      manifest: prepared.manifest,
      scriptSettings: { logpush: false, observability: null, tail_consumers: null }
    });
    let deletions = 0;
    const exitCode = await topologyRunner.cleanup(prepared.env, false, {
      createReadApi: () => fixture.api,
      createScriptDeleter: () => async () => {
        deletions++;
        return true;
      }
    });
    const result = JSON.parse(
      await readFile(path.join(prepared.runnerTemp, 'eligibility-topology-result', 'result.json'), 'utf8')
    );

    assert.equal(exitCode, 1);
    assert.equal(result.cleanup, 'blocked');
    assert.equal(result.reason, 'ownership_mismatch');
    assert.deepEqual(result.ownershipDiagnostic, { gate: 'script_tail_consumers', form: 'unexpected_type' });
    assert.equal(deletions, 0);
  } finally {
    await rm(prepared.runnerTemp, { recursive: true, force: true });
  }
});
