import assert from 'node:assert/strict';
import test from 'node:test';

import { createService } from './worker.mjs';

const origin = 'chrome-extension://wallet-extension-id';
const env = {
  ONE_CLICK_PARTNER_KEY: 'server-only-secret',
  ALLOWED_ORIGINS: JSON.stringify([origin]),
  APP_FEES: JSON.stringify([{ recipient: 'wallet.near', fee: 25 }])
};
const quoteRequest = {
  dry: false,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: 'eth:0xnative',
  depositType: 'ORIGIN_CHAIN',
  destinationAsset: 'miden:usdc',
  amount: '100',
  refundTo: '0x1111111111111111111111111111111111111111',
  refundType: 'ORIGIN_CHAIN',
  recipient: 'miden-account',
  recipientType: 'DESTINATION_CHAIN',
  deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
  appFees: [{ recipient: 'wallet.near', fee: 25 }]
};

function request(path, method = 'GET', body, requestOrigin = origin) {
  return new Request(`https://proxy.example${path}`, {
    method,
    headers: { Origin: requestOrigin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

test('requires an exact allowed origin before calling the provider', async () => {
  let calls = 0;
  const service = createService({
    fetchImpl: async () => {
      calls += 1;
      return Response.json([]);
    }
  });
  const response = await service.fetch(request('/v0/tokens', 'GET', undefined, 'https://attacker.example'), env);
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});

test('proxies tokens to the fixed official host with the server credential', async () => {
  let captured;
  const service = createService({
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response('[{"assetId":"eth:token"}]', { headers: { 'Content-Type': 'application/json' } });
    }
  });
  const response = await service.fetch(request('/v0/tokens'), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '[{"assetId":"eth:token"}]');
  assert.equal(captured.url, 'https://1click.chaindefuser.com/v0/tokens');
  assert.equal(captured.init.headers.Authorization, 'Bearer server-only-secret');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});

test('enforces the fixed fee list and forwards only exact-input origin-chain routes', async () => {
  let forwarded;
  const service = createService({
    fetchImpl: async (url, init) => {
      forwarded = { url: String(url), body: JSON.parse(init.body) };
      return new Response('{"signature":"preserved"}', { headers: { 'Content-Type': 'application/json' } });
    }
  });
  const response = await service.fetch(request('/v0/quote', 'POST', quoteRequest), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"signature":"preserved"}');
  assert.equal(forwarded.url, 'https://1click.chaindefuser.com/v0/quote');
  assert.deepEqual(forwarded.body.appFees, env.APP_FEES ? JSON.parse(env.APP_FEES) : []);
  assert.equal(forwarded.body.swapType, 'EXACT_INPUT');
  assert.equal(forwarded.body.depositType, 'ORIGIN_CHAIN');
  assert.equal(forwarded.body.refundType, 'ORIGIN_CHAIN');
  assert.equal(forwarded.body.recipientType, 'DESTINATION_CHAIN');
});

test('rejects arbitrary fields, unsafe amounts and altered app fees', async () => {
  let calls = 0;
  const service = createService({
    fetchImpl: async () => {
      calls += 1;
      return Response.json({});
    }
  });
  for (const body of [
    { ...quoteRequest, amount: Number.MAX_SAFE_INTEGER },
    { ...quoteRequest, appFees: [{ recipient: 'attacker.near', fee: 25 }] },
    { ...quoteRequest, upstream: 'https://attacker.example' },
    { ...quoteRequest, depositType: 'INTENTS' }
  ]) {
    const response = await service.fetch(request('/v0/quote', 'POST', body), env);
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('status accepts only bounded deposit references', async () => {
  let url;
  const service = createService({
    fetchImpl: async input => {
      url = String(input);
      return Response.json({ status: 'PENDING_DEPOSIT' });
    }
  });
  const response = await service.fetch(request('/v0/status?depositAddress=deposit%20one&depositMemo=1'), env);
  assert.equal(response.status, 200);
  assert.equal(url, 'https://1click.chaindefuser.com/v0/status?depositAddress=deposit+one&depositMemo=1');
  const invalid = await service.fetch(request('/v0/status?depositAddress=deposit&url=https://attacker.example'), env);
  assert.equal(invalid.status, 404);
});

test('returns 400 for malformed deposit submit JSON', async () => {
  let calls = 0;
  const service = createService({
    fetchImpl: async () => {
      calls += 1;
      return Response.json({});
    }
  });
  const malformed = new Request('https://proxy.example/v0/deposit/submit', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: '{'
  });
  const response = await service.fetch(malformed, env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_deposit_submission' });
  assert.equal(calls, 0);
});

test('returns 400 for an oversized deposit submit body with valid JSON fields', async () => {
  let calls = 0;
  const service = createService({
    fetchImpl: async () => {
      calls += 1;
      return Response.json({});
    }
  });
  const validFields = JSON.stringify({ depositAddress: 'deposit', txHash: `0x${'1'.repeat(64)}` });
  const oversized = `${validFields}${' '.repeat(32_769)}`;
  const body = new Request('https://proxy.example/v0/deposit/submit', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: oversized
  });
  const response = await service.fetch(body, env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_deposit_submission' });
  assert.equal(calls, 0);
});

test('accepts trusted receipt adapter output', async () => {
  const requestedHash = `0x${'a'.repeat(64)}`;
  const service = createService({
    fetchImpl: async () => Response.json([{ transactionHash: requestedHash, noteIds: ['note-1'] }])
  });
  const response = await service.fetch(
    request('/v1/receipts/resolve', 'POST', { transactionHashes: [requestedHash] }),
    { ...env, MIDEN_RECEIPT_ADAPTER_URL: 'https://adapter.example/resolve' }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ transactionHash: requestedHash, noteIds: ['note-1'] }]);
});

test('rejects malformed receipt adapter output', async () => {
  const requestedHash = `0x${'a'.repeat(64)}`;
  const service = createService({ fetchImpl: async () => Response.json({ transactionHash: requestedHash }) });
  const response = await service.fetch(
    request('/v1/receipts/resolve', 'POST', { transactionHashes: [requestedHash] }),
    { ...env, MIDEN_RECEIPT_ADAPTER_URL: 'https://adapter.example/resolve' }
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'invalid_receipt_response' });
});

test('rejects receipt adapter output for an unrequested transaction hash', async () => {
  const service = createService({
    fetchImpl: async () => Response.json([{ transactionHash: `0x${'b'.repeat(64)}`, noteIds: [] }])
  });
  const response = await service.fetch(
    request('/v1/receipts/resolve', 'POST', { transactionHashes: [`0x${'a'.repeat(64)}`] }),
    { ...env, MIDEN_RECEIPT_ADAPTER_URL: 'https://adapter.example/resolve' }
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'invalid_receipt_response' });
});

test('rejects more than 64 destination note IDs from the receipt adapter', async () => {
  const requestedHash = `0x${'a'.repeat(64)}`;
  const service = createService({
    fetchImpl: async () =>
      Response.json([
        { transactionHash: requestedHash, noteIds: Array.from({ length: 65 }, (_, index) => `note-${index}`) }
      ])
  });
  const response = await service.fetch(
    request('/v1/receipts/resolve', 'POST', { transactionHashes: [requestedHash] }),
    { ...env, MIDEN_RECEIPT_ADAPTER_URL: 'https://adapter.example/resolve' }
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'invalid_receipt_response' });
});

test('injects configured appFees when the quote request omits them', async () => {
  let forwarded;
  const service = createService({
    fetchImpl: async (_url, init) => {
      forwarded = JSON.parse(init.body);
      return Response.json({ signature: 'preserved' });
    }
  });
  const requestWithoutFees = { ...quoteRequest };
  delete requestWithoutFees.appFees;
  const response = await service.fetch(request('/v0/quote', 'POST', requestWithoutFees), env);
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded.appFees, JSON.parse(env.APP_FEES));
});

