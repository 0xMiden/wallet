import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-api.mjs';

const create = topology.createTopologyReadApi ?? (() => async () => null);
const accountId = 'a'.repeat(32);
const token = 'synthetic-token-for-test-only';

test('read adapter calls only fixed account paths without returning credentials', async () => {
  const calls = [];
  const api = create({
    accountId,
    token,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, authorization: init.headers.Authorization });
      return Response.json({ success: true, errors: [], result: { id: accountId } });
    }
  });
  const response = await api('/account');
  assert.deepEqual(response, { success: true, errors: [], result: { id: accountId } });
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${accountId}`);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].authorization, `Bearer ${token}`);
  assert.equal(JSON.stringify(response).includes(token), false);
});

test('read adapter rejects arbitrary paths before network access', async () => {
  let calls = 0;
  const api = create({
    accountId,
    token,
    fetchImpl: async () => {
      calls++;
      return Response.json({});
    }
  });
  assert.equal(await api('/workers/scripts/../production'), null);
  assert.equal(calls, 0);
});

test('read adapter rejects oversized provider bodies', async () => {
  const api = create({ accountId, token, fetchImpl: async () => new Response(new Uint8Array(1_048_577)) });
  assert.equal(await api('/account'), null);
});

test('read adapter retains only a valid target-script absence receipt', async () => {
  const path = '/workers/scripts/miden-elig-topology-12345-1/settings';
  const api = create({
    accountId,
    token,
    fetchImpl: async () => Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 })
  });
  assert.deepEqual(await api(path), { status: 404, body: { success: false, errors: [{ code: 10007 }] } });
  assert.equal(await api('/account'), null);
});
