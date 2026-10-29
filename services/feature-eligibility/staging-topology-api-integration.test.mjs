import assert from 'node:assert/strict';
import test from 'node:test';
import { createTopologyReadApi } from './staging-topology-api.mjs';
import { prepareTopologyInventory } from './staging-topology-preflight.mjs';

const accountId = 'a'.repeat(32);
const token = 'synthetic-token-for-test-only';
const identity = {
  repository: '0xMiden/wallet',
  workflowPath: '.github/workflows/feature-eligibility-topology.yml',
  sourceSha: 'a'.repeat(40),
  runId: '12345',
  runAttempt: '1'
};
const now = Date.UTC(2026, 9, 29);
const page = (result, perPage) => ({
  success: true,
  errors: [],
  result,
  result_info: { page: 1, per_page: perPage, count: result.length, total_pages: 1, total_count: result.length }
});

function fixture({ collision = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    const parsed = new URL(url);
    const base = `/client/v4/accounts/${accountId}`;
    if (parsed.pathname === base) return Response.json({ success: true, errors: [], result: { id: accountId } });
    if (parsed.pathname === `${base}/workers/scripts` && parsed.search === '?page=1&per_page=100')
      return Response.json(page([{ id: 'other-worker' }], 100));
    if (parsed.pathname === `${base}/workers/durable_objects/namespaces` && parsed.search === '?page=1&per_page=1000')
      return Response.json(page([], 1000));
    if (parsed.pathname === `${base}/workers/scripts/miden-elig-topology-12345-1/settings`)
      return collision
        ? Response.json({ success: true, errors: [] })
        : Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    throw new Error('Unexpected request');
  };
  const api = createTopologyReadApi({ accountId, token, fetchImpl });
  const options = {
    api,
    accountId,
    identity,
    bundle: new Uint8Array([1, 2, 3]),
    now,
    expiresAt: now + 600_000,
    maxRuns: 10
  };
  return { calls, options };
}

test('read-only topology preflight composes bounded provider reads without deploying', async () => {
  const { calls, options } = fixture();
  const result = await prepareTopologyInventory(options);
  assert.equal(result?.status, 'inventory_observed');
  assert.equal(result?.deploymentAuthorized, false);
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('read-only topology preflight refuses a direct script collision', async () => {
  const { options } = fixture({ collision: true });
  assert.equal(await prepareTopologyInventory(options), null);
});
