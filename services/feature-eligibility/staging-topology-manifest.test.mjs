import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-manifest.mjs';

const build = topology.buildTopologyManifest ?? (() => null);
const identity = {
  repository: '0xMiden/wallet',
  workflowPath: '.github/workflows/feature-eligibility-topology.yml',
  sourceSha: 'a'.repeat(40),
  runId: '12345',
  runAttempt: '1'
};
const now = Date.UTC(2026, 9, 29);
const bundle = new Uint8Array([1, 2, 3]);
const options = () => ({ identity, bundle, now, expiresAt: now + 600_000, maxRuns: 10, inventory: [] });

test('topology manifest binds fixed run identity, artifact and limits', () => {
  const value = build(options());
  assert.equal(value?.scriptName, 'miden-elig-topology-12345-1');
  assert.match(value?.bundleSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(value?.configSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(value?.ownerMarker ?? '', /^[a-f0-9]{64}$/);
  assert.equal(value?.maxRuns, 10);
  assert.equal(value?.expiresAt, now + 600_000);
  assert.equal(value?.config.main, 'staging-topology-worker.mjs');
  assert.equal(Object.isFrozen(value?.config?.vars), true);
  assert.equal(JSON.stringify(value).includes('credential'), false);
});

test('topology manifest rejects untrusted identity and unbounded runs', () => {
  assert.equal(build({ ...options(), identity: { ...identity, repository: 'other/repo' } }), null);
  assert.equal(build({ ...options(), expiresAt: now + 900_001 }), null);
  assert.equal(build({ ...options(), maxRuns: 21 }), null);
  assert.equal(build({ ...options(), bundle: new Uint8Array() }), null);
});

test('topology manifest rejects an existing script name', () => {
  assert.equal(build({ ...options(), inventory: [{ id: 'miden-elig-topology-12345-1' }] }), null);
});

test('topology manifest rejects accessor-backed identity and inventory', () => {
  const withGetter = { ...identity };
  Object.defineProperty(withGetter, 'sourceSha', { enumerable: true, get: () => 'a'.repeat(40) });
  assert.equal(build({ ...options(), identity: withGetter }), null);
  const item = {};
  Object.defineProperty(item, 'id', { enumerable: true, get: () => 'worker' });
  assert.equal(build({ ...options(), inventory: [item] }), null);
});
