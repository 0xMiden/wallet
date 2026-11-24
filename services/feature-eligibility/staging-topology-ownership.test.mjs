import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-preflight.mjs';
import { buildTopologyManifest } from './staging-topology-manifest.mjs';

const observe = topology.observeTopologyOwnership ?? (async () => null);
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

test('observation fixture binds the named script and distinct namespaces', () => {
  assert.equal(manifest.scriptName, 'miden-elig-topology-12345-1');
  assert.equal(new Set(rows.map(row => row.id)).size, 4);
});
