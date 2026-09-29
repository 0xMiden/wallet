import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildWidgetParams, createTransakClient, TransakError, type FetchLike } from './transak.js';

interface RecordedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function headersOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers).entries());
}

function bodyOf(init: RequestInit): unknown {
  const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  return body;
}

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch stub that records calls and answers each Transak route. */
function stubFetch(options: { tokenExpiresAt: number; sessionStatus?: number }) {
  const calls: RecordedCall[] = [];
  let tokenCount = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: headersOf(init), body: bodyOf(init) });
    await new Promise(resolve => setImmediate(resolve));
    switch (true) {
      case url.endsWith('/partners/api/v2/refresh-token'):
        tokenCount += 1;
        return jsonResponse(200, { data: { accessToken: `token-${tokenCount}`, expiresAt: options.tokenExpiresAt } });
      case url.endsWith('/api/v2/auth/session') && options.sessionStatus !== undefined:
        return jsonResponse(options.sessionStatus, { error: { message: 'bad' } });
      case url.endsWith('/api/v2/auth/session'):
        return jsonResponse(200, { data: { widgetUrl: 'https://global-stg.transak.com?apiKey=k&sessionId=s' } });
      default:
        return jsonResponse(404, {});
    }
  };
  return { fetch, calls };
}

const USER_IP = '203.0.113.7';

const params = buildWidgetParams({
  referrerDomain: 'wallet.miden.xyz',
  walletAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  fiatAmount: '50.25',
  partnerOrderId: '00112233445566778899aabbccddeeff'
});

describe('createTransakClient', () => {
  it('sends the refresh request with the secret headers and apiKey body', async () => {
    const { fetch, calls } = stubFetch({ tokenExpiresAt: 10_000_000 });
    const client = createTransakClient({ apiKey: 'KEY', apiSecret: 'SECRET', env: 'staging', fetch, now: () => 0 });
    await client.createWidgetSession(params, USER_IP);

    const refresh = calls[0];
    assert.ok(refresh);
    assert.equal(refresh.url, 'https://api-stg.transak.com/partners/api/v2/refresh-token');
    assert.equal(refresh.method, 'POST');
    assert.deepEqual(refresh.headers, {
      'api-secret': 'SECRET',
      'x-api-key': 'KEY',
      'content-type': 'application/json',
      accept: 'application/json'
    });
    assert.deepEqual(refresh.body, { apiKey: 'KEY' });
  });

  it('sends the exact session body with the access token', async () => {
    const { fetch, calls } = stubFetch({ tokenExpiresAt: 10_000_000 });
    const client = createTransakClient({ apiKey: 'KEY', apiSecret: 'SECRET', env: 'production', fetch, now: () => 0 });
    const widgetUrl = await client.createWidgetSession(params, USER_IP);

    assert.equal(widgetUrl, 'https://global-stg.transak.com?apiKey=k&sessionId=s');
    const session = calls[1];
    assert.ok(session);
    assert.equal(session.url, 'https://api-gateway.transak.com/api/v2/auth/session');
    assert.equal(session.headers['access-token'], 'token-1');
    assert.equal(session.headers['x-api-key'], 'KEY');
    assert.equal(session.headers['x-user-ip'], '203.0.113.7');
    assert.equal(session.headers['api-secret'], undefined);
    assert.deepEqual(session.body, {
      widgetParams: {
        apiKey: 'KEY',
        referrerDomain: 'wallet.miden.xyz',
        walletAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        disableWalletAddressForm: true,
        fiatAmount: 50.25,
        fiatCurrency: 'USD',
        cryptoCurrencyCode: 'USDC',
        network: 'ethereum',
        productsAvailed: 'BUY',
        partnerOrderId: '00112233445566778899aabbccddeeff'
      }
    });
  });

  it('caches the token across sessions and shares one refresh between concurrent calls', async () => {
    const { fetch, calls } = stubFetch({ tokenExpiresAt: 10_000_000 });
    const client = createTransakClient({ apiKey: 'KEY', apiSecret: 'SECRET', env: 'staging', fetch, now: () => 0 });
    await Promise.all([client.createWidgetSession(params, USER_IP), client.createWidgetSession(params, USER_IP)]);
    await client.createWidgetSession(params, USER_IP);
    assert.equal(calls.filter(call => call.url.endsWith('/refresh-token')).length, 1);
  });

  it('refreshes when less than 5 min are left', async () => {
    let now = 0;
    const { fetch, calls } = stubFetch({ tokenExpiresAt: 1000 });
    const client = createTransakClient({ apiKey: 'KEY', apiSecret: 'SECRET', env: 'staging', fetch, now: () => now });
    await client.createWidgetSession(params, USER_IP);
    now = 699_000;
    await client.createWidgetSession(params, USER_IP);
    assert.equal(calls.filter(call => call.url.endsWith('/refresh-token')).length, 1);
    now = 701_000;
    await client.createWidgetSession(params, USER_IP);
    assert.equal(calls.filter(call => call.url.endsWith('/refresh-token')).length, 2);
  });

  it('throws TransakError on an upstream error', async () => {
    const { fetch } = stubFetch({ tokenExpiresAt: 10_000_000, sessionStatus: 500 });
    const client = createTransakClient({ apiKey: 'KEY', apiSecret: 'SECRET', env: 'staging', fetch, now: () => 0 });
    await assert.rejects(client.createWidgetSession(params, USER_IP), TransakError);
  });
});

