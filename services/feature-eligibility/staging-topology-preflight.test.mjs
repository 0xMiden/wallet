import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-preflight.mjs';

const prepare = topology.prepareTopologyInventory ?? (() => null);
const identity = {
  repository: '0xMiden/wallet',
  workflowPath: '.github/workflows/feature-eligibility-topology.yml',
  sourceSha: 'a'.repeat(40),
  runId: '12345',
  runAttempt: '1'
};
const accountId = 'a'.repeat(32);
const now = Date.UTC(2026, 9, 29);
const page = ids => ({
  success: true,
  errors: [],
  result: ids.map(id => ({ id })),
  result_info: { page: 1, per_page: 100, count: ids.length, total_pages: 1, total_count: ids.length }
});
const options = api => ({
  api,
  accountId,
  identity,
  bundle: new Uint8Array([1, 2, 3]),
  now,
  expiresAt: now + 600_000,
  maxRuns: 10
});
function provider({ account = accountId, scripts = ['other-worker'], namespaces = [], target = { status: 404, body: { success: false, errors: [{ code: 10007 }] } } } = {}) {
  return async path => {
    if (path === '/account') return { success: true, errors: [], result: { id: account } };
    if (path === '/workers/scripts?page=1&per_page=100') return page(scripts);
    if (path === '/workers/scripts/miden-elig-topology-12345-1/settings') return target;
    if (path === '/workers/durable_objects/namespaces?page=1&per_page=1000')
      return {
        success: true,
        errors: [],
        result: namespaces,
        result_info: {
          page: 1,
          per_page: 1000,
          count: namespaces.length,
          total_pages: 1,
          total_count: namespaces.length
        }
      };
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

test('account-bound preparation rejects a pre-existing topology namespace', async () => {
  const namespace = {
    id: '1'.repeat(32),
    class: 'EligibilityGuard',
    script: 'miden-elig-topology-12345-1',
    use_sqlite: true
  };
  assert.equal(await prepare(options(provider({ namespaces: [namespace] }))), null);
});

test('account-bound preparation rejects changing or incomplete namespace inventory', async () => {
  let calls = 0;
  const base = provider();
  const changed = async path => {
    if (path !== '/workers/durable_objects/namespaces?page=1&per_page=1000') return base(path);
    const entries =
      ++calls === 1 ? [] : [{ id: '2'.repeat(32), class: 'Other', script: 'other-worker', use_sqlite: true }];
    return {
      success: true,
      errors: [],
      result: entries,
      result_info: { page: 1, per_page: 1000, count: entries.length, total_pages: 1, total_count: entries.length }
    };
  };
  assert.equal(await prepare(options(changed)), null);
  const incomplete = async path =>
    path === '/workers/durable_objects/namespaces?page=1&per_page=1000'
      ? { success: true, errors: [], result: [] }
      : base(path);
  assert.equal(await prepare(options(incomplete)), null);
});

test('account-bound preparation requires an explicit provider absence receipt', async () => {
  assert.equal(await prepare(options(provider({ target: { status: 200, body: { success: true } } }))), null);
  assert.equal(await prepare(options(provider({ target: { status: 404, body: { success: false, errors: [] } } }))), null);
});
