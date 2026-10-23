const UPSTREAM = 'https://1click.chaindefuser.com';
const MAX_BODY_BYTES = 32_768;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TIMEOUT_MS = 12_000;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...headers }
  });
}

function validOrigins(env) {
  const origins = JSON.parse(env.ALLOWED_ORIGINS ?? '[]');
  if (!Array.isArray(origins) || origins.length === 0 || origins.some(origin => typeof origin !== 'string' || !origin || origin.includes('*'))) {
    throw new Error('Invalid origin configuration');
  }
  return new Set(origins);
}

function validFees(env) {
  if (!env.APP_FEES) return [];
  const fees = JSON.parse(env.APP_FEES);
  if (!Array.isArray(fees) || fees.length > 3 || fees.some(fee => !record(fee) ||
      typeof fee.recipient !== 'string' || fee.recipient.length < 2 || fee.recipient.length > 64 ||
      !/^[a-z0-9._-]+$/.test(fee.recipient) || !Number.isSafeInteger(fee.fee) || fee.fee < 0 || fee.fee > 1000) ||
      fees.reduce((sum, fee) => sum + fee.fee, 0) > 1000) {
    throw new Error('Invalid app fee configuration');
  }
  return fees;
}

async function readJson(request, maxBytes = MAX_BODY_BYTES, timeoutMs = MAX_TIMEOUT_MS) {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('Request too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Request body is missing');
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new Error('Request body timed out'));
    }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error('Request too large');
      body += decoder.decode(part.value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const value = JSON.parse(body);
  if (!record(value)) throw new Error('Invalid request');
  return value;
}

function quoteBody(value, fees) {
  const required = ['dry', 'swapType', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline'];
  const allowed = new Set([...required, 'appFees']);
  if (Object.keys(value).some(key => !allowed.has(key)) || required.some(key => !(key in value)) ||
      typeof value.dry !== 'boolean' || value.swapType !== 'EXACT_INPUT' || value.depositType !== 'ORIGIN_CHAIN' ||
      value.refundType !== 'ORIGIN_CHAIN' || value.recipientType !== 'DESTINATION_CHAIN' ||
      !Number.isSafeInteger(value.slippageTolerance) || value.slippageTolerance < 0 || value.slippageTolerance > 5000 ||
      !boundedString(value.originAsset, 256) || !boundedString(value.destinationAsset, 256) ||
      typeof value.amount !== 'string' || !/^[0-9]{1,78}$/.test(value.amount) || BigInt(value.amount) <= 0n ||
      !boundedString(value.refundTo, 256) || !boundedString(value.recipient, 256) || !validDeadline(value.deadline)) {
    throw new Error('Invalid quote request');
  }
  if (value.appFees !== undefined && JSON.stringify(value.appFees) !== JSON.stringify(fees)) throw new Error('App fees differ from service configuration');
  return { ...value, ...(fees.length ? { appFees: fees } : {}) };
}

function boundedString(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value);
}

function validDeadline(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now() && Date.parse(value) <= Date.now() + 86_400_000;
}

async function upstreamFetch(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, MAX_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual', cache: 'no-store' });
    if (response.status >= 300 && response.status < 400 || !response.body) throw new Error('Upstream unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Upstream response too large');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    if (!response.ok) return json({ error: 'upstream_request_failed' }, response.status >= 400 && response.status < 500 ? response.status : 502);
    JSON.parse(text);
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function upstreamUrl(path, params = new URLSearchParams()) {
  const url = new URL(path, UPSTREAM);
  url.search = params.toString();
  return url;
}

function allowedOrigin(request, origins) {
  const origin = request.headers.get('Origin');
  return origin !== null && origins.has(origin) ? origin : null;
}

function cors(origin, requestHeaders = 'content-type') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': requestHeaders,
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  };
}

