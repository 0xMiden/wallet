import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { z } from 'zod';

import { createApp } from './app.js';
import { buyBatchTypedData, CALIBUR_SEPOLIA_ADDRESS, SEPOLIA_CHAIN_ID } from './chain-testnet/calibur.js';
import { batchInputOf } from './chain-testnet/preparation.js';
import type { OrderStore } from './orders/store.js';
import { captureLogs, CALIBUR_SALT, EXECUTOR, FakeChain, memoryStore, MIDEN_ACCOUNT, TOKEN } from './test/support.js';
import { TransakError, type TransakClient, type TransakOrder, type WidgetParamsMirror } from './transak/client.js';

const WIDGET_URL = 'https://global-stg.transak.com?apiKey=k&sessionId=s';
const MIDEN_UPPER = `0x${'0A'.repeat(15)}`;

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

  async getOrderByPartnerId(): Promise<TransakOrder | null> {
    return null;
  }
}

const challengeResponseSchema = z.object({
  nonce: z.string(),
  expiresAt: z.number(),
  message: z.string()
});

const errorResponseSchema = z.object({ error: z.string() });

const prepareSchema = z.object({
  chainId: z.number(),
  calibur: z.string(),
  evmAddress: z.string(),
  midenAccountHex: z.string(),
  executor: z.string(),
  batchNonce: z.string(),
  salt: z.custom<`0x${string}`>(value => typeof value === 'string' && value.startsWith('0x')),
  deadline: z.number(),
  needsAuthorization: z.boolean(),
  authorizationNonce: z.number(),
  tokenAmount: z.string()
});

const orderResponseSchema = z.object({
  id: z.string(),
  state: z.string(),
  transakStatus: z.string().nullable(),
  tokenAddress: z.string(),
  tokenDecimals: z.number(),
  tokenAmount: z.string().nullable(),
  relayTxHash: z.string().nullable(),
  error: z.string().nullable(),
  prepare: prepareSchema.nullable()
});

let server: Server;
let baseUrl: string;
let now = 1_767_225_600_000;
let transak: FakeTransak;
let orders: OrderStore;
let chain: FakeChain;
/** The order IDs that the app gave to `onOrderCreated`. */
let created: string[] = [];

