import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-preflight.mjs';
import { buildTopologyManifest } from './staging-topology-manifest.mjs';

const observe = topology.observeTopologyOwnership ?? (async () => null);
const cleanup = topology.cleanupTopologyWorker ?? (async () => ({ cleanup: 'blocked' }));
const accountId = 'a'.repeat(32);
const identity = {
  repository: '0xMiden/wallet',
  workflowPath: '.github/workflows/feature-eligibility-topology.yml',
  sourceSha: 'a'.repeat(40),
  runId: '12345',
  runAttempt: '1'
};
const now = Date.UTC(2026, 9, 29);
const options = {
  identity,
  bundle: new Uint8Array([1, 2, 3]),
  now,
  expiresAt: now + 600_000,
  maxRuns: 10,
  inventory: []
};
const manifest = buildTopologyManifest(options);
const classes = ['TopologyControl', 'EligibilityGuard', 'CallerEligibilityGuard', 'RestartProof'];
const rows = classes.map((name, index) => ({
  id: String(index + 1).padStart(32, '0'),
  class: name,
  script: manifest.scriptName,
  use_sqlite: true
}));
const page = (result, perPage) => ({
  success: true,
  errors: [],
  result,
  result_info: { page: 1, per_page: perPage, count: result.length, total_pages: 1, total_count: result.length }
});
function apiFixture({ changedDigest = false, logging = false, missingMarker = false } = {}) {
  const bindings = rows.map((row, index) => ({
    name: manifest.config.durable_objects.bindings[index].name,
    type: 'durable_object_namespace',
    class_name: row.class,
    namespace_id: row.id
  }));
  for (const [name, text] of Object.entries(manifest.config.vars))
    if (!(missingMarker && name === 'TOPOLOGY_OWNER')) bindings.push({ name, type: 'plain_text', text });
  bindings.push({ name: 'TOPOLOGY_BEARER', type: 'secret_text' });
  for (const rate of manifest.config.ratelimits) bindings.push({ ...rate, type: 'ratelimit' });
  return async path => {
    if (path === '/account') return { success: true, errors: [], result: { id: accountId } };
    if (path === '/workers/scripts?page=1&per_page=100') return page([{ id: manifest.scriptName }], 100);
    if (path === '/workers/durable_objects/namespaces?page=1&per_page=1000') return page(rows, 1000);
    if (path === `/workers/scripts/${manifest.scriptName}/settings`)
      return { success: true, errors: [], result: { bindings } };
    if (path === `/workers/scripts/${manifest.scriptName}/script-settings`)
      return {
        success: true,
        errors: [],
        result: {
          logpush: false,
          observability: {
            enabled: logging,
            logs: { enabled: false, invocation_logs: false, persist: false },
            traces: { enabled: false, persist: false },
            issues: { enabled: false }
          },
          tail_consumers: []
        }
      };
    if (path === `/workers/scripts/${manifest.scriptName}/content/v2`)
      return { sha256: changedDigest ? 'b'.repeat(64) : manifest.bundleSha256 };
    return null;
  };
}

test('live topology evidence is bound to account, markers, content and safe logging without authorizing cleanup', async () => {
  const input = { accountId, manifest, options };
  assert.deepEqual(await observe({ ...input, api: apiFixture() }), {
    status: 'observed',
    deploymentAuthorized: false,
    cleanupAuthorized: false
  });
  assert.equal(await observe({ ...input, api: apiFixture({ changedDigest: true }) }), null);
  assert.equal(await observe({ ...input, api: apiFixture({ logging: true }) }), null);
  assert.equal(await observe({ ...input, api: apiFixture({ missingMarker: true }) }), null);
  const good = apiFixture();
  assert.equal(
    await observe({
      ...input,
      api: async path =>
        path.endsWith('/script-settings')
          ? { success: true, errors: [], result: { logpush: false, observability: null, tail_consumers: [] } }
          : good(path)
    }),
    null
  );
  let contentReads = 0;
  assert.equal(
    await observe({
      ...input,
      api: async path => (path.endsWith('/content/v2') && ++contentReads > 1 ? { sha256: 'b'.repeat(64) } : good(path))
    }),
    null
  );
});

test('unknown script observability reports a closed field diagnostic and still refuses ownership', async () => {
  const input = { accountId, manifest, options };
  let diagnostic;
  const calls = [];
  const good = apiFixture();
  const result = await observe({
    ...input,
    api: async path => {
      calls.push(path);
      return path.endsWith('/script-settings')
        ? { success: true, errors: [], result: { logpush: false, observability: null, tail_consumers: [] } }
        : good(path);
    },
    onMismatch: value => {
      diagnostic = value;
    }
  });
  assert.equal(result, null);
  assert.deepEqual(diagnostic, { gate: 'script_observability', form: 'null' });
  assert.equal(JSON.stringify(diagnostic).includes(accountId), false);
  assert.equal(JSON.stringify(diagnostic).includes('private-sentinel'), false);
  assert.equal(calls.some(path => path.endsWith('/content/v2')), false);
});

