import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology-api.mjs';

const create = topology.createTopologyReadApi ?? (() => async () => null);
const deleteScript = topology.createTopologyScriptDeleter ?? (() => async () => false);
const accountId = 'a'.repeat(32);
const token = 'synthetic-token-for-test-only';

test('read adapter calls only fixed account paths without returning credentials', async () => {
  const calls = [];
  const api = create({
    accountId,
    token,
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        method: init.method,
        authorization: init.headers.Authorization,
        redirect: init.redirect
      });
      return Response.json({ success: true, errors: [], result: { id: accountId } });
    }
  });
  const response = await api('/account');
  assert.deepEqual(response, { success: true, errors: [], result: { id: accountId } });
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${accountId}`);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].authorization, `Bearer ${token}`);
  assert.equal(calls[0].redirect, 'error');
  assert.equal(JSON.stringify(response).includes(token), false);
});

test('read adapter returns only the account and script workers.dev settings', async () => {
  const api = create({
    accountId,
    token,
    fetchImpl: async url =>
      Response.json(
        new URL(url).pathname.endsWith('/workers/subdomain')
          ? { success: true, errors: [], result: { subdomain: 'wallet-topology', private: 'sentinel' } }
          : {
              success: true,
              errors: [],
              result: { enabled: true, previews_enabled: false, private: 'sentinel' }
            }
      )
  });
  assert.deepEqual(await api('/workers/subdomain'), {
    success: true,
    errors: [],
    result: { subdomain: 'wallet-topology' }
  });
  assert.deepEqual(await api('/workers/scripts/miden-elig-topology-12345-1/subdomain'), {
    success: true,
    errors: [],
    result: { enabled: true, previews_enabled: false }
  });
  assert.equal(await api('/workers/scripts/production/subdomain'), null);
});

test('read adapter rejects malformed workers.dev settings', async () => {
  const response = value => create({ accountId, token, fetchImpl: async () => Response.json(value) });
  assert.equal(
    await response({ success: true, errors: [], result: { subdomain: 'bad.example' } })('/workers/subdomain'),
    null
  );
  assert.equal(
    await response({ success: true, errors: [], result: { enabled: true } })(
      '/workers/scripts/miden-elig-topology-12345-1/subdomain'
    ),
    null
  );
  const arrayResult = Object.assign([], { enabled: true, previews_enabled: false });
  assert.equal(
    await response({ success: true, errors: [], result: arrayResult })(
      '/workers/scripts/miden-elig-topology-12345-1/subdomain'
    ),
    null
  );
  assert.equal(
    topology.parseWorkerSubdomainSettings({
      success: true,
      errors: [],
      result: Object.create({ enabled: true, previews_enabled: false })
    }),
    null
  );
});

test('readBoundedBytes honors mid-stream signal abort, custom maxBytes, and stream read errors', async () => {
  const controller = new AbortController();
  let pulls = 0;
  const abortStream = new ReadableStream({
    pull(chunkController) {
      pulls++;
      if (pulls === 1) {
        chunkController.enqueue(new Uint8Array([1, 2]));
        controller.abort();
      } else {
        chunkController.close();
      }
    }
  });
  assert.equal(
    await topology.readBoundedBytes(new Response(abortStream), { maxBytes: 64, signal: controller.signal }),
    null
  );

  const oversized = new ReadableStream({
    start(chunkController) {
      chunkController.enqueue(new Uint8Array(65));
      chunkController.close();
    }
  });
  assert.equal(await topology.readBoundedBytes(new Response(oversized), { maxBytes: 64 }), null);

  const failingStream = new ReadableStream({
    pull() {
      return Promise.reject(new Error('stream_read_failed'));
    }
  });
  assert.equal(await topology.readBoundedBytes(new Response(failingStream), { maxBytes: 64 }), null);
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

test('read adapter propagates phase-budget aborts to the in-flight fetch', { timeout: 500 }, async () => {
  const phase = new AbortController();
  let requestSignal;
  let markStarted;
  let releaseFetch;
  const started = new Promise(resolve => {
    markStarted = resolve;
  });
  const api = create({
    accountId,
    token,
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      markStarted();
      await new Promise(resolve => {
        releaseFetch = resolve;
      });
      return Response.json({ success: true, errors: [], result: { id: accountId } });
    }
  });
  const request = api('/account', { signal: phase.signal });
  try {
    await started;
    assert.equal(requestSignal.aborted, false);
    phase.abort();
    assert.equal(requestSignal.aborted, true);
  } finally {
    releaseFetch?.();
  }
  assert.equal(await request, null);
});

test('script deleter accepts only the exact topology worker path without force options', async () => {
  const calls = [];
  const remove = deleteScript({
    accountId,
    token,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ success: true, errors: [], result: {} });
    }
  });
  assert.equal(await remove('miden-elig-topology-12345-1'), true);
  assert.equal(await remove('production-worker'), false);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/miden-elig-topology-12345-1`
  );
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(new URL(calls[0].url).search, '');
  assert.equal(Object.hasOwn(calls[0].init, 'body'), false);
});