async function post(path: string, body: object): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json: unknown = await response.json();
  return { status: response.status, body: json };
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`);
  const json: unknown = await response.json();
  return { status: response.status, body: json };
}

async function expectError(result: { status: number; body: unknown }, status: number): Promise<void> {
  assert.equal(result.status, status);
  errorResponseSchema.parse(result.body);
}

before(async () => {
  captureLogs();
  transak = new FakeTransak();
  orders = memoryStore(() => now);
  chain = new FakeChain();
  // One proxy object of each fake, so each test can swap the fake.
  const proxy: TransakClient = {
    createWidgetSession: (params, userIp) => transak.createWidgetSession(params, userIp),
    getOrderByPartnerId: () => transak.getOrderByPartnerId()
  };
  const app = createApp({
    config: {
      referrerDomain: 'wallet.miden.xyz',
      allowedOrigins: '*',
      trustedProxies: [],
      maxFiatAmountUsd: 1000
    },
    transak: proxy,
    // The tests call over loopback. Map it to a fixed public IP, as the real resolver does.
    resolveUserIp: async () => '203.0.113.7',
    orders: {
      get relays() {
        return orders.relays;
      },
      get: id => orders.get(id),
      createCheckout: input => orders.createCheckout(input),
      transition: (id, from, to, patch, reason, amount) => orders.transition(id, from, to, patch, reason, amount)
    },
    chain: {
      executor: EXECUTOR,
      readAccount: () => chain.readAccount(),
      readBalance: () => chain.readBalance(),
      prepareRelay: (transaction, nonce) => chain.prepareRelay(transaction, nonce),
      broadcastRelay: raw => chain.broadcastRelay(raw),
      getReceiptStatus: hash => chain.getReceiptStatus(hash)
    },
    now: () => now,
    onOrderCreated: orderId => {
      created.push(orderId);
    }
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
  orders = memoryStore(() => now);
  chain = new FakeChain();
  created = [];
});

describe('GET /health', () => {
  it('returns ok', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

describe('POST /transak/challenge', () => {
  it('returns a nonce, expiry and message for a checksummed address and a lower-case Miden account', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const result = await post('/transak/challenge', {
      evmAddress: account.address.toLowerCase(),
      fiatAmount: '50.5',
      midenAccountHex: MIDEN_UPPER
    });
    assert.equal(result.status, 200);
    const body = challengeResponseSchema.parse(result.body);
    assert.match(body.nonce, /^[0-9a-f]{32}$/);
    assert.equal(body.expiresAt, Math.floor(now / 1000) + 300);
    assert.equal(
      body.message,
      `Buy 50.5 USD of USDC on Ethereum to ${account.address} for Miden account ${MIDEN_ACCOUNT} via Transak. ` +
        `Nonce ${body.nonce}, expires ${new Date(body.expiresAt * 1000).toISOString()}.`
    );
  });

  it('refuses a bad address', async () => {
    await expectError(
      await post('/transak/challenge', { evmAddress: '0x1234', fiatAmount: '10', midenAccountHex: MIDEN_ACCOUNT }),
      400
    );
  });

  it('refuses a missing or bad Miden account', async () => {
    const evmAddress = privateKeyToAccount(generatePrivateKey()).address;
    await expectError(await post('/transak/challenge', { evmAddress, fiatAmount: '10' }), 400);
    for (const midenAccountHex of ['0x1234', `0x${'0a'.repeat(16)}`, `0x${'zz'.repeat(15)}`, '0a'.repeat(16)]) {
      await expectError(await post('/transak/challenge', { evmAddress, fiatAmount: '10', midenAccountHex }), 400);
    }
  });

  it('refuses a bad amount', async () => {
    const evmAddress = privateKeyToAccount(generatePrivateKey()).address;
    for (const fiatAmount of ['0', '0.00', '-1', '1.234', 'abc', '1e3', '']) {
      await expectError(
        await post('/transak/challenge', { evmAddress, fiatAmount, midenAccountHex: MIDEN_ACCOUNT }),
        400
      );
    }
    await expectError(
      await post('/transak/challenge', { evmAddress, fiatAmount: 10, midenAccountHex: MIDEN_ACCOUNT }),
      400
    );
  });

  it('refuses an amount over the maximum', async () => {
    const evmAddress = privateKeyToAccount(generatePrivateKey()).address;
    await expectError(
      await post('/transak/challenge', { evmAddress, fiatAmount: '1000.01', midenAccountHex: MIDEN_ACCOUNT }),
      400
    );
    const atMax = await post('/transak/challenge', { evmAddress, fiatAmount: '1000', midenAccountHex: MIDEN_ACCOUNT });
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
});

async function challenge(address: string, fiatAmount: string) {
  const result = await post('/transak/challenge', { evmAddress: address, fiatAmount, midenAccountHex: MIDEN_ACCOUNT });
  assert.equal(result.status, 200);
  return challengeResponseSchema.parse(result.body);
}

/** Open a checkout through the routes. Return the order ID. */
async function openCheckout(account: PrivateKeyAccount, fiatAmount = '10'): Promise<string> {
  const { nonce, message } = await challenge(account.address, fiatAmount);
  const result = await post('/transak/session', { nonce, signature: await account.signMessage({ message }) });
  assert.equal(result.status, 200);
  return nonce;
}

describe('POST /transak/session', () => {
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

  it('inserts a checkout order and cancels the earlier open order of the address', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const first = await openCheckout(account);
    const order = orders.get(first);
    assert.ok(order);
    assert.equal(order.state, 'checkout');
    assert.equal(order.evmAddress, account.address);
    assert.equal(order.midenAccountHex, MIDEN_ACCOUNT);
    assert.equal(order.fiatAmount, '10');
    assert.equal(Object.hasOwn(order, 'tokenAddress'), false);
    assert.equal(Object.hasOwn(order, 'tokenDecimals'), false);

    const second = await openCheckout(account, '20');
    assert.equal(orders.get(first)?.state, 'cancelled');
    assert.equal(orders.get(second)?.state, 'checkout');
    // The server watches the Transak feed of each new order and advances it at once.
    assert.deepEqual(created, [first, second]);
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
    assert.equal(orders.get(nonce), null);
    assert.deepEqual(created, []);
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

  it('maps a Transak failure to 502 with a generic message, and stores no order', async () => {
    transak.fail = true;
    const account = privateKeyToAccount(generatePrivateKey());
    const { nonce, message } = await challenge(account.address, '10');
    const result = await post('/transak/session', { nonce, signature: await account.signMessage({ message }) });
    await expectError(result, 502);
    assert.doesNotMatch(JSON.stringify(result.body), /upstream said no/);
    assert.equal(orders.get(nonce), null);
  });
});

/** Open a checkout and move it to `awaiting_signature` with 10 tokens. */
async function awaitingOrder(account: PrivateKeyAccount): Promise<string> {
  const id = await openCheckout(account);
  assert.ok(orders.transition(id, 'checkout', 'awaiting_signature', { tokenAmount: (10n ** 19n).toString() }, 'test'));
  return id;
}

async function readPrepare(id: string) {
  const result = await get(`/orders/${id}`);
  assert.equal(result.status, 200);
  const body = orderResponseSchema.parse(result.body);
  assert.ok(body.prepare);
  return body.prepare;
}

async function signedBody(
  signer: PrivateKeyAccount,
  owner: PrivateKeyAccount,
  id: string,
  authorizationSigner = signer
) {
  const prepare = await readPrepare(id);
  const signed = {
    tokenAmount: prepare.tokenAmount,
    batchNonce: prepare.batchNonce,
    salt: prepare.salt,
    deadline: prepare.deadline
  };
  const order = { evmAddress: owner.address, midenAccountHex: MIDEN_ACCOUNT };
  const signature = await signer.signTypedData(buyBatchTypedData(batchInputOf(order, signed, EXECUTOR)));
  const authorization = await authorizationSigner.signAuthorization({
    address: CALIBUR_SEPOLIA_ADDRESS,
    chainId: SEPOLIA_CHAIN_ID,
    nonce: prepare.authorizationNonce
  });
  return {
    ...signed,
    signature,
    authorization: {
      address: authorization.address,
      chainId: authorization.chainId,
      nonce: authorization.nonce,
      r: authorization.r,
      s: authorization.s,
      yParity: authorization.yParity
    }
  };
}

describe('GET /orders/:id', () => {
  it('returns 404 for an unknown or malformed ID', async () => {
    await expectError(await get(`/orders/${'ab'.repeat(16)}`), 404);
    await expectError(await get('/orders/nope'), 404);
  });

  it('returns the public status without prepare values in checkout', async () => {
    const id = await openCheckout(privateKeyToAccount(generatePrivateKey()));
    const result = await get(`/orders/${id}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      id,
      state: 'checkout',
      transakStatus: null,
      tokenAddress: TOKEN,
      tokenDecimals: 18,
      tokenAmount: null,
      relayTxHash: null,
      error: null,
      prepare: null
    });
  });

  it('returns the relay hash without exposing signed bytes', async () => {
    const id = await openCheckout(privateKeyToAccount(generatePrivateKey()));
    orders.transition(id, 'checkout', 'signed', { tokenAmount: '100' }, 'test');
    const txHash = '0x1234';
    assert.ok(
      orders.reserveRelay(id, '100', {
        txHash,
        rawTransaction: '0xabcd',
        sender: EXECUTOR,
        nonce: 7
      })
    );
    const response = await get(`/orders/${id}`);
    assert.equal(response.status, 200);
    assert.equal(orderResponseSchema.parse(response.body).relayTxHash, txHash);
    assert.doesNotMatch(JSON.stringify(response.body), /rawTransaction|raw_transaction|0xabcd/);
    assert.ok(orders.completeRelay(id, txHash, 'reverted', 'awaiting_signature', {}));
    assert.equal(orderResponseSchema.parse((await get(`/orders/${id}`)).body).relayTxHash, null);
  });

  it('returns fresh prepare values in awaiting_signature', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const id = await awaitingOrder(account);
    chain.account = { ...chain.account, sequence: 3n, authorizationNonce: 9 };
    const prepare = await readPrepare(id);
    assert.equal(prepare.chainId, 11155111);
    assert.equal(prepare.calibur, CALIBUR_SEPOLIA_ADDRESS);
    assert.equal(prepare.evmAddress, account.address);
    assert.equal(prepare.midenAccountHex, MIDEN_ACCOUNT);
    assert.equal(prepare.executor, EXECUTOR);
    assert.equal(prepare.salt, CALIBUR_SALT);
    assert.equal(prepare.deadline, Math.floor(now / 1000) + 86_400);
    assert.equal(prepare.needsAuthorization, true);
    assert.equal(prepare.authorizationNonce, 9);
    assert.equal(prepare.tokenAmount, (10n ** 19n).toString());
    assert.match(prepare.batchNonce, /^[0-9]+$/);
    assert.equal(BigInt(prepare.batchNonce) & ((1n << 64n) - 1n), 3n);
  });
});