test('script privacy diagnostics distinguish absent and changed values without returning provider data', () => {
  const diagnose = topology.topologyScriptSettingsMismatch;
  const settings = result => ({ success: true, errors: [], result });
  assert.deepEqual(diagnose(settings({})), { gate: 'script_tail_consumers', form: 'missing' });
  assert.deepEqual(diagnose(settings({ logpush: false, tail_consumers: [] })), {
    gate: 'script_observability',
    form: 'missing'
  });
  assert.deepEqual(diagnose(settings({ logpush: false, tail_consumers: [], observability: null })), {
    gate: 'script_observability',
    form: 'null'
  });
  assert.deepEqual(
    diagnose(settings({
      logpush: false,
      tail_consumers: [],
      observability: { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false }, issues: { enabled: false } }
    })),
    { gate: 'script_observability_logs', form: 'missing' }
  );
  assert.deepEqual(
    diagnose(
      settings({
        logpush: false,
        tail_consumers: [],
        observability: {
          enabled: false,
          logs: { enabled: false, invocation_logs: false, persist: false },
          traces: { enabled: false, persist: false },
          issues: { enabled: true }
        }
      })
    ),
    { gate: 'script_observability_issues', form: 'different_value' }
  );
  assert.deepEqual(diagnose(null), { gate: 'script_settings_response', form: 'unavailable' });
});

test('observation fixture binds the named script and distinct namespaces', () => {
  assert.equal(manifest.scriptName, 'miden-elig-topology-12345-1');
  assert.equal(new Set(rows.map(row => row.id)).size, 4);
});

test('provider reads stop before the next request at phase and aggregate limits', async () => {
  assert.equal(typeof topology.createTopologyApiBudget, 'function');
  if (typeof topology.createTopologyApiBudget !== 'function') return;
  const calls = [];
  const budget = topology.createTopologyApiBudget(async path => {
    calls.push(path);
    return {};
  });
  for (let index = 0; index < 250; index++) await budget.preflight('/account');
  await assert.rejects(budget.preflight('/account'), /budget/);
  assert.equal(calls.length, 250);
  for (let index = 0; index < 250; index++) await budget.cleanup('/account');
  await assert.rejects(budget.cleanup('/account'), /budget/);
  assert.equal(calls.length, 500);
});

test('provider read deadline stops before issuing another request', async () => {
  assert.equal(typeof topology.createTopologyApiBudget, 'function');
  if (typeof topology.createTopologyApiBudget !== 'function') return;
  let elapsed = 0;
  const calls = [];
  const budget = topology.createTopologyApiBudget(
    async path => {
      calls.push(path);
      elapsed += 5_000;
      return {};
    },
    { now: () => elapsed }
  );
  for (let index = 0; index < 24; index++) await budget.preflight('/account');
  await assert.rejects(budget.preflight('/account'), /deadline/);
  assert.equal(calls.length, 24);
});

test('a privacy-unknown worker is not exercised but can be cleaned after positive ownership checks', async () => {
  const input = { accountId, manifest, options };
  const good = apiFixture();
  const api = async path =>
    path.endsWith('/script-settings')
      ? { success: true, errors: [], result: { logpush: false, observability: null, tail_consumers: [] } }
      : good(path);
  assert.equal(await observe({ ...input, api }), null);

  const deleted = [];
  let absent = false;
  const targetSettings = `/workers/scripts/${manifest.scriptName}/settings`;
  const cleanupApi = async path => {
    if (absent && path === targetSettings)
      return { status: 404, body: { success: false, errors: [{ code: 10007 }] } };
    if (path.endsWith('/script-settings'))
      return { success: true, errors: [], result: { logpush: false, observability: null, tail_consumers: [] } };
    return good(path);
  };
  const result = await cleanup({
    ...input,
    api: cleanupApi,
    deleteScript: async name => {
      deleted.push(name);
      absent = true;
      return true;
    }
  });
  assert.deepEqual(deleted, [manifest.scriptName]);
  assert.equal(result.cleanup, 'removed');
});

test('cleanup refuses deletion when exact bundle ownership or dependent tail-consumer state is unknown', async () => {
  const input = { accountId, manifest, options };
  const deleted = [];
  const remove = async api =>
    cleanup({
      ...input,
      api,
      deleteScript: async name => {
        deleted.push(name);
        return true;
      }
    });
  assert.equal((await remove(apiFixture({ changedDigest: true }))).cleanup, 'blocked');
  const good = apiFixture();
  assert.equal(
    (await remove(async path =>
      path.endsWith('/script-settings')
        ? { success: true, errors: [], result: { logpush: false, observability: null, tail_consumers: null } }
        : good(path)
    )).cleanup,
    'blocked'
  );
  assert.deepEqual(deleted, []);
});

test('cleanup treats an unavailable target read as unknown rather than absent', async () => {
  let deletes = 0;
  const result = await cleanup({
    accountId,
    manifest,
    options,
    api: async () => null,
    deleteScript: async () => {
      deletes++;
      return true;
    }
  });
  assert.equal(result.cleanup, 'blocked');
  assert.equal(deletes, 0);
});

test('each provider read receives a five-second abort signal', async () => {
  assert.equal(typeof topology.createTopologyApiBudget, 'function');
  if (typeof topology.createTopologyApiBudget !== 'function') return;
  let timeoutMs;
  const budget = topology.createTopologyApiBudget(
    async (_path, { signal }) => {
      assert.equal(signal.aborted, false);
      return {};
    },
    {
      setTimeoutFn: (_callback, ms) => {
        timeoutMs = ms;
        return 1;
      },
      clearTimeoutFn: () => {}
    }
  );
  await budget.preflight('/account');
  assert.equal(timeoutMs, 5_000);
});

test('provider read timeout aborts its in-flight API request', async () => {
  let timeout;
  let signal;
  const budget = topology.createTopologyApiBudget(
    async (_path, options) => {
      signal = options.signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    },
    { setTimeoutFn: callback => ((timeout = callback), 1), clearTimeoutFn: () => {} }
  );
  const request = budget.preflight('/account');
  await Promise.resolve();
  timeout();
  await assert.rejects(request, /deadline/);
  assert.equal(signal.aborted, true);
});
