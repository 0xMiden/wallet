import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-namespaces.mjs';

const validate = topology.validateTopologyNamespaces ?? (() => false);
const expected = { script: 'miden-elig-topology-123-1', classes: ['TopologyControl', 'EligibilityGuard', 'CallerEligibilityGuard', 'RestartProof'] };
const item = (name, index) => ({ id: String(index).padStart(32, '0'), class: name, name, script: expected.script, use_sqlite: true });
const page = (result, pageNumber = 1, totalPages = 1, totalCount = result.length) => ({
  success: true, errors: [], result,
  result_info: { page: pageNumber, per_page: 1000, count: result.length, total_pages: totalPages, total_count: totalCount }
});
const owned = expected.classes.map((name, index) => item(name, index + 1));

test('namespace inventory accepts only complete matching owned classes', () => {
  assert.equal(validate([page(owned)], expected), true);
});

test('namespace inventory rejects missing identity and unexpected classes', () => {
  assert.equal(validate([page(owned.map((entry, index) => index ? entry : { ...entry, id: undefined }))], expected), false);
  assert.equal(validate([page([...owned, item('Unexpected', 8)])], expected), false);
});

test('namespace inventory rejects duplicate namespace identities', () => {
  assert.equal(validate([page(owned.map((entry, index) => index === 1 ? { ...entry, id: owned[0].id } : entry))], expected), false);
});

test('namespace inventory rejects incomplete or inconsistent pagination', () => {
  assert.equal(validate([page(owned.slice(0, 2), 1, 2, 4)], expected), false);
  assert.equal(validate([page(owned.slice(0, 2), 1, 2, 4), page(owned.slice(2), 2, 2, 5)], expected), false);
});
