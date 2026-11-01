import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-namespaces.mjs';

const collect = topology.collectTopologyScriptInventory ?? (() => null);
const page = ids => ({
  success: true,
  errors: [],
  result: ids.map(id => ({ id })),
  result_info: { page: 1, per_page: 100, count: ids.length, total_pages: 1, total_count: ids.length }
});

test('script collection repeats the bounded fixed-path inventory and returns matching identities', async () => {
  const calls = [];
  const result = await collect(async path => {
    calls.push(path);
    return page(['worker-one']);
  });
  assert.deepEqual(result, ['worker-one']);
  assert.deepEqual(calls, ['/workers/scripts?page=1&per_page=100', '/workers/scripts?page=1&per_page=100']);
});

test('script collection rejects a changed inventory', async () => {
  let calls = 0;
  assert.equal(await collect(async () => page([++calls === 1 ? 'worker-one' : 'worker-two'])), null);
});

test('script collection rejects failed or incomplete provider responses', async () => {
  assert.equal(await collect(async () => ({ success: false, errors: [] })), null);
  assert.equal(
    await collect(async () => {
      throw new Error('unavailable');
    }),
    null
  );
});
