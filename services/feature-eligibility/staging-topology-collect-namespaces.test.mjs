import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-namespaces.mjs';

const collect = topology.collectTopologyNamespaces ?? (() => null);
const expected = { script: 'miden-elig-topology-123-1', classes: ['TopologyControl', 'EligibilityGuard', 'CallerEligibilityGuard', 'RestartProof'] };
const rows = () => expected.classes.map((name, index) => ({ id: String(index + 1).padStart(32, '0'), class: name, name, script: expected.script, use_sqlite: true }));
const page = result => ({ success: true, errors: [], result, result_info: { page: 1, per_page: 1000, count: result.length, total_pages: 1, total_count: result.length } });

test('namespace collection repeats fixed-path inventory and returns matching identities', async () => {
  const calls = [];
  const result = await collect(async path => { calls.push(path); return page(rows()); }, expected);
  assert.deepEqual(result, rows().map(x => x.id));
  assert.deepEqual(calls, ['/workers/durable_objects/namespaces?page=1&per_page=1000', '/workers/durable_objects/namespaces?page=1&per_page=1000']);
});

test('namespace collection rejects identity changes between scans', async () => {
  let calls = 0;
  assert.equal(await collect(async () => { const value = rows(); if (++calls === 2) value[0].id = '00000000000000000000000000000009'; return page(value); }, expected), null);
});

test('namespace collection rejects provider errors', async () => {
  assert.equal(await collect(async () => ({ success: false, errors: [] }), expected), null);
});