describe('getOrderByPartnerId', () => {
  const PARTNER_ORDER_ID = '00112233445566778899aabbccddeeff';

  /** A fetch stub for the orders route. `statuses` gives the HTTP status of each orders call in turn. */
  function stubOrders(data: object[], statuses: number[] = []) {
    const calls: RecordedCall[] = [];
    let tokenCount = 0;
    let orderCalls = 0;
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method, headers: headersOf(init), body: bodyOf(init) });
      if (url.endsWith('/partners/api/v2/refresh-token')) {
        tokenCount += 1;
        return jsonResponse(200, { data: { accessToken: `token-${tokenCount}`, expiresAt: 10_000_000 } });
      }
      const status = statuses[orderCalls] ?? 200;
      orderCalls += 1;
      return status === 200 ? jsonResponse(200, { meta: { totalCount: data.length }, data }) : jsonResponse(status, {});
    };
    return { fetch, calls };
  }

  it('sends the filter with the access token and parses the matching order', async () => {
    const { fetch, calls } = stubOrders([
      { id: 'other', status: 'COMPLETED', partnerOrderId: 'x', cryptoAmount: 1 },
      {
        id: 'order-1',
        status: 'PROCESSING',
        partnerOrderId: PARTNER_ORDER_ID,
        cryptoAmount: 9.87,
        walletAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        fiatAmount: 10,
        extra: { nested: true }
      }
    ]);
    const client = createTransakClient({ apiKey: 'KEY', apiSecret: 'SECRET', env: 'staging', fetch, now: () => 0 });
    const order = await client.getOrderByPartnerId(PARTNER_ORDER_ID);

    assert.deepEqual(order, {
      id: 'order-1',
      status: 'PROCESSING',
      partnerOrderId: PARTNER_ORDER_ID,
      cryptoAmount: 9.87,
      walletAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      transactionHash: null
    });
    const request = calls[1];
    assert.ok(request);
    assert.equal(
      request.url,
      `https://api-stg.transak.com/partners/api/v2/orders?filter%5BpartnerOrderId%5D=${PARTNER_ORDER_ID}`
    );
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['access-token'], 'token-1');
    assert.equal(request.headers['x-api-key'], 'KEY');
    assert.equal(request.headers['api-secret'], undefined);
  });

  it('returns null when Transak has no order yet', async () => {
    const { fetch } = stubOrders([]);
    const client = createTransakClient({ apiKey: 'KEY', apiSecret: 'SECRET', env: 'staging', fetch, now: () => 0 });
    assert.equal(await client.getOrderByPartnerId(PARTNER_ORDER_ID), null);
  });

  it('drops the token after a 401, so the next call refreshes it', async () => {
    const { fetch, calls } = stubOrders([], [401, 200]);
    const client = createTransakClient({ apiKey: 'KEY', apiSecret: 'SECRET', env: 'staging', fetch, now: () => 0 });
    await assert.rejects(client.getOrderByPartnerId(PARTNER_ORDER_ID), TransakError);
    assert.equal(await client.getOrderByPartnerId(PARTNER_ORDER_ID), null);
    assert.equal(calls.filter(call => call.url.endsWith('/refresh-token')).length, 2);
  });
});
