import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-namespaces.mjs';

const collect = topology.collectTopologySettings ?? (() => null);
const result = service => ({ success: true, errors: [], result: { bindings: [
  { name: 'ORIGIN', type: 'plain_text', text: 'private-sentinel' },
  { name: 'SERVICE', type: 'service', service }
] } });

test('settings collection repeats fixed paths and returns only closed binding metadata', async () => {
  const calls = [];
  const settings = await collect(async path => { calls.push(path); return result('other-worker'); }, ['worker-one']);
  assert.deepEqual(calls, ['/workers/scripts/worker-one/settings', '/workers/scripts/worker-one/settings']);
  assert.deepEqual(settings, [{ id: 'worker-one', bindings: [{ name: 'ORIGIN', type: 'plain_text' }, { name: 'SERVICE', type: 'service', service: 'other-worker' }] }]);
  assert.equal(JSON.stringify(settings).includes('private-sentinel'), false);
});

test('settings collection rejects a changed binding between scans', async () => {
  let calls = 0;
  assert.equal(await collect(async () => result(++calls === 1 ? 'one' : 'two'), ['worker-one']), null);
});

test('settings collection rejects invalid identities before calling the provider', async () => {
  let calls = 0;
  assert.equal(await collect(async () => { calls++; return result('one'); }, ['../other']), null);
  assert.equal(calls, 0);
});

test('settings collection rejects provider errors and duplicate names', async () => {
  assert.equal(await collect(async () => ({ success: false, errors: [] }), ['worker-one']), null);
  assert.equal(await collect(async () => ({ success: true, errors: [], result: { bindings: [{ name: 'A', type: 'plain_text' }, { name: 'A', type: 'plain_text' }] } }), ['worker-one']), null);
});
