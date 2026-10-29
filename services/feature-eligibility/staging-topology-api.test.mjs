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

test('read adapter does not start a request after the total deadline', async () => {
  let calls = 0;
  const times = [0, 119_999, 120_000];
  const api = create({
    accountId,
    token,
    now: () => times.shift() ?? 120_000,
    fetchImpl: async () => {
      calls++;
      return Response.json({ success: true });
    }
  });
  assert.equal(await api('/account'), null);
  assert.equal(calls, 0);
});

test('read adapter strips unrelated setting values while retaining fixed ownership markers', async () => {
  const path = '/workers/scripts/miden-elig-topology-12345-1/settings';
  const api = create({
    accountId,
    token,
    fetchImpl: async () =>
      Response.json({
        success: true,
        errors: [],
        result: {
          bindings: [
            { name: 'PASSWORD', type: 'secret_text', text: 'private-sentinel' },
            { name: 'TOPOLOGY_OWNER', type: 'plain_text', text: 'a'.repeat(64) }
          ]
        }
      })
  });
  const value = await api(path);
  assert.equal(JSON.stringify(value).includes('private-sentinel'), false);
  assert.equal(value?.result?.bindings[1]?.text, 'a'.repeat(64));
});

test('read adapter preserves explicit script logging state without exposing unrelated provider data', async () => {
  const path = '/workers/scripts/miden-elig-topology-12345-1/script-settings';
  const api = create({
    accountId,
    token,
    fetchImpl: async () =>
      Response.json({
        success: true,
        errors: [],
        result: {
          logpush: false,
          observability: { enabled: false },
          tail_consumers: [],
          unrelated: 'private-sentinel'
        }
      })
  });
  const value = await api(path);
  assert.deepEqual(value, {
    success: true,
    errors: [],
    result: { logpush: false, observability: { enabled: false }, tail_consumers: [] }
  });
});

test('script logging observation preserves unknown observability and refuses tail consumers', async () => {
  const path = '/workers/scripts/miden-elig-topology-12345-1/script-settings';
  const makeApi = result =>
    create({ accountId, token, fetchImpl: async () => Response.json({ success: true, errors: [], result }) });
  assert.equal((await makeApi({ observability: null })(path))?.result?.observability, null);
  assert.equal(await makeApi({ tail_consumers: [{ service: 'other-worker' }] })(path), null);
  assert.equal(await makeApi({ observability: {} })(path), null);
  assert.equal(await makeApi({})('/workers/scripts/production/script-settings'), null);
});
