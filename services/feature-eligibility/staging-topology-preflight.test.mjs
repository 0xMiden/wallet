import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-preflight.mjs';

const prepare = topology.prepareTopologyInventory ?? (() => null);
const observeWorkerUrl = topology.observeTopologyWorkerUrl ?? (async () => null);
const identity = {
  repository: '0xMiden/wallet',
  workflowPath: '.github/workflows/feature-eligibility-topology.yml',
  sourceSha: 'a'.repeat(40),
  runId: '12345',
  runAttempt: '1'
};
const accountId = 'a'.repeat(32);
const now = Date.UTC(2026, 9, 29);
const page = ids => ({
  success: true,
  errors: [],
  result: ids.map(id => ({ id })),
  result_info: { page: 1, per_page: 100, count: ids.length, total_pages: 1, total_count: ids.length }
});
const options = api => ({
  api,
  accountId,
  identity,
  bundle: new Uint8Array([1, 2, 3]),
  now,
  expiresAt: now + 600_000,
  maxRuns: 10
});
function provider({
  account = accountId,
  scripts = ['other-worker'],
  namespaces = [],
  target = { status: 404, body: { success: false, errors: [{ code: 10007 }] } }
} = {}) {
  return async path => {
    if (path === '/account') return { success: true, errors: [], result: { id: account } };
    if (path === '/workers/subdomain') return { success: true, errors: [], result: { subdomain: 'wallet-topology' } };
    if (path === '/workers/scripts?page=1&per_page=100') return page(scripts);
    if (path === '/workers/scripts/other-worker/settings')
      return { success: true, errors: [], result: { bindings: [] } };
    if (path === '/workers/scripts/miden-elig-topology-12345-1/settings') return target;
    if (path === '/workers/durable_objects/namespaces?page=1&per_page=1000')
      return {
        success: true,
        errors: [],
        result: namespaces,
        result_info: {
          page: 1,
          per_page: 1000,
          count: namespaces.length,
          total_pages: 1,
          total_count: namespaces.length
        }
      };
    throw new Error('Unexpected path');
  };
}

test('account-bound inventory preparation produces only a local manifest', async () => {
  const result = await prepare(options(provider()));
  assert.equal(result?.status, 'inventory_observed');
  assert.equal(result?.manifest?.scriptName, 'miden-elig-topology-12345-1');
  assert.equal(result?.workersDevUrl, 'https://miden-elig-topology-12345-1.wallet-topology.workers.dev');
  assert.equal(result?.deploymentAuthorized, false);
});

test('workers.dev target is accepted only when its account host and route state are stable', async () => {
  const script = 'miden-elig-topology-12345-1';
  let accountReads = 0;
  const api = async path => {
    if (path === '/workers/subdomain') {
      accountReads++;
      return { success: true, errors: [], result: { subdomain: 'wallet-topology' } };
    }
    if (path === `/workers/scripts/${script}/subdomain`)
      return { success: true, errors: [], result: { enabled: true, previews_enabled: false } };
    return null;
  };
  assert.deepEqual(await observeWorkerUrl({ api, scriptName: script }), {
    status: 'observed',
    url: `https://${script}.wallet-topology.workers.dev`
  });
  assert.equal(accountReads, 2);
  assert.equal(
    await observeWorkerUrl({
      api: async path =>
        path === '/workers/subdomain'
          ? { success: true, errors: [], result: { subdomain: 'wallet-topology' } }
          : { success: true, errors: [], result: { enabled: true, previews_enabled: true } },
      scriptName: script
    }),
    null
  );
  let changingReads = 0;
  assert.equal(
    await observeWorkerUrl({
      api: async path =>
        path === '/workers/subdomain'
          ? { success: true, errors: [], result: { subdomain: changingReads++ ? 'other-host' : 'wallet-topology' } }
          : { success: true, errors: [], result: { enabled: true, previews_enabled: false } },
      scriptName: script
    }),
    null
  );
});

test('account-bound preparation rejects a mismatched or malformed account', async () => {
  assert.equal(await prepare(options(provider({ account: 'b'.repeat(32) }))), null);
  assert.equal(await prepare({ ...options(provider()), accountId: '../bad' }), null);
});

test('account-bound preparation rejects a pre-existing script', async () => {
  assert.equal(await prepare(options(provider({ scripts: ['miden-elig-topology-12345-1'] }))), null);
});

test('account-bound preparation rejects a pre-existing topology namespace', async () => {
  const namespace = {
    id: '1'.repeat(32),
    class: 'EligibilityGuard',
    script: 'miden-elig-topology-12345-1',
    use_sqlite: true
  };
  assert.equal(await prepare(options(provider({ namespaces: [namespace] }))), null);
});

test('account-bound preparation rejects changing or incomplete namespace inventory', async () => {
  let calls = 0;
  const base = provider();
  const changed = async path => {
    if (path !== '/workers/durable_objects/namespaces?page=1&per_page=1000') return base(path);
    const entries =
      ++calls === 1 ? [] : [{ id: '2'.repeat(32), class: 'Other', script: 'other-worker', use_sqlite: true }];
    return {
      success: true,
      errors: [],
      result: entries,
      result_info: { page: 1, per_page: 1000, count: entries.length, total_pages: 1, total_count: entries.length }
    };
  };
  assert.equal(await prepare(options(changed)), null);
  const incomplete = async path =>
    path === '/workers/durable_objects/namespaces?page=1&per_page=1000'
      ? { success: true, errors: [], result: [] }
      : base(path);
  assert.equal(await prepare(options(incomplete)), null);
});

