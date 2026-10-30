import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-namespaces.mjs';

const inventory = topology.readTopologyScriptInventory ?? (() => null);
const item = index => ({ id: `worker-${index}` });
const page = (result, pageNumber = 1, totalPages = 1, totalCount = result.length) => ({
  success: true,
  errors: [],
  result,
  result_info: {
    page: pageNumber,
    per_page: 100,
    count: result.length,
    total_pages: totalPages,
    total_count: totalCount
  }
});

test('script inventory returns a complete ordered list across pages', () => {
  const first = Array.from({ length: 100 }, (_, index) => item(index));
  const last = [item(100)];
  assert.deepEqual(
    inventory([page(first, 1, 2, 101), page(last, 2, 2, 101)]),
    [...first, ...last].map(x => x.id)
  );
});

test('script inventory rejects missing pages and inconsistent totals', () => {
  assert.equal(inventory([page([item(0)], 1, 2, 101)]), null);
  assert.equal(inventory([page([item(0)], 1, 1, 2)]), null);
});

test('script inventory rejects duplicate or malformed script identities', () => {
  assert.equal(inventory([page([item(1), item(1)])]), null);
  assert.equal(inventory([page([{ id: '../other' }])]), null);
});
