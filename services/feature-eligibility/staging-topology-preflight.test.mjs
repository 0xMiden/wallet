import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-preflight.mjs';

const prepare = topology.prepareTopologyInventory ?? (() => null);
const identity = { repository: '0xMiden/wallet', workflowPath: '.github/workflows/feature-eligibility-topology.yml', sourceSha: 'a'.repeat(40), runId: '12345', runAttempt: '1' };
const accountId = 'a'.repeat(32);
const now = Date.UTC(2026, 9, 29);
const page = ids => ({ success: true, errors: [], result: ids.map(id => ({ id })), result_info: { page: 1, per_page: 100, count: ids.length, total_pages: 1, total_count: ids.length } });
const options = api => ({ api, accountId, identity, bundle: new Uint8Array([1, 2, 3]), now, expiresAt: now + 600_000, maxRuns: 10 });
function provider({ account = accountId, scripts = ['other-worker'] } = {}) {
  return async path => {
    if (path === '/account') return { success: true, errors: [], result: { id: account } };
    if (path === '/workers/scripts?page=1&per_page=100') return page(scripts);
    throw new Error('Unexpected path');
  };
}

test('account-bound inventory preparation produces only a local manifest', async () => {
  const result = await prepare(options(provider()));
  assert.equal(result?.status, 'inventory_observed');
  assert.equal(result?.manifest?.scriptName, 'miden-elig-topology-12345-1');
  assert.equal(result?.deploymentAuthorized, false);
});

test('account-bound preparation rejects a mismatched or malformed account', async () => {
  assert.equal(await prepare(options(provider({ account: 'b'.repeat(32) }))), null);
  assert.equal(await prepare({ ...options(provider()), accountId: '../bad' }), null);
});

test('account-bound preparation rejects a pre-existing script', async () => {
  assert.equal(await prepare(options(provider({ scripts: ['miden-elig-topology-12345-1'] }))), null);
});
