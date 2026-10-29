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
