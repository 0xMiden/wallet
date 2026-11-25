import assert from 'node:assert/strict';
import test from 'node:test';
import { createTopologyReadApi } from './staging-topology-api.mjs';
import { createTopologyApiBudget, prepareTopologyInventory } from './staging-topology-preflight.mjs';

const accountId = 'a'.repeat(32);
const token = 'synthetic-token-for-test-only';
const identity = {
  repository: '0xMiden/wallet',
  workflowPath: '.github/workflows/feature-eligibility-topology.yml',
  sourceSha: 'a'.repeat(40),
  runId: '12345',
  runAttempt: '1'
};
const now = Date.UTC(2026, 9, 29);
const page = (result, perPage) => ({
  success: true,
  errors: [],
  result,
  result_info: { page: 1, per_page: perPage, count: result.length, total_pages: 1, total_count: result.length }
});

function fixture({ collision = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    const parsed = new URL(url);
    const base = `/client/v4/accounts/${accountId}`;
    if (parsed.pathname === base) return Response.json({ success: true, errors: [], result: { id: accountId } });
    if (parsed.pathname === `${base}/workers/subdomain`)
      return Response.json({ success: true, errors: [], result: { subdomain: 'wallet-topology' } });
    if (parsed.pathname === `${base}/workers/scripts` && parsed.search === '?page=1&per_page=100')
      return Response.json(page([{ id: 'other-worker' }], 100));
    if (parsed.pathname === `${base}/workers/durable_objects/namespaces` && parsed.search === '?page=1&per_page=1000')
      return Response.json(page([], 1000));
    if (parsed.pathname === `${base}/workers/scripts/other-worker/settings`)
      return Response.json({ success: true, errors: [], result: { bindings: [] } });
    if (parsed.pathname === `${base}/workers/scripts/miden-elig-topology-12345-1/settings`)
      return collision
        ? Response.json({ success: true, errors: [] })
        : Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    throw new Error('Unexpected request');
  };
  const api = createTopologyReadApi({ accountId, token, fetchImpl });
  const options = {
    api,
    accountId,
    identity,
    bundle: new Uint8Array([1, 2, 3]),
    now,
    expiresAt: now + 600_000,
    maxRuns: 10
  };
  return { calls, options };
}

