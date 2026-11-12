import assert from 'node:assert/strict';
import test from 'node:test';

import { runBudgetScenario } from './staging-topology.mjs';

function harness({ split = false, duplicateBypasses = false } = {}) {
  let count = 12;
  let reserveCount = 0;
  let leaseCount = 0;
  const leases = new Map();
  const budget = {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.json();
      assert.equal(body.day, '2026-10-29');
      assert.equal(request.method, 'POST');
      if (path === '/reserve') {
        reserveCount++;
        if (split) return Response.json({ reserved: true });
        if (count >= 16) return Response.json({ error: 'unavailable' }, { status: 503 });
        count++;
        return Response.json({ reserved: true });
      }
      assert.equal(path, '/lease');
      leaseCount++;
      const existing = leases.get(body.leaseId);
      if (existing && !duplicateBypasses) {
        return existing.requested === body.count
          ? Response.json({ reserved: true, count: existing.granted })
          : Response.json({ error: 'unavailable' }, { status: 503 });
      }
      const granted = Math.min(body.count, 16 - count);
      if (!granted) return Response.json({ error: 'unavailable' }, { status: 503 });
      count += granted;
      leases.set(body.leaseId, { requested: body.count, granted });
      return Response.json({ reserved: true, count: granted });
    }
  };
  return {
    budget,
    now: () => Date.parse('2026-10-29T00:00:00Z'),
    counters: async () => ({ count }),
    stats: () => ({ count, reserveCount, leaseCount })
  };
}

test('budget scenario shares one cap across reserve and lease paths', async () => {
  const fixture = harness();
  assert.equal(await runBudgetScenario(fixture), 'passed');
  assert.equal(fixture.stats().count, 16);
  assert.ok(fixture.stats().reserveCount >= 2);
  assert.ok(fixture.stats().leaseCount >= 1);
});

test('budget scenario rejects reserve paths that bypass the shared cap', async () => {
  const fixture = harness({ split: true });
  assert.equal(await runBudgetScenario(fixture), 'failed');
  assert.ok(fixture.stats().reserveCount >= 1);
});

test('budget scenario checks identical and mismatched duplicate leases', async () => {
  const fixture = harness();
  assert.equal(await runBudgetScenario(fixture), 'passed');
  assert.ok(fixture.stats().leaseCount >= 3);
});

test('budget scenario rejects duplicate lease paths that reserve again', async () => {
  const fixture = harness({ duplicateBypasses: true });
  assert.equal(await runBudgetScenario(fixture), 'failed');
});
