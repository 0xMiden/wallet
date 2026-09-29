import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Server } from 'node:http';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

import { createApp } from './index.js';
import { TransakError, type TransakClient, type WidgetParamsMirror } from './transak.js';

const WIDGET_URL = 'https://global-stg.transak.com?apiKey=k&sessionId=s';

/** A fake Transak client. It records each params object it gets. */
class FakeTransak implements TransakClient {
  received: WidgetParamsMirror[] = [];
  userIps: string[] = [];
  fail = false;

  async createWidgetSession(params: WidgetParamsMirror, userIp: string): Promise<string> {
    this.received.push(params);
    this.userIps.push(userIp);
    if (this.fail) {
      throw new TransakError('upstream said no');
    }
    return WIDGET_URL;
  }
}

const challengeResponseSchema = z.object({
  nonce: z.string(),
  expiresAt: z.number(),
  message: z.string()
});

const errorResponseSchema = z.object({ error: z.string() });

let server: Server;
let baseUrl: string;
let now = 1_767_225_600_000;
let transak: FakeTransak;

async function post(path: string, body: object): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json: unknown = await response.json();
  return { status: response.status, body: json };
}

async function expectError(result: { status: number; body: unknown }, status: number): Promise<void> {
  assert.equal(result.status, status);
  errorResponseSchema.parse(result.body);
}

before(async () => {
  transak = new FakeTransak();
  // One proxy object so each test can swap the fake.
  const proxy: TransakClient = {
    createWidgetSession: (params, userIp) => transak.createWidgetSession(params, userIp)
  };
  const app = createApp({
    config: { referrerDomain: 'wallet.miden.xyz', allowedOrigins: '*', maxFiatAmountUsd: 1000 },
    transak: proxy,
    // The tests call over loopback. Map it to a fixed public IP, as the real resolver does.
    resolveUserIp: async () => '203.0.113.7',
    now: () => now
  });
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address: AddressInfo | string | null = server.address();
  assert.ok(address !== null && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  transak = new FakeTransak();
  // Move the clock far forward so each test gets fresh rate-limit tokens.
  now += 3_600_000;
});

describe('GET /health', () => {
  it('returns ok', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

describe('POST /transak/challenge', () => {
  it('returns a nonce, expiry and message for a checksummed address', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const result = await post('/transak/challenge', {
      evmAddress: account.address.toLowerCase(),
      fiatAmount: '50.5'
    });
    assert.equal(result.status, 200);
    const body = challengeResponseSchema.parse(result.body);
    assert.match(body.nonce, /^[0-9a-f]{32}$/);
    assert.equal(body.expiresAt, Math.floor(now / 1000) + 300);
    assert.equal(
      body.message,
      `Buy 50.5 USD of USDC on Ethereum to ${account.address} via Transak. ` +
        `Nonce ${body.nonce}, expires ${new Date(body.expiresAt * 1000).toISOString()}.`
    );
  });

  it('refuses a bad address', async () => {
    await expectError(await post('/transak/challenge', { evmAddress: '0x1234', fiatAmount: '10' }), 400);
  });

  it('refuses a bad amount', async () => {
    const evmAddress = privateKeyToAccount(generatePrivateKey()).address;
    for (const fiatAmount of ['0', '0.00', '-1', '1.234', 'abc', '1e3', '']) {
      await expectError(await post('/transak/challenge', { evmAddress, fiatAmount }), 400);
    }
    await expectError(await post('/transak/challenge', { evmAddress, fiatAmount: 10 }), 400);
  });

  it('refuses an amount over the maximum', async () => {
    const evmAddress = privateKeyToAccount(generatePrivateKey()).address;
    await expectError(await post('/transak/challenge', { evmAddress, fiatAmount: '1000.01' }), 400);
    const atMax = await post('/transak/challenge', { evmAddress, fiatAmount: '1000' });
    assert.equal(atMax.status, 200);
  });

  it('refuses a body that is not valid JSON', async () => {
    const response = await fetch(`${baseUrl}/transak/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    });
    assert.equal(response.status, 400);
  });

  it('rate-limits one IP', async () => {
    const evmAddress = privateKeyToAccount(generatePrivateKey()).address;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await post('/transak/challenge', { evmAddress, fiatAmount: '10' })).status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
    assert.equal(statuses[10], 429);
  });
});

describe('POST /transak/session', () => {
  async function challenge(address: string, fiatAmount: string) {
    const result = await post('/transak/challenge', { evmAddress: address, fiatAmount });
    assert.equal(result.status, 200);
    return challengeResponseSchema.parse(result.body);
  }

  it('returns the widget URL and the exact params sent to Transak', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { nonce, message } = await challenge(account.address, '75.25');
    const signature = await account.signMessage({ message });

    const result = await post('/transak/session', { nonce, signature });
    assert.equal(result.status, 200);
    const expected: WidgetParamsMirror = {
      referrerDomain: 'wallet.miden.xyz',
      walletAddress: account.address,
      disableWalletAddressForm: true,
      fiatAmount: 75.25,
      fiatCurrency: 'USD',
      cryptoCurrencyCode: 'USDC',
      network: 'ethereum',
      productsAvailed: 'BUY',
      partnerOrderId: nonce
    };
    assert.deepEqual(result.body, { widgetUrl: WIDGET_URL, widgetParams: expected });
    assert.deepEqual(transak.received, [expected]);
    assert.deepEqual(transak.userIps, ['203.0.113.7']);
  });

  it('refuses a signature from another key and burns the nonce', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const { nonce, message } = await challenge(account.address, '10');

    await expectError(await post('/transak/session', { nonce, signature: await other.signMessage({ message }) }), 401);
    await expectError(
      await post('/transak/session', { nonce, signature: await account.signMessage({ message }) }),
      401
    );
    assert.equal(transak.received.length, 0);
  });

  it('refuses a reused nonce', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { nonce, message } = await challenge(account.address, '10');
    const signature = await account.signMessage({ message });

    assert.equal((await post('/transak/session', { nonce, signature })).status, 200);
    await expectError(await post('/transak/session', { nonce, signature }), 401);
    assert.equal(transak.received.length, 1);
  });

  it('refuses an expired nonce', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { nonce, message } = await challenge(account.address, '10');
    const signature = await account.signMessage({ message });
    now += 300_000;
    await expectError(await post('/transak/session', { nonce, signature }), 401);
  });

  it('refuses an unknown nonce and a bad body', async () => {
    const signature = await privateKeyToAccount(generatePrivateKey()).signMessage({ message: 'x' });
    await expectError(await post('/transak/session', { nonce: 'ab'.repeat(16), signature }), 401);
    await expectError(await post('/transak/session', { nonce: 'not-a-nonce', signature }), 400);
    await expectError(await post('/transak/session', { nonce: 'ab'.repeat(16), signature: 'nope' }), 400);
  });

  it('maps a Transak failure to 502 with a generic message', async () => {
    transak.fail = true;
    const account = privateKeyToAccount(generatePrivateKey());
    const { nonce, message } = await challenge(account.address, '10');
    const result = await post('/transak/session', { nonce, signature: await account.signMessage({ message }) });
    await expectError(result, 502);
    assert.doesNotMatch(JSON.stringify(result.body), /upstream said no/);
  });
});
