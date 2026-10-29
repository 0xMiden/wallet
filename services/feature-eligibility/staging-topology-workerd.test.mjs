import assert from 'node:assert/strict';
import test from 'node:test';

test('isolated workerd cache scenario proves the real service miss and hit', async () => {
  const result = await fetch('http://127.0.0.1:18949/scenario/cache_reuse', {
    method: 'POST',
    headers: { Authorization: 'Bearer synthetic-test-only-bearer' }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { scenario: 'cache_reuse', status: 'passed' });
});

test('isolated workerd keeps two colo caches separate', async () => {
  const result = await fetch('http://127.0.0.1:18949/scenario/colo_isolation', {
    method: 'POST',
    headers: { Authorization: 'Bearer synthetic-test-only-bearer' }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { scenario: 'colo_isolation', status: 'passed' });
});

test('isolated workerd enforces the shared global budget', async () => {
  const result = await fetch('http://127.0.0.1:18949/scenario/shared_budget', {
    method: 'POST',
    headers: { Authorization: 'Bearer synthetic-test-only-bearer' }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { scenario: 'shared_budget', status: 'passed' });
});

test('isolated workerd refuses rate limits before object access', async () => {
  const result = await fetch('http://127.0.0.1:18949/scenario/rate_refusal', {
    method: 'POST',
    headers: { Authorization: 'Bearer synthetic-test-only-bearer' }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { scenario: 'rate_refusal', status: 'passed' });
});