export function createService({ fetchImpl = fetch, timeoutMs = MAX_TIMEOUT_MS } = {}) {
  return {
    async fetch(request, env) {
      let origins;
      let fees;
      try {
        origins = validOrigins(env);
        fees = validFees(env);
      } catch {
        return json({ error: 'service_unavailable' }, 503);
      }
      const origin = allowedOrigin(request, origins);
      if (!origin) return json({ error: 'origin_not_allowed' }, 403);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin, 'content-type') });
      if (!env.ONE_CLICK_PARTNER_KEY || env.ONE_CLICK_PARTNER_KEY.length > 512) return json({ error: 'service_unavailable' }, 503, cors(origin));
      const url = new URL(request.url);
      const authHeaders = { Authorization: `Bearer ${env.ONE_CLICK_PARTNER_KEY}`, Accept: 'application/json' };
      let response;
      try {
        if (url.pathname === '/v0/tokens' && request.method === 'GET' && url.search === '') {
          response = await upstreamFetch(fetchImpl, upstreamUrl('/v0/tokens'), { method: 'GET', headers: authHeaders }, timeoutMs);
        } else if (url.pathname === '/v0/quote' && request.method === 'POST' && url.search === '') {
          let body;
          try {
            body = quoteBody(await readJson(request, MAX_BODY_BYTES, timeoutMs), fees);
          } catch {
            return json({ error: 'invalid_quote_request' }, 400, cors(origin));
          }
          response = await upstreamFetch(fetchImpl, upstreamUrl('/v0/quote'), {
            method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
          }, timeoutMs);
        } else if (url.pathname === '/v0/status' && request.method === 'GET' && [...url.searchParams.keys()].every(key => key === 'depositAddress' || key === 'depositMemo')) {
          const address = url.searchParams.get('depositAddress');
          const memo = url.searchParams.get('depositMemo');
          if (!boundedString(address, 256) || (memo !== null && !boundedString(memo, 256))) return json({ error: 'invalid_status_request' }, 400, cors(origin));
          response = await upstreamFetch(fetchImpl, upstreamUrl('/v0/status', new URLSearchParams({ depositAddress: address, ...(memo === null ? {} : { depositMemo: memo }) })), { method: 'GET', headers: authHeaders }, timeoutMs);
        } else if (url.pathname === '/v0/deposit/submit' && request.method === 'POST' && url.search === '') {
          let body;
          try {
            body = await readJson(request, MAX_BODY_BYTES, timeoutMs);
          } catch {
            return json({ error: 'invalid_deposit_submission' }, 400, cors(origin));
          }
          if (Object.keys(body).some(key => !['depositAddress', 'txHash', 'memo'].includes(key)) || !boundedString(body.depositAddress, 256) ||
              typeof body.txHash !== 'string' || !HASH.test(body.txHash) || (body.memo !== undefined && !boundedString(body.memo, 256))) {
            return json({ error: 'invalid_deposit_submission' }, 400, cors(origin));
          }
          response = await upstreamFetch(fetchImpl, upstreamUrl('/v0/deposit/submit'), {
            method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
          }, timeoutMs);
        } else if (url.pathname === '/v1/receipts/resolve' && request.method === 'POST' && url.search === '') {
          response = await resolveReceipts(request, env, fetchImpl, timeoutMs);
        } else {
          return json({ error: 'not_found' }, 404, cors(origin));
        }
      } catch {
        return json({ error: 'upstream_unavailable' }, 502, cors(origin));
      }
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors(origin))) headers.set(key, value);
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    }
  };
}

async function resolveReceipts(request, env, fetchImpl, timeoutMs) {
  if (!env.MIDEN_RECEIPT_ADAPTER_URL) return json({ error: 'receipt_adapter_not_configured' }, 503);
  let adapter;
  try {
    adapter = new URL(env.MIDEN_RECEIPT_ADAPTER_URL);
  } catch {
    return json({ error: 'service_unavailable' }, 503);
  }
  if (adapter.protocol !== 'https:' || adapter.username || adapter.password || adapter.search || adapter.hash) return json({ error: 'service_unavailable' }, 503);
  let body;
  try {
    body = await readJson(request, MAX_BODY_BYTES, timeoutMs);
  } catch {
    return json({ error: 'invalid_receipt_request' }, 400);
  }
  if (Object.keys(body).some(key => key !== 'transactionHashes') || !Array.isArray(body.transactionHashes) || body.transactionHashes.length < 1 ||
      body.transactionHashes.length > 20 || body.transactionHashes.some(hash => typeof hash !== 'string' || hash.length < 1 || hash.length > 256)) {
    return json({ error: 'invalid_receipt_request' }, 400);
  }
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...(env.MIDEN_RECEIPT_ADAPTER_TOKEN ? { Authorization: `Bearer ${env.MIDEN_RECEIPT_ADAPTER_TOKEN}` } : {}) };
  const response = await upstreamFetch(fetchImpl, adapter, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
  if (!response.ok) return response;
  const receipts = await response.json();
  if (!Array.isArray(receipts) || receipts.length > 20 || receipts.some(receipt => !record(receipt) ||
      typeof receipt.transactionHash !== 'string' || !body.transactionHashes.includes(receipt.transactionHash) ||
      !Array.isArray(receipt.noteIds) || receipt.noteIds.length > 64 || receipt.noteIds.some(id => typeof id !== 'string' || id.length < 1 || id.length > 256))) {
    return json({ error: 'invalid_receipt_response' }, 502);
  }
  return json(receipts);
}

export default { fetch: (request, env) => createService().fetch(request, env) };
