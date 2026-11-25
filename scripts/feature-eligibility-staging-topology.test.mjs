import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

function deletableWorkerFixture(manifest) {
  const basePath = `/workers/scripts/${manifest.scriptName}`;
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
  let deleted = false;
  return {
    isDeleted: () => deleted,
    options: {
      createReadApi: () => async requestPath => {
        if (requestPath === '/account') return { success: true, errors: [], result: { id: accountId } };
        if (requestPath === `${basePath}/settings`) {
          return deleted
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
        assert.fail(`unexpected synthetic API path: ${requestPath}`);
      },
      createScriptDeleter: () => async scriptName => {
        assert.equal(scriptName, manifest.scriptName);
        deleted = true;
        return true;
      }
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

test('recovery identity supports interrupted initial runs with null resultArtifactId and rejects mixed inputs', () => {
  const recovery = {
    schema: 1,
    repository: context.repository,
    workflowPath: context.workflowPath,
    runId: '456',
    runAttempt: '1',
    sourceSha: context.sourceSha,
    artifactId: '1234',
    resultArtifactId: null
  };
  assert.deepEqual(
    topologyRecoveryIdentity({ recovery, selectedRunId: '456', selectedRunAttempt: '1' }),
    {
      repository: context.repository,
      workflowPath: context.workflowPath,
      runId: '456',
      runAttempt: '1',
      sourceSha: context.sourceSha
    }
  );
  assert.throws(
    () =>
      topologyRecoveryIdentity({
        recovery,
        previous: { schema: 1, identity: { ...topologyIdentity(context), runId: '456' } },
        selectedRunId: '456',
        selectedRunAttempt: '1'
      }),
    /recovery_identity_mismatch/
  );
  assert.throws(
    () =>
      topologyRecoveryIdentity({
        recovery: { ...recovery, resultArtifactId: '5678' },
        selectedRunId: '456',
        selectedRunAttempt: '1'
      }),
    /recovery_identity_mismatch/
  );
});

test('cleanup budget supports explicit prepared fallback within preflight cap and preserves strict failure without it', () => {
  assert.deepEqual(
    topologyCleanupBudget({ preflightStartedAt: 1_000, allowPreparedFallback: true, now: () => 300_000 }),
    {
      cleanupStartedAt: 300_000,
      initialCalls: { preflight: 250, cleanup: 0 }
    }
  );
  assert.deepEqual(
    topologyCleanupBudget({ preflightStartedAt: 500_000, allowPreparedFallback: true, now: () => 300_000 }),
    {
      cleanupStartedAt: 500_000,
      initialCalls: { preflight: 250, cleanup: 0 }
    }
  );
});

test('execution persists deploymentAttempted and live preflight reads to result.json before deploy completes', async t => {
  const prepared = await preparedTestRun();
  try {
    const { manifest } = prepared;
    const basePath = `/workers/scripts/${manifest.scriptName}`;
    const resultFile = path.join(prepared.runnerTemp, 'eligibility-topology-result', 'result.json');
    let snapshotDuringDeploy = null;
    let snapshotDuringOwnership = null;
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
    await topologyRunner.execute(prepared.env, {
      createReadApi: () => async requestPath => {
        if (requestPath === `${basePath}/settings`) {
          if (snapshotDuringDeploy !== null && snapshotDuringOwnership === null) {
            snapshotDuringOwnership = JSON.parse(await readFile(resultFile, 'utf8'));
          }
          return snapshotDuringDeploy === null
            ? { status: 404, body: { success: false, errors: [{ code: 10007 }] } }
            : { success: true, errors: [], result: { bindings: [] } };
        }
        if (requestPath === '/account') return { success: true, errors: [], result: { id: accountId } };
        if (requestPath === `${basePath}/script-settings`)
          return { success: true, errors: [], result: { logpush: false, observability: null, tail_consumers: [] } };
        return null;
      },
      runCommand: async () => {
        try {
          snapshotDuringDeploy = JSON.parse(await readFile(resultFile, 'utf8'));
        } catch {
          snapshotDuringDeploy = { missing: true };
        }
        return { code: 0 };
      }
    });

    assert.equal(snapshotDuringDeploy.missing, undefined);
    assert.equal(snapshotDuringDeploy.deploymentAttempted, true);
    assert.equal(snapshotDuringDeploy.providerReads.preflight, 2);
    assert.equal(snapshotDuringOwnership.deploymentAttempted, true);
    assert.ok(snapshotDuringOwnership.providerReads.preflight > 2);
  } finally {
    await rm(prepared.runnerTemp, { recursive: true, force: true });
  }
});

test('cleanup and recovery cleanup flush live read counts and deadline to result.json before completion', async () => {
  const prepared = await preparedTestRun();
  try {
    const resultFile = path.join(prepared.runnerTemp, 'eligibility-topology-result', 'result.json');
    const preflightReads = {
      preflight: 20,
      cleanup: 0,
      total: 20,
      elapsedMs: 5_000,
      preflightStartedAt: prepared.startedAt,
      preflightDeadlineAt: prepared.startedAt + 120_000,
      cleanupStartedAt: null,
      cleanupDeadlineAt: null,
      preflightElapsedMs: 5_000,
      cleanupElapsedMs: null
    };
    await mkdir(path.dirname(resultFile), { recursive: true, mode: 0o700 });
    await writeFile(
      resultFile,
      `${JSON.stringify({
        schema: 1,
        identity: prepared.identity,
        phase: 'execution',
        deploymentAttempted: true,
        providerReads: preflightReads
      })}\n`,
      { mode: 0o600 }
    );
    const fixture = syntheticReadApi({
      manifest: prepared.manifest,
      scriptSettings: { logpush: false, observability: null, tail_consumers: null }
    });
    let reads = 0;
    let midCleanupSnapshot = null;
    await topologyRunner.cleanup(prepared.env, false, {
      createReadApi: () => async requestPath => {
        reads++;
        if (reads === 2) {
          midCleanupSnapshot = JSON.parse(await readFile(resultFile, 'utf8'));
        }
        return fixture.api(requestPath);
      },
      createScriptDeleter: () => async () => false
    });

    assert.equal(midCleanupSnapshot.phase, 'cleanup');
    assert.equal(midCleanupSnapshot.cleanup, 'pending');
    assert.equal(midCleanupSnapshot.providerReads.cleanup, 2);
    assert.equal(typeof midCleanupSnapshot.providerReads.cleanupStartedAt, 'number');
    assert.equal(
      midCleanupSnapshot.providerReads.cleanupDeadlineAt,
      midCleanupSnapshot.providerReads.cleanupStartedAt + 120_000
    );

    const recoveryRunnerTemp = await mkdtemp(path.join(tmpdir(), 'topology-recovery-mid-'));
    try {
      const recoveryDir = path.join(recoveryRunnerTemp, 'eligibility-topology-recovery');
      const prepDir = path.join(recoveryRunnerTemp, 'eligibility-topology-prepared');
      const priorPath = path.join(recoveryRunnerTemp, 'prior-result.json');
      const recoveryResultFile = path.join(recoveryRunnerTemp, 'eligibility-topology-result', 'result.json');
      await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
      await mkdir(prepDir, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(recoveryDir, 'recovery.json'),
        `${JSON.stringify({
          schema: 1,
          repository: context.repository,
          workflowPath: context.workflowPath,
          runId: context.runId,
          runAttempt: context.runAttempt,
          sourceSha: context.sourceSha,
          artifactId: '1234',
          resultArtifactId: '5678'
        })}\n`,
        { mode: 0o600 }
      );
      await writeFile(
        path.join(prepDir, 'prepared.json'),
        await readFile(path.join(prepared.runnerTemp, 'eligibility-topology-prepared', 'prepared.json'), 'utf8'),
        { mode: 0o600 }
      );
      await writeFile(
        path.join(prepDir, 'staging-topology-worker.mjs'),
        await readFile(path.join(prepared.runnerTemp, 'eligibility-topology-prepared', 'staging-topology-worker.mjs'))
      );
      await writeFile(priorPath, `${JSON.stringify(midCleanupSnapshot)}\n`, { mode: 0o600 });

      let recoveredReads = 0;
      let midRecoveredSnapshot = null;
      await topologyRunner.cleanup(
        {
          ...prepared.env,
          RUNNER_TEMP: recoveryRunnerTemp,
          TOPOLOGY_RECOVERY_FILE: path.join(recoveryDir, 'recovery.json'),
          TOPOLOGY_PRIOR_RESULT_FILE: priorPath,
          CLEANUP_RUN_ID: context.runId,
          CLEANUP_ATTEMPT: context.runAttempt
        },
        true,
        {
          createReadApi: () => async requestPath => {
            recoveredReads++;
            if (recoveredReads === 2) {
              midRecoveredSnapshot = JSON.parse(await readFile(recoveryResultFile, 'utf8'));
            }
            return fixture.api(requestPath);
          },
          createScriptDeleter: () => async () => false
        }
      );

      assert.equal(midRecoveredSnapshot.phase, 'recovery_cleanup');
      assert.equal(midRecoveredSnapshot.deploymentAttempted, true);
      assert.equal(midRecoveredSnapshot.providerReads.cleanup, 4);
      assert.equal(
        midRecoveredSnapshot.providerReads.cleanupStartedAt,
        midCleanupSnapshot.providerReads.cleanupStartedAt
      );
      assert.equal(
        midRecoveredSnapshot.providerReads.cleanupDeadlineAt,
        midCleanupSnapshot.providerReads.cleanupDeadlineAt
      );
    } finally {
      await rm(recoveryRunnerTemp, { recursive: true, force: true });
    }
  } finally {
    await rm(prepared.runnerTemp, { recursive: true, force: true });
  }
});

test('recovery cleans up a deployed worker from verified prepared artifact when prior result artifact is absent', async () => {
  const prepared = await preparedTestRun();
  try {
    const { manifest } = prepared;
    const resultFile = path.join(prepared.runnerTemp, 'eligibility-topology-result', 'result.json');
    await mkdir(path.dirname(resultFile), { recursive: true, mode: 0o700 });
    await writeFile(
      resultFile,
      `${JSON.stringify({
        schema: 1,
        identity: prepared.identity,
        providerReads: {
          preflight: 10,
          cleanup: 99,
          total: 109,
          elapsedMs: 1_000,
          preflightStartedAt: prepared.startedAt,
          preflightDeadlineAt: prepared.startedAt + 120_000,
          cleanupStartedAt: prepared.startedAt,
          cleanupDeadlineAt: prepared.startedAt + 120_000,
          preflightElapsedMs: 1_000,
          cleanupElapsedMs: 0
        }
      })}\n`,
      { mode: 0o600 }
    );
    const recoveryDir = path.join(prepared.runnerTemp, 'eligibility-topology-recovery');
    await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(recoveryDir, 'recovery.json'),
      `${JSON.stringify({
        schema: 1,
        repository: context.repository,
        workflowPath: context.workflowPath,
        runId: context.runId,
        runAttempt: context.runAttempt,
        sourceSha: context.sourceSha,
        artifactId: '1234',
        resultArtifactId: null
      })}\n`,
      { mode: 0o600 }
    );
    const fixture = deletableWorkerFixture(manifest);
    const exitCode = await topologyRunner.cleanup(
      {
        ...prepared.env,
        TOPOLOGY_RECOVERY_FILE: path.join(recoveryDir, 'recovery.json'),
        TOPOLOGY_PRIOR_RESULT_FILE: '',
        CLEANUP_RUN_ID: context.runId,
        CLEANUP_ATTEMPT: context.runAttempt
      },
      true,
      fixture.options
    );
    const result = JSON.parse(await readFile(resultFile, 'utf8'));

    assert.equal(exitCode, 0);
    assert.equal(fixture.isDeleted(), true);
    assert.equal(result.phase, 'recovery_cleanup');
    assert.equal(result.cleanup, 'removed');
    assert.equal(result.providerReads.preflight, 250);
    assert.ok(result.providerReads.cleanup > 0 && result.providerReads.cleanup < 99);
    assert.equal(result.providerReads.total, 250 + result.providerReads.cleanup);

    await assert.rejects(
      topologyRunner.cleanup(
        {
          ...prepared.env,
          TOPOLOGY_RECOVERY_FILE: path.join(recoveryDir, 'recovery.json'),
          TOPOLOGY_PRIOR_RESULT_FILE: path.join(prepared.runnerTemp, 'unexpected.json'),
          CLEANUP_RUN_ID: context.runId,
          CLEANUP_ATTEMPT: context.runAttempt
        },
        true
      ),
      /invalid_recovery_receipt/
    );

    const priorPath = path.join(prepared.runnerTemp, 'prior-for-mismatch.json');
    await writeFile(priorPath, `${JSON.stringify({ schema: 1, identity: prepared.identity })}\n`, { mode: 0o600 });
    await writeFile(
      path.join(recoveryDir, 'recovery.json'),
      `${JSON.stringify({
        schema: 1,
        repository: context.repository,
        workflowPath: context.workflowPath,
        runId: context.runId,
        runAttempt: context.runAttempt,
        sourceSha: 'c'.repeat(40),
        artifactId: '1234',
        resultArtifactId: '5678'
      })}\n`,
      { mode: 0o600 }
    );
    await assert.rejects(
      topologyRunner.cleanup(
        {
          ...prepared.env,
          TOPOLOGY_RECOVERY_FILE: path.join(recoveryDir, 'recovery.json'),
          TOPOLOGY_PRIOR_RESULT_FILE: priorPath,
          CLEANUP_RUN_ID: context.runId,
          CLEANUP_ATTEMPT: context.runAttempt
        },
        true
      ),
      /invalid_recovery_receipt/
    );
  } finally {
    await rm(prepared.runnerTemp, { recursive: true, force: true });
  }
});

test('recovery supports multi-hop cleanup continuations when main advances after original run', async () => {
  const prepared = await preparedTestRun();
  try {
    const recoveryDir = path.join(prepared.runnerTemp, 'eligibility-topology-recovery');
    const priorPath = path.join(prepared.runnerTemp, 'prior-cleanup-result.json');
    const resultFile = path.join(prepared.runnerTemp, 'eligibility-topology-result', 'result.json');
    const cleanupRunId = '99999';
    const cleanupAttempt = '1';
    const advancedSha = 'd'.repeat(40);
    await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
    await writeFile(
      priorPath,
      `${JSON.stringify({
        schema: 1,
        identity: prepared.identity,
        phase: 'recovery_cleanup',
        deploymentAttempted: true,
        cleanup: 'pending',
        reason: null,
        providerReads: {
          preflight: 25,
          cleanup: 3,
          total: 28,
          elapsedMs: 1_000,
          preflightStartedAt: prepared.startedAt,
          preflightDeadlineAt: prepared.startedAt + 120_000,
          cleanupStartedAt: prepared.startedAt,
          cleanupDeadlineAt: prepared.startedAt + 120_000,
          preflightElapsedMs: 1_000,
          cleanupElapsedMs: 500
        }
      })}\n`,
      { mode: 0o600 }
    );
    await writeFile(
      path.join(recoveryDir, 'recovery.json'),
      `${JSON.stringify({
        schema: 1,
        repository: context.repository,
        workflowPath: context.workflowPath,
        runId: cleanupRunId,
        runAttempt: cleanupAttempt,
        sourceSha: advancedSha,
        artifactId: '1234',
        resultArtifactId: '5678'
      })}\n`,
      { mode: 0o600 }
    );

    const fixture = deletableWorkerFixture(prepared.manifest);
    const exitCode = await topologyRunner.cleanup(
      {
        ...prepared.env,
        TOPOLOGY_RECOVERY_FILE: path.join(recoveryDir, 'recovery.json'),
        TOPOLOGY_PRIOR_RESULT_FILE: priorPath,
        CLEANUP_RUN_ID: cleanupRunId,
        CLEANUP_ATTEMPT: cleanupAttempt
      },
      true,
      fixture.options
    );
    const result = JSON.parse(await readFile(resultFile, 'utf8'));

    assert.equal(exitCode, 0);
    assert.equal(fixture.isDeleted(), true);
    assert.equal(result.phase, 'recovery_cleanup');
    assert.equal(result.cleanup, 'removed');
    assert.deepEqual(result.identity, prepared.identity);
  } finally {
    await rm(prepared.runnerTemp, { recursive: true, force: true });
  }
});

test('cli failure handler preserves existing valid result.json instead of clobbering lineage', async () => {
  const prepared = await preparedTestRun();
  try {
    const resultFile = path.join(prepared.runnerTemp, 'eligibility-topology-result', 'result.json');
    const existing = {
      schema: 1,
      identity: prepared.identity,
      phase: 'execution',
      deploymentAttempted: true,
      providerReads: {
        preflight: 12,
        cleanup: 0,
        total: 12,
        elapsedMs: 1_000,
        preflightStartedAt: prepared.startedAt,
        preflightDeadlineAt: prepared.startedAt + 120_000,
        cleanupStartedAt: null,
        cleanupDeadlineAt: null,
        preflightElapsedMs: 1_000,
        cleanupElapsedMs: null
      }
    };
    await mkdir(path.dirname(resultFile), { recursive: true, mode: 0o700 });
    await writeFile(resultFile, `${JSON.stringify(existing)}\n`, { mode: 0o600 });

    const scriptPath = fileURLToPath(new URL('./feature-eligibility-staging-topology.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [scriptPath, 'cleanup'], {
      env: { ...prepared.env, CLOUDFLARE_API_TOKEN: 'bad' },
      encoding: 'utf8'
    });

    assert.equal(run.status, 1);
    const after = JSON.parse(await readFile(resultFile, 'utf8'));
    assert.deepEqual(after, existing);

    const recoveryRunnerTemp = await mkdtemp(path.join(tmpdir(), 'topology-cli-recovered-'));
    try {
      const priorPath = path.join(recoveryRunnerTemp, 'prior.json');
      const recoveredResultFile = path.join(recoveryRunnerTemp, 'eligibility-topology-result', 'result.json');
      await writeFile(priorPath, `${JSON.stringify(existing)}\n`, { mode: 0o600 });
      const recoveredRun = spawnSync(process.execPath, [scriptPath, 'cleanup-recovered'], {
        env: {
          ...prepared.env,
          RUNNER_TEMP: recoveryRunnerTemp,
          TOPOLOGY_PRIOR_RESULT_FILE: priorPath,
          CLOUDFLARE_API_TOKEN: 'bad'
        },
        encoding: 'utf8'
      });
      assert.equal(recoveredRun.status, 1);
      const recoveredAfter = JSON.parse(await readFile(recoveredResultFile, 'utf8'));
      assert.deepEqual(recoveredAfter, {
        ...existing,
        phase: 'recovery_cleanup',
        cleanup: 'blocked',
        reason: 'cleanup_failed'
      });
    } finally {
      await rm(recoveryRunnerTemp, { recursive: true, force: true });
    }
  } finally {
    await rm(prepared.runnerTemp, { recursive: true, force: true });
  }
});

test('cli failure handler preserves validated identity and conservative reads for null-result cleanup-recovered', async () => {
  const prepared = await preparedTestRun();
  try {
    const scriptPath = fileURLToPath(new URL('./feature-eligibility-staging-topology.mjs', import.meta.url));
    const recoveryDir = path.join(prepared.runnerTemp, 'eligibility-topology-recovery');
    const recoveryFile = path.join(recoveryDir, 'recovery.json');
    const resultFile = path.join(prepared.runnerTemp, 'eligibility-topology-result', 'result.json');
    await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
    const validRecovery = {
      schema: 1,
      repository: context.repository,
      workflowPath: context.workflowPath,
      runId: context.runId,
      runAttempt: context.runAttempt,
      sourceSha: context.sourceSha,
      artifactId: '1234',
      resultArtifactId: null
    };
    await writeFile(recoveryFile, `${JSON.stringify(validRecovery)}\n`, { mode: 0o600 });

    const runBadToken = spawnSync(process.execPath, [scriptPath, 'cleanup-recovered'], {
      env: {
        ...prepared.env,
        TOPOLOGY_RECOVERY_FILE: recoveryFile,
        TOPOLOGY_PRIOR_RESULT_FILE: '',
        CLEANUP_RUN_ID: context.runId,
        CLEANUP_ATTEMPT: context.runAttempt,
        CLOUDFLARE_API_TOKEN: 'bad'
      },
      encoding: 'utf8'
    });
    assert.equal(runBadToken.status, 1);
    const written = JSON.parse(await readFile(resultFile, 'utf8'));
    assert.deepEqual(written.identity, prepared.identity);
    assert.equal(written.phase, 'recovery_cleanup');
    assert.equal(written.cleanup, 'blocked');
    assert.equal(written.reason, 'cleanup_failed');
    assert.equal(written.deploymentAttempted, 'unknown');
    assert.equal(written.providerReads.preflight, 250);
    assert.equal(written.providerReads.cleanup, 0);
    assert.equal(written.providerReads.total, 250);

    // Verify a follow-up cleanup-recovered continuation consumes this fallback result.json cleanly.
    const nextTemp = await mkdtemp(path.join(tmpdir(), 'topology-cli-cont-'));
    try {
      const nextRecoveryDir = path.join(nextTemp, 'eligibility-topology-recovery');
      const nextPrepDir = path.join(nextTemp, 'eligibility-topology-prepared');
      const priorCopy = path.join(nextTemp, 'prior.json');
      await mkdir(nextRecoveryDir, { recursive: true, mode: 0o700 });
      await mkdir(nextPrepDir, { recursive: true, mode: 0o700 });
      await writeFile(priorCopy, `${JSON.stringify(written)}\n`, { mode: 0o600 });
      await writeFile(
        path.join(nextRecoveryDir, 'recovery.json'),
        `${JSON.stringify({ ...validRecovery, runId: '789', resultArtifactId: '9999' })}\n`,
        { mode: 0o600 }
      );
      await writeFile(
        path.join(nextPrepDir, 'prepared.json'),
        await readFile(path.join(prepared.runnerTemp, 'eligibility-topology-prepared', 'prepared.json'), 'utf8'),
        { mode: 0o600 }
      );
      await writeFile(
        path.join(nextPrepDir, 'staging-topology-worker.mjs'),
        await readFile(path.join(prepared.runnerTemp, 'eligibility-topology-prepared', 'staging-topology-worker.mjs'))
      );
      const fixture = deletableWorkerFixture(prepared.manifest);
      const exitCode = await topologyRunner.cleanup(
        {
          ...prepared.env,
          RUNNER_TEMP: nextTemp,
          TOPOLOGY_RECOVERY_FILE: path.join(nextRecoveryDir, 'recovery.json'),
          TOPOLOGY_PRIOR_RESULT_FILE: priorCopy,
          CLEANUP_RUN_ID: '789',
          CLEANUP_ATTEMPT: '1'
        },
        true,
        fixture.options
      );
      const nextResult = JSON.parse(
        await readFile(path.join(nextTemp, 'eligibility-topology-result', 'result.json'), 'utf8')
      );
      assert.equal(exitCode, 0);
      assert.equal(fixture.isDeleted(), true);
      assert.deepEqual(nextResult.identity, prepared.identity);
      assert.equal(nextResult.cleanup, 'removed');
    } finally {
      await rm(nextTemp, { recursive: true, force: true });
    }

    // run-state.json on disk is preserved in fallback deploymentAttempted / cleanupCalls / cleanupStartedAt.
    await rm(resultFile, { force: true });
    const runStatePath = path.join(prepared.runnerTemp, 'eligibility-topology-prepared', 'run-state.json');
    await writeFile(
      runStatePath,
      `${JSON.stringify({
        schema: 1,
        identity: prepared.identity,
        accountSha256: prepared.accountSha256,
        startedAt: prepared.startedAt,
        preflightCalls: 9,
        cleanupCalls: 7,
        cleanupStartedAt: prepared.startedAt + 1_000,
        cleanupDeadlineAt: prepared.startedAt + 121_000,
        deploymentAttempted: true,
        deploymentExitCode: 0,
        phase: 'cleanup'
      })}\n`,
      { mode: 0o600 }
    );
    const runWithState = spawnSync(process.execPath, [scriptPath, 'cleanup-recovered'], {
      env: {
        ...prepared.env,
        TOPOLOGY_RECOVERY_FILE: recoveryFile,
        TOPOLOGY_PRIOR_RESULT_FILE: '',
        CLEANUP_RUN_ID: context.runId,
        CLEANUP_ATTEMPT: context.runAttempt,
        CLOUDFLARE_API_TOKEN: 'bad'
      },
      encoding: 'utf8'
    });
    assert.equal(runWithState.status, 1);
    const writtenWithState = JSON.parse(await readFile(resultFile, 'utf8'));
    assert.deepEqual(writtenWithState.identity, prepared.identity);
    assert.equal(writtenWithState.deploymentAttempted, true);
    assert.equal(writtenWithState.providerReads.preflight, 250);
    assert.equal(writtenWithState.providerReads.cleanup, 7);
    assert.equal(writtenWithState.providerReads.cleanupStartedAt, prepared.startedAt + 1_000);
    assert.equal(writtenWithState.providerReads.cleanupDeadlineAt, prepared.startedAt + 121_000);
    await rm(runStatePath, { force: true });

    // Missing CLOUDFLARE_ACCOUNT_ID still preserves validated identity & preflight: 250.
    await rm(resultFile, { force: true });
    const envNoAcct = {
      ...prepared.env,
      TOPOLOGY_RECOVERY_FILE: recoveryFile,
      TOPOLOGY_PRIOR_RESULT_FILE: '',
      CLEANUP_RUN_ID: context.runId,
      CLEANUP_ATTEMPT: context.runAttempt
    };
    delete envNoAcct.CLOUDFLARE_ACCOUNT_ID;
    const runNoAcct = spawnSync(process.execPath, [scriptPath, 'cleanup-recovered'], {
      env: envNoAcct,
      encoding: 'utf8'
    });
    assert.equal(runNoAcct.status, 1);
    const writtenNoAcct = JSON.parse(await readFile(resultFile, 'utf8'));
    assert.deepEqual(writtenNoAcct.identity, prepared.identity);
    assert.equal(writtenNoAcct.providerReads.preflight, 250);

    // Mismatched valid CLOUDFLARE_ACCOUNT_ID, tampered recovery.json, and non-empty invalid prior file fail closed to identity: null.
    const negativeCases = [
      { ...prepared.env, TOPOLOGY_RECOVERY_FILE: recoveryFile, TOPOLOGY_PRIOR_RESULT_FILE: '', CLEANUP_RUN_ID: context.runId, CLEANUP_ATTEMPT: context.runAttempt, CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), CLOUDFLARE_API_TOKEN: 'bad' },
      { ...prepared.env, TOPOLOGY_RECOVERY_FILE: recoveryFile, TOPOLOGY_PRIOR_RESULT_FILE: '', CLEANUP_RUN_ID: '999', CLEANUP_ATTEMPT: context.runAttempt, CLOUDFLARE_API_TOKEN: 'bad' },
      { ...prepared.env, TOPOLOGY_RECOVERY_FILE: recoveryFile, TOPOLOGY_PRIOR_RESULT_FILE: path.join(prepared.runnerTemp, 'missing-prior.json'), CLEANUP_RUN_ID: context.runId, CLEANUP_ATTEMPT: context.runAttempt, CLOUDFLARE_API_TOKEN: 'bad' }
    ];
    for (const negEnv of negativeCases) {
      await rm(resultFile, { force: true });
      const negRun = spawnSync(process.execPath, [scriptPath, 'cleanup-recovered'], {
        env: negEnv,
        encoding: 'utf8'
      });
      assert.equal(negRun.status, 1);
      const negWritten = JSON.parse(await readFile(resultFile, 'utf8'));
      assert.equal(negWritten.identity, null);
    }
  } finally {
    await rm(prepared.runnerTemp, { recursive: true, force: true });
  }
});
