import assert from 'node:assert/strict';
import test from 'node:test';

const baseUrl = process.env.TOPOLOGY_TEST_URL ?? 'http://127.0.0.1:18949';
const bearer = process.env.TOPOLOGY_TEST_BEARER ?? 'synthetic-test-only-bearer';

async function runScenario(name) {
  const result = await fetch(`${baseUrl}/scenario/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { scenario: name, status: 'passed' });
}

async function runInFreshRateWindow(name) {
  // Native buckets reset on wall-clock boundaries; keep each five-request proof within a full 10 s window.
  const periodMs = 10_000;
  await new Promise(resolve => setTimeout(resolve, periodMs - (Date.now() % periodMs) + 25));
  await runScenario(name);
}

test('isolated workerd cache scenario proves the real service miss and hit', async () => {
  await runScenario('cache_reuse');
});

test('isolated workerd keeps two colo caches separate', async () => {
  await runScenario('colo_isolation');
});

test('isolated workerd enforces the shared global budget', async () => {
  await runScenario('shared_budget');
});

test('isolated workerd refuses rate limits before object access', async () => {
  await runScenario('rate_refusal');
});

test('isolated workerd wires the configured rate-limit bindings through the Worker', async () => {
  await runInFreshRateWindow('wired_rate');
});

test('isolated workerd distinguishes overload from retryable failure', async () => {
  await runScenario('failure_behavior');
});

test('isolated workerd retains lease state through restart and day boundary', async () => {
  await runScenario('restart_day');
});

test('isolated workerd exercises both native rate limit bindings', async () => {
  await runInFreshRateWindow('native_rate');
});