test('does not enable destination note resolution without a trusted adapter', async () => {
  const service = createService({
    fetchImpl: async () => {
      throw new Error('must not call');
    }
  });
  const response = await service.fetch(request('/v1/receipts/resolve', 'POST', { transactionHashes: ['0xabc'] }), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'receipt_adapter_not_configured' });
});

test('rejects a fixed app fee total above the wallet bound', async () => {
  const service = createService({ fetchImpl: async () => Response.json([]) });
  const response = await service.fetch(request('/v0/tokens'), {
    ...env,
    APP_FEES: JSON.stringify([
      { recipient: 'wallet.near', fee: 600 },
      { recipient: 'wallet2.near', fee: 500 }
    ])
  });
  assert.equal(response.status, 503);
});

test('stops reading and cancels a streamed request as soon as it exceeds the body limit', async () => {
  let bytesPulled = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      bytesPulled += 1;
      controller.enqueue(new Uint8Array(20_000));
    },
    cancel() {
      cancelled = true;
    }
  });
  const streamed = new Request('https://proxy.example/v0/quote', {
    method: 'POST',
    headers: { Origin: origin },
    body: stream,
    duplex: 'half'
  });
  const service = createService({ fetchImpl: async () => Response.json({}) });
  const response = await service.fetch(streamed, env);
  assert.equal(response.status, 400);
  assert.ok(bytesPulled <= 3);
  assert.equal(cancelled, true);
});

test('times out a request body stream that never produces data', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull() {
      return new Promise(() => undefined);
    },
    cancel() {
      cancelled = true;
    }
  });
  const streamed = new Request('https://proxy.example/v0/quote', {
    method: 'POST',
    headers: { Origin: origin },
    body: stream,
    duplex: 'half'
  });
  const service = createService({ fetchImpl: async () => Response.json({}), timeoutMs: 10 });
  const response = await service.fetch(streamed, env);
  assert.equal(response.status, 400);
  assert.equal(cancelled, true);
});
