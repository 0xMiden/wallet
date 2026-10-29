import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-manifest.mjs';

const verify = topology.verifyTopologyManifest ?? (() => false);
const now = Date.UTC(2026, 9, 29);
const options = () => ({ identity: { repository: '0xMiden/wallet', workflowPath: '.github/workflows/feature-eligibility-topology.yml', sourceSha: 'a'.repeat(40), runId: '12345', runAttempt: '1' }, bundle: new Uint8Array([1, 2, 3]), now, expiresAt: now + 600_000, maxRuns: 10, inventory: [] });
const clone = value => JSON.parse(JSON.stringify(value));

test('manifest verification accepts exactly reconstructed run identity', () => {
  const opts = options();
  assert.equal(verify(clone(topology.buildTopologyManifest(opts)), opts), true);
});

test('manifest verification rejects changed config, artifact and extra fields', () => {
  const opts = options();
  const value = clone(topology.buildTopologyManifest(opts));
  value.config.vars.TOPOLOGY_RUN_MAX = '20';
  assert.equal(verify(value, opts), false);
  assert.equal(verify(clone(topology.buildTopologyManifest(opts)), { ...opts, bundle: new Uint8Array([9]) }), false);
  const extra = clone(topology.buildTopologyManifest(opts));
  extra.extra = true;
  assert.equal(verify(extra, opts), false);
});

test('manifest verification rejects accessor-backed properties', () => {
  const opts = options();
  const value = clone(topology.buildTopologyManifest(opts));
  Object.defineProperty(value.config.vars, 'TOPOLOGY_RUN_MAX', { enumerable: true, get: () => '10' });
  assert.equal(verify(value, opts), false);
});