test('read-only topology preflight composes bounded provider reads without deploying', async () => {
  const { calls, options } = fixture();
  const result = await prepareTopologyInventory(options);
  assert.equal(result?.status, 'inventory_observed');
  assert.equal(result?.deploymentAuthorized, false);
  assert.equal(result?.workersDevUrl, 'https://miden-elig-topology-12345-1.wallet-topology.workers.dev');
  assert.equal(calls.length, 11);
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('read-only topology preflight refuses a direct script collision', async () => {
  const { options } = fixture({ collision: true });
  assert.equal(await prepareTopologyInventory(options), null);
});

test('read-only topology observation composes bounded reads and excludes settings values', async () => {
  const classes = ['TopologyControl', 'EligibilityGuard', 'CallerEligibilityGuard', 'RestartProof'];
  const script = 'miden-elig-topology-12345-1';
  const rows = classes.map((name, index) => ({
    id: String(index + 1).padStart(32, '0'),
    class: name,
    script,
    use_sqlite: true
  }));
  const calls = [];
  const api = createTopologyReadApi({
    accountId,
    token,
    fetchImpl: async (url, init) => {
      calls.push(init.method);
      const parsed = new URL(url);
      const base = `/client/v4/accounts/${accountId}`;
      if (parsed.pathname === `${base}/workers/scripts`)
        return Response.json(page([{ id: script }, { id: 'other-worker' }], 100));
      if (parsed.pathname === `${base}/workers/durable_objects/namespaces`) return Response.json(page(rows, 1000));
      if (parsed.pathname === `${base}/workers/scripts/${script}/settings`)
        return Response.json({
          success: true,
          errors: [],
          result: {
            bindings: rows.map((row, index) => ({
              name: `GUARD_${index}`,
              type: 'durable_object_namespace',
              class_name: row.class,
              namespace_id: row.id
            }))
          }
        });
      if (parsed.pathname === `${base}/workers/scripts/other-worker/settings`)
        return Response.json({
          success: true,
          errors: [],
          result: { bindings: [{ name: 'SECRET_VALUE', type: 'plain_text', text: 'private-sentinel' }] }
        });
      throw new Error('Unexpected request');
    }
  });
  const { observeTopologyRelationships } = await import('./staging-topology-namespaces.mjs');
  const result = await observeTopologyRelationships(api, { script, classes });
  assert.deepEqual(result, { status: 'observed' });
  assert.ok(calls.length > 0 && calls.every(method => method === 'GET'));
  assert.equal(JSON.stringify(result).includes('private-sentinel'), false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('createTopologyReadApi preserves privacy-mismatch cleanup and tail-consumer diagnostics', async () => {
  const { buildTopologyManifest } = await import('./staging-topology-manifest.mjs');
  const { cleanupTopologyWorker, observeTopologyOwnership } = await import('./staging-topology-preflight.mjs');
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
  const bindings = rows.map((row, index) => ({
    name: manifest.config.durable_objects.bindings[index].name,
    type: 'durable_object_namespace',
    class_name: row.class,
    namespace_id: row.id
  }));
  for (const [name, text] of Object.entries(manifest.config.vars)) bindings.push({ name, type: 'plain_text', text });
  bindings.push({ name: 'TOPOLOGY_BEARER', type: 'secret_text' });
  for (const rate of manifest.config.ratelimits) bindings.push({ ...rate, type: 'ratelimit' });

  const runWithScriptSettings = async (scriptSettingsResult, { cleanupMode = false } = {}) => {
    let deleted = false;
    const base = `/client/v4/accounts/${accountId}`;
    const api = createTopologyReadApi({
      accountId,
      token,
      fetchImpl: async url => {
        const parsed = new URL(url);
        if (parsed.pathname === base) return Response.json({ success: true, errors: [], result: { id: accountId } });
        if (parsed.pathname === `${base}/workers/scripts` && parsed.search === '?page=1&per_page=100')
          return Response.json(page([{ id: manifest.scriptName }], 100));
        if (parsed.pathname === `${base}/workers/durable_objects/namespaces` && parsed.search === '?page=1&per_page=1000')
          return Response.json(page(rows, 1000));
        if (parsed.pathname === `${base}/workers/scripts/${manifest.scriptName}/settings`) {
          return deleted
            ? Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 })
            : Response.json({ success: true, errors: [], result: { bindings } });
        }
        if (parsed.pathname === `${base}/workers/scripts/${manifest.scriptName}/script-settings`)
          return Response.json({ success: true, errors: [], result: scriptSettingsResult });
        if (parsed.pathname === `${base}/workers/scripts/${manifest.scriptName}/content/v2`)
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'content-type': 'application/javascript+module', 'cf-entrypoint': 'staging-topology-worker.mjs' }
          });
        throw new Error(`Unexpected request: ${url}`);
      }
    });
    const mismatches = [];
    if (!cleanupMode) {
      const observed = await observeTopologyOwnership({
        api,
        accountId,
        manifest,
        options,
        onMismatch: item => mismatches.push(item)
      });
      return { observed, mismatches };
    }
    const deletes = [];
    const cleaned = await cleanupTopologyWorker({
      api,
      deleteScript: async name => {
        deletes.push(name);
        deleted = true;
        return true;
      },
      accountId,
      manifest,
      options,
      onMismatch: item => mismatches.push(item)
    });
    return { cleaned, deletes, mismatches };
  };

  for (const privacyResult of [
    { logpush: null, observability: null, tail_consumers: [] },
    { logpush: false, observability: {}, tail_consumers: [] },
    { logpush: false, observability: { enabled: false, logs: { persist: null } }, tail_consumers: [] }
  ]) {
    const cleaned = await runWithScriptSettings(privacyResult, { cleanupMode: true });
    assert.deepEqual(cleaned.cleaned, { cleanup: 'removed', reason: 'complete' });
    assert.deepEqual(cleaned.deletes, [manifest.scriptName]);
  }

  const obsLogpushNull = await runWithScriptSettings({ logpush: null, observability: null, tail_consumers: [] });
  assert.equal(obsLogpushNull.observed, null);
  assert.deepEqual(obsLogpushNull.mismatches, [{ gate: 'script_logpush', form: 'null' }]);

  const obsEmptyObs = await runWithScriptSettings({ logpush: false, observability: {}, tail_consumers: [] });
  assert.equal(obsEmptyObs.observed, null);
  assert.deepEqual(obsEmptyObs.mismatches, [{ gate: 'script_observability', form: 'missing' }]);

  const blockedTails = await runWithScriptSettings(
    { logpush: false, observability: null, tail_consumers: [{ service: 'other-worker' }] },
    { cleanupMode: true }
  );
  assert.deepEqual(blockedTails.cleaned, {
    cleanup: 'blocked',
    reason: 'ownership_mismatch',
    ownershipDiagnostic: { gate: 'script_tail_consumers', form: 'different_value' }
  });
  assert.deepEqual(blockedTails.deletes, []);

  const blockedNullTails = await runWithScriptSettings(
    { logpush: false, observability: null, tail_consumers: null },
    { cleanupMode: true }
  );
  assert.deepEqual(blockedNullTails.cleaned, {
    cleanup: 'blocked',
    reason: 'ownership_mismatch',
    ownershipDiagnostic: { gate: 'script_tail_consumers', form: 'unexpected_type' }
  });
  assert.deepEqual(blockedNullTails.deletes, []);
});

test('createTopologyApiBudget enforces single-layer read caps over createTopologyReadApi', async () => {
  let fetchCalls = 0;
  const api = createTopologyReadApi({
    accountId,
    token,
    fetchImpl: async () => {
      fetchCalls++;
      return Response.json({ success: true, errors: [], result: { id: accountId } });
    }
  });
  const budget = createTopologyApiBudget(api);
  for (let index = 0; index < 250; index++) {
    assert.deepEqual(await budget.preflight('/account'), { success: true, errors: [], result: { id: accountId } });
  }
  await assert.rejects(budget.preflight('/account'), /provider read budget exhausted/);
  assert.equal(fetchCalls, 250);
});