test('script deleter accepts Cloudflare’s successful bodyless response', async () => {
  const remove = deleteScript({ accountId, token, fetchImpl: async () => new Response(null, { status: 200 }) });
  assert.equal(await remove('miden-elig-topology-12345-1'), true);
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

test('read adapter is stateless and leaves budgets to the caller', async () => {
  let calls = 0;
  let clock = 1_800_000_000_000;
  const api = create({
    accountId,
    token,
    now: () => clock,
    startedAt: clock,
    fetchImpl: async () => {
      calls++;
      return Response.json({ success: true, errors: [], result: { id: accountId } });
    }
  });
  for (let index = 0; index < 251; index++) {
    assert.deepEqual(await api('/account'), { success: true, errors: [], result: { id: accountId } });
  }
  assert.equal(calls, 251);
  clock += 120_000;
  assert.deepEqual(await api('/account'), { success: true, errors: [], result: { id: accountId } });
  assert.equal(calls, 252);
});

test('read adapter bounds an unsignalled stalled fetch', { timeout: 500 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  const api = create({
    accountId,
    token,
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      await new Promise(() => {});
    }
  });
  const pending = api('/account');
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  assert.equal(await pending, null);
  assert.equal(requestSignal.aborted, true);
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

test('script logging observation preserves closed structural indicators without leaking values', async () => {
  const path = '/workers/scripts/miden-elig-topology-12345-1/script-settings';
  const makeApi = result =>
    create({ accountId, token, fetchImpl: async () => Response.json({ success: true, errors: [], result }) });
  assert.deepEqual(await makeApi({ logpush: null, tail_consumers: [] })(path), {
    success: true,
    errors: [],
    result: { logpush: null, tail_consumers: [] }
  });
  assert.deepEqual(await makeApi({ observability: null })(path), {
    success: true,
    errors: [],
    result: { observability: null }
  });
  assert.deepEqual(await makeApi({ observability: {} })(path), {
    success: true,
    errors: [],
    result: { observability: {} }
  });
  assert.deepEqual(await makeApi({ observability: { enabled: null } })(path), {
    success: true,
    errors: [],
    result: { observability: { enabled: null } }
  });
  assert.deepEqual(
    await makeApi({ observability: { enabled: false, logs: { persist: null, secret: 'private-sentinel' } } })(path),
    {
      success: true,
      errors: [],
      result: { observability: { enabled: false, logs: { persist: null } } }
    }
  );
  const nonEmptyTails = await makeApi({ tail_consumers: [{ service: 'other-worker' }] })(path);
  assert.deepEqual(nonEmptyTails, {
    success: true,
    errors: [],
    result: { tail_consumers: [{}] }
  });
  assert.equal(JSON.stringify(nonEmptyTails).includes('other-worker'), false);
  assert.deepEqual(await makeApi({ tail_consumers: null })(path), {
    success: true,
    errors: [],
    result: { tail_consumers: null }
  });
  assert.deepEqual(await makeApi({ logpush: 'false', extra: 'private-sentinel' })(path), {
    success: true,
    errors: [],
    result: { logpush: 'unexpected_type' }
  });
  assert.deepEqual(await makeApi({ observability: ['private-sentinel'] })(path), {
    success: true,
    errors: [],
    result: { observability: 'unexpected_type' }
  });
  assert.deepEqual(await makeApi({ observability: { enabled: false, logs: ['private-sentinel'] } })(path), {
    success: true,
    errors: [],
    result: { observability: { enabled: false, logs: 'unexpected_type' } }
  });
  assert.deepEqual(await makeApi({ observability: { enabled: false, logs: null } })(path), {
    success: true,
    errors: [],
    result: { observability: { enabled: false, logs: null } }
  });
  assert.equal(await makeApi([])(path), null);
  assert.equal(await makeApi({})('/workers/scripts/production/script-settings'), null);
});

test('read adapter returns only the digest of the fixed target module content', async () => {
  const path = '/workers/scripts/miden-elig-topology-12345-1/content/v2';
  const api = create({
    accountId,
    token,
    fetchImpl: async () =>
      new Response('abc', {
        headers: { 'content-type': 'application/javascript+module', 'cf-entrypoint': 'staging-topology-worker.mjs' }
      })
  });
  assert.deepEqual(await api(path), { sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
});

test('content observation rejects wrong module identity and non-target paths', async () => {
  const api = create({
    accountId,
    token,
    fetchImpl: async () =>
      new Response('abc', {
        headers: { 'content-type': 'application/javascript', 'cf-entrypoint': 'other.mjs' }
      })
  });
  assert.equal(await api('/workers/scripts/miden-elig-topology-12345-1/content/v2'), null);
  assert.equal(await api('/workers/scripts/production/content/v2'), null);
});

test('content observation hashes the sole named multipart module', async () => {
  const form = new FormData();
  form.append(
    'staging-topology-worker.mjs',
    new Blob(['abc'], { type: 'application/javascript+module' }),
    'staging-topology-worker.mjs'
  );
  const api = create({
    accountId,
    token,
    fetchImpl: async () =>
      new Response(form, {
        headers: { 'cf-entrypoint': 'staging-topology-worker.mjs' }
      })
  });
  assert.deepEqual(await api('/workers/scripts/miden-elig-topology-12345-1/content/v2'), {
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  });
});

test('script observation retains independent logging and tracing switches', async () => {
  const path = '/workers/scripts/miden-elig-topology-12345-1/script-settings';
  const api = create({
    accountId,
    token,
    fetchImpl: async () =>
      Response.json({
        success: true,
        errors: [],
        result: {
          observability: {
            enabled: false,
            logs: { enabled: true, invocation_logs: true, persist: true },
            traces: { enabled: true, persist: false }
          }
        }
      })
  });
  const result = await api(path);
  assert.deepEqual(result?.result?.observability, {
    enabled: false,
    logs: { enabled: true, invocation_logs: true, persist: true },
    traces: { enabled: true, persist: false }
  });
});

function createAbortingMultiChunkStream(onFirstChunk) {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream(
    {
      pull(chunkController) {
        state.pulls++;
        if (state.pulls === 1) {
          chunkController.enqueue(new Uint8Array([123]));
          onFirstChunk();
          return;
        }
        chunkController.enqueue(new Uint8Array([125]));
        chunkController.close();
      },
      cancel() {
        state.cancelled = true;
      }
    },
    new CountQueuingStrategy({ highWaterMark: 0 })
  );
  return { stream, state };
}

test('read adapter forwards abort signal to readBoundedBytes for JSON responses', { timeout: 500 }, async () => {
  const phase = new AbortController();
  const { stream, state } = createAbortingMultiChunkStream(() => phase.abort());
  const api = create({
    accountId,
    token,
    fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'application/json' } })
  });
  assert.equal(await api('/account', { signal: phase.signal }), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.pulls, 1);
  assert.equal(state.cancelled, true);
});

test('read adapter forwards abort signal through contentDigest to readBoundedBytes', { timeout: 500 }, async () => {
  const phase = new AbortController();
  const { stream, state } = createAbortingMultiChunkStream(() => phase.abort());
  const api = create({
    accountId,
    token,
    fetchImpl: async () =>
      new Response(stream, {
        headers: { 'content-type': 'application/javascript+module', 'cf-entrypoint': 'staging-topology-worker.mjs' }
      })
  });
  assert.equal(await api('/workers/scripts/miden-elig-topology-12345-1/content/v2', { signal: phase.signal }), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.pulls, 1);
  assert.equal(state.cancelled, true);
});

test('script deleter forwards timeout abort signal to readBoundedBytes', { timeout: 500 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stream, state } = createAbortingMultiChunkStream(() => t.mock.timers.tick(5_000));
  const deleter = deleteScript({
    accountId,
    token,
    fetchImpl: async () => new Response(stream, { status: 200 })
  });
  assert.equal(await deleter('miden-elig-topology-12345-1'), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.pulls, 1);
  assert.equal(state.cancelled, true);
});
