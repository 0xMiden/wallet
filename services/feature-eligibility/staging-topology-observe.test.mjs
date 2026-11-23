import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-namespaces.mjs';

const observe = topology.observeTopologyRelationships ?? (() => null);
const expected = { script: 'miden-elig-topology-123-1', classes: ['TopologyControl', 'EligibilityGuard', 'CallerEligibilityGuard', 'RestartProof'] };
const rows = () => expected.classes.map((name, index) => ({ id: String(index + 1).padStart(32, '0'), class: name, script: expected.script, use_sqlite: true }));
const page = (result, perPage) => ({ success: true, errors: [], result, result_info: { page: 1, per_page: perPage, count: result.length, total_pages: 1, total_count: result.length } });
function provider({ external = false, missing = false, wrongClass = false } = {}) {
  return async path => {
    if (path === '/workers/scripts?page=1&per_page=100') return page([{ id: expected.script }, { id: 'other-worker' }], 100);
    if (path === '/workers/durable_objects/namespaces?page=1&per_page=1000') return page(rows(), 1000);
    if (path === `/workers/scripts/${expected.script}/settings`) return { success: true, errors: [], result: { bindings: rows().map((row, index) => ({ name: `GUARD_${index}`, type: 'durable_object_namespace', class_name: wrongClass && index === 0 ? 'EligibilityGuard' : row.class, namespace_id: row.id })) } };
    if (path === '/workers/scripts/other-worker/settings') return missing ? { success: false, errors: [] } : { success: true, errors: [], result: { bindings: external ? [{ name: 'SERVICE', type: 'service', service: expected.script }] : [] } };
    throw new Error('Unexpected path');
  };
}

test('topology observation accepts stable isolated relationship evidence', async () => {
  assert.deepEqual(await observe(provider(), expected), { status: 'observed' });
});

test('topology observation rejects external references and missing settings', async () => {
  assert.equal(await observe(provider({ external: true }), expected), null);
  assert.equal(await observe(provider({ missing: true }), expected), null);
  assert.equal(await observe(provider({ wrongClass: true }), expected), null);
});