describe('POST /orders/:id/signature', () => {
  it('rejects an amount changed while the signature request reads the chain', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const id = await awaitingOrder(account);
    const body = await signedBody(account, account, id);
    const readAccount = chain.readAccount.bind(chain);
    chain.readAccount = async () => {
      orders.update(id, 'awaiting_signature', { tokenAmount: (12n * 10n ** 18n).toString() });
      return readAccount();
    };
    await expectError(await post(`/orders/${id}/signature`, body), 409);
    assert.equal(orders.get(id)?.state, 'awaiting_signature');
    assert.equal(orders.get(id)?.signature, null);
  });

  it('accepts a valid batch signature and authorization, then refuses a second one with 409', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const id = await awaitingOrder(account);
    const body = await signedBody(account, account, id);
    const result = await post(`/orders/${id}/signature`, body);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { state: 'signed' });
    const order = orders.get(id);
    assert.ok(order);
    assert.equal(order.state, 'signed');
    assert.equal(order.signature, body.signature);
    assert.equal(order.batchNonce, body.batchNonce);
    assert.ok(order.authorization);

    await expectError(await post(`/orders/${id}/signature`, body), 409);
  });

  it('returns 409 before the order waits for a signature, and 404 for an unknown order', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const id = await awaitingOrder(account);
    const body = await signedBody(account, account, id);
    await expectError(await post(`/orders/${'cd'.repeat(16)}/signature`, body), 404);
    const early = await openCheckout(account);
    await expectError(await post(`/orders/${early}/signature`, body), 409);
  });

  it('refuses a changed echoed value with 400', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const id = await awaitingOrder(account);
    const body = await signedBody(account, account, id);
    await expectError(await post(`/orders/${id}/signature`, { ...body, tokenAmount: '1' }), 400);
    await expectError(await post(`/orders/${id}/signature`, { ...body, batchNonce: '1' }), 400);
    await expectError(await post(`/orders/${id}/signature`, { ...body, salt: `0x${'ee'.repeat(32)}` }), 400);
    await expectError(await post(`/orders/${id}/signature`, { ...body, deadline: 1 }), 400);
    chain.account = { ...chain.account, sequence: 1n };
    await expectError(await post(`/orders/${id}/signature`, body), 400);
    assert.equal(orders.get(id)?.state, 'awaiting_signature');
  });

  it('refuses a signature or an authorization from another key with 400', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const id = await awaitingOrder(account);
    await expectError(await post(`/orders/${id}/signature`, await signedBody(other, account, id, account)), 400);
    await expectError(await post(`/orders/${id}/signature`, await signedBody(account, account, id, other)), 400);
    const { authorization: _authorization, ...withoutAuthorization } = await signedBody(account, account, id);
    await expectError(await post(`/orders/${id}/signature`, withoutAuthorization), 400);
    await expectError(await post(`/orders/${id}/signature`, { signature: '0x1234' }), 400);
    assert.equal(orders.get(id)?.state, 'awaiting_signature');
  });
});
