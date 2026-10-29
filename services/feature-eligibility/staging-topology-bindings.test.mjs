import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-namespaces.mjs';

const validate = topology.validateTopologyBindings ?? (() => false);
const target = 'miden-elig-topology-123-1';
const ownedId = '00000000000000000000000000000001';
const expected = { script: target, namespaceIds: [ownedId], scripts: [target, 'other-worker'] };
const binding = {
  name: 'GUARD',
  type: 'durable_object_namespace',
  class_name: 'EligibilityGuard',
  namespace_id: ownedId
};
const scripts = () => [
  { id: target, bindings: [binding] },
  { id: 'other-worker', bindings: [{ name: 'OTHER', type: 'plain_text' }] }
];

test('binding inventory accepts complete isolated ownership', () => {
  assert.equal(validate(scripts(), expected), true);
});

test('binding inventory rejects a cross-worker namespace reference', () => {
  const values = scripts();
  values[1].bindings.push({ ...binding, script_name: target });
  assert.equal(validate(values, expected), false);
});

test('binding inventory rejects a cross-worker script reference even with a different namespace', () => {
  const values = scripts();
  values[1].bindings.push({ ...binding, namespace_id: '00000000000000000000000000000002', script_name: target });
  assert.equal(validate(values, expected), false);
});

test('binding inventory rejects missing or duplicate script settings', () => {
  assert.equal(validate(scripts().slice(0, 1), expected), false);
  assert.equal(validate([...scripts(), scripts()[1]], expected), false);
});

test('binding inventory rejects ambiguous durable-object bindings', () => {
  const values = scripts();
  values[1].bindings.push({ name: 'AMBIGUOUS', type: 'durable_object_namespace', class_name: 'Other' });
  assert.equal(validate(values, expected), false);
});

test('binding inventory rejects unexpected or duplicated target-worker namespaces', () => {
  const extra = scripts();
  extra[0].bindings.push({ ...binding, name: 'EXTRA', namespace_id: '00000000000000000000000000000002' });
  assert.equal(validate(extra, expected), false);
  const duplicate = scripts();
  duplicate[0].bindings.push({ ...binding, name: 'DUPLICATE' });
  assert.equal(validate(duplicate, expected), false);
});

test('binding inventory rejects duplicated target-worker namespaces independently', () => {
  const values = scripts();
  values[0].bindings.push({ ...binding, name: 'DUPLICATE' });
  assert.equal(validate(values, expected), false);
});