test('account-bound preparation requires an explicit provider absence receipt', async () => {
  assert.equal(await prepare(options(provider({ target: { status: 200, body: { success: true } } }))), null);
  assert.equal(
    await prepare(options(provider({ target: { status: 404, body: { success: false, errors: [] } } }))),
    null
  );
  assert.equal(
    await prepare(
      options(provider({ target: { status: 404, body: { success: false, errors: [{ code: 10007, extra: 1 }] } } }))
    ),
    null
  );
});

test('account-bound preparation refuses an existing script with a colliding rate namespace', async () => {
  const { buildTopologyManifest } = await import('./staging-topology-manifest.mjs');
  const input = options(null);
  const manifest = buildTopologyManifest({
    identity,
    bundle: input.bundle,
    now,
    expiresAt: input.expiresAt,
    maxRuns: input.maxRuns,
    inventory: []
  });
  assert.ok(manifest);
  const base = provider();
  const api = async path =>
    path === '/workers/scripts/other-worker/settings'
      ? {
          success: true,
          errors: [],
          result: {
            bindings: [
              {
                name: 'OTHER_RATE',
                type: 'ratelimit',
                namespace_id: manifest.config.ratelimits[0].namespace_id,
                simple: { limit: 4, period: 60 }
              }
            ]
          }
        }
      : base(path);
  assert.equal(await prepare(options(api)), null);
});

test('formatTopologyProviderReads returns the frozen budget stats shape', () => {
  const preflightStartedAt = 1_000;
  const cleanupStartedAt = 5_000;
  const nowValue = 12_000;
  const formatted = topology.formatTopologyProviderReads({
    preflight: 7,
    cleanup: 3,
    preflightStartedAt,
    cleanupStartedAt,
    now: nowValue
  });
  assert.equal(Object.isFrozen(formatted), true);
  assert.deepEqual(formatted, {
    preflight: 7,
    cleanup: 3,
    total: 10,
    elapsedMs: 11_000,
    preflightStartedAt: 1_000,
    preflightDeadlineAt: 121_000,
    cleanupStartedAt: 5_000,
    cleanupDeadlineAt: 125_000,
    preflightElapsedMs: 11_000,
    cleanupElapsedMs: 7_000
  });

  const budget = topology.createTopologyApiBudget(async () => ({}), {
    now: () => nowValue,
    startedAt: preflightStartedAt,
    cleanupStartedAt,
    initialCalls: { preflight: 7, cleanup: 3 }
  });
  assert.deepEqual(formatted, budget.stats());

  const noCleanup = topology.formatTopologyProviderReads({
    preflight: 2,
    cleanup: 0,
    preflightStartedAt,
    now: nowValue
  });
  assert.equal(noCleanup.cleanupStartedAt, null);
  assert.equal(noCleanup.cleanupDeadlineAt, null);
  assert.equal(noCleanup.cleanupElapsedMs, null);
});

test('formatTopologyProviderReads and createTopologyApiBudget never report negative elapsed time under backward clock skew', async () => {
  assert.deepEqual(
    topology.formatTopologyProviderReads({
      preflight: 2,
      cleanup: 1,
      preflightStartedAt: 1_000,
      cleanupStartedAt: 1_000,
      now: 500
    }),
    {
      preflight: 2,
      cleanup: 1,
      total: 3,
      elapsedMs: 0,
      preflightStartedAt: 1_000,
      preflightDeadlineAt: 121_000,
      cleanupStartedAt: 1_000,
      cleanupDeadlineAt: 121_000,
      preflightElapsedMs: 0,
      cleanupElapsedMs: 0
    }
  );

  const skewedBudget = topology.createTopologyApiBudget(async () => ({ ok: true }), {
    startedAt: 1_000,
    now: () => 500
  });
  await skewedBudget.cleanup('/account');
  const skewedStats = skewedBudget.stats();
  assert.equal(skewedStats.cleanupStartedAt, 1_000);
  assert.equal(skewedStats.elapsedMs, 0);
  assert.equal(skewedStats.preflightElapsedMs, 0);
  assert.equal(skewedStats.cleanupElapsedMs, 0);

  let tick = 1_500;
  const monotonicBudget = topology.createTopologyApiBudget(async () => ({ ok: true }), {
    startedAt: 1_000,
    now: () => tick
  });
  await monotonicBudget.preflight('/account');
  tick = 900;
  assert.equal(monotonicBudget.stats().elapsedMs, 500);
  await monotonicBudget.cleanup('/account');
  const monotonicStats = monotonicBudget.stats();
  assert.equal(monotonicStats.cleanupStartedAt, 1_500);
  assert.equal(monotonicStats.elapsedMs, 500);
  assert.equal(monotonicStats.cleanupElapsedMs, 0);
  tick = 121_500;
  await assert.rejects(monotonicBudget.cleanup('/account'), /provider read deadline exhausted/);

  const ticks = [120_900, 121_001, 100_000];
  let idx = 0;
  const rollbackBudget = topology.createTopologyApiBudget(async () => ({ ok: true }), {
    startedAt: 1_000,
    now: () => ticks[Math.min(idx++, ticks.length - 1)],
    onRequest: async () => {}
  });
  await assert.rejects(rollbackBudget.preflight('/account'), /provider read deadline exhausted/);
  assert.equal(rollbackBudget.stats().preflight, 0);

  let anchoredTick = 2_000;
  const anchoredBudget = topology.createTopologyApiBudget(async () => ({ ok: true }), {
    startedAt: 1_000,
    cleanupStartedAt: 5_000,
    now: () => anchoredTick
  });
  await anchoredBudget.cleanup('/account');
  assert.equal(anchoredBudget.stats().cleanupElapsedMs, 0);
  assert.equal(anchoredBudget.stats().elapsedMs, 4_000);
  anchoredTick = 125_000;
  await assert.rejects(anchoredBudget.cleanup('/account'), /provider read deadline exhausted/);
});
