import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { decodeFunctionData, type Hex } from 'viem';
import { z } from 'zod';

import {
  advanceOrder,
  CHECKOUT_TIMEOUT_MS,
  MAX_RELAY_ATTEMPTS,
  RECEIPT_WARNING_MS,
  SIGNATURE_TIMEOUT_MS,
  UNDERDELIVERY_GRACE_MS,
  type OrderDeps
} from './advance.js';
import type { OrderState } from './states.js';
import { OrderConflictError, type Order, type OrderStore } from './store.js';
import { createWorker } from './worker.js';
import { CALIBUR_ABI } from '../chain-testnet/calibur.js';
import { batchNonceOf } from '../chain-testnet/preparation.js';
import {
  CALIBUR_SALT,
  captureLogs,
  FakeChain,
  FakeTransakOrders,
  memoryStore,
  MIDEN_ACCOUNT,
  TOKEN
} from '../test/support.js';
import { TransakError } from '../transak/client.js';

const BUYER = '0x1111111111111111111111111111111111111111';
const ONE = 10n ** 18n;
const AUTHORIZATION = JSON.stringify({
  address: '0x00000cAbFc76478C1537dd418aB00967cBbE4AE6',
  chainId: 11155111,
  nonce: 0,
  r: `0x${'aa'.repeat(32)}`,
  s: `0x${'bb'.repeat(32)}`,
  yParity: 1
});
const SIGNATURE: Hex = `0x${'cd'.repeat(65)}`;

let now: number;
let store: OrderStore;
let chain: FakeChain;
let transak: FakeTransakOrders;
let deps: OrderDeps;
let logs: string[];
let counter = 0;

beforeEach(() => {
  now = 1_800_000_000_000;
  logs = captureLogs();
  store = memoryStore(() => now);
  chain = new FakeChain();
  transak = new FakeTransakOrders();
  deps = {
    store,
    transak,
    chain,
    now: () => now,
    receiptWarnings: new Set(),
    loggedCryptoAmounts: new Map(),
    // An interval of 0 calls Transak on each step. The slow-poll tests set a longer interval.
    transakPoll: { intervalMs: 0, lastCallAt: new Map(), dirty: new Set() }
  };
});

/** A feed that records each `retain` call. */
class FakeFeed {
  retained: string[][] = [];

  retain(orderIds: readonly string[]): void {
    this.retained.push([...orderIds]);
  }
}

function workerOptions(feed: FakeFeed = new FakeFeed()) {
  return {
    store,
    transak,
    chain,
    feed,
    now: () => now,
    intervalMs: 60_000,
    transakPollIntervalMs: 60_000
  };
}

function newId(): string {
  counter += 1;
  return counter.toString(16).padStart(32, '0');
}

function current(id: string): Order {
  const order = store.get(id);
  assert.ok(order);
  return order;
}

async function step(id: string): Promise<Order> {
  await advanceOrder(current(id), deps);
  return current(id);
}

function checkout(evmAddress: `0x${string}` = BUYER): string {
  const id = newId();
  store.createCheckout({
    id,
    evmAddress,
    midenAccountHex: MIDEN_ACCOUNT,
    fiatAmount: '10',
    tokenAddress: TOKEN,
    tokenDecimals: 18
  });
  return id;
}

function awaiting(tokenAmount: bigint = 10n * ONE): string {
  const id = checkout();
  assert.ok(store.transition(id, 'checkout', 'awaiting_signature', { tokenAmount: tokenAmount.toString() }, 'test'));
  return id;
}

function signed(tokenAmount: bigint = 10n * ONE): string {
  const id = awaiting(tokenAmount);
  assert.ok(
    store.transition(
      id,
      'awaiting_signature',
      'signed',
      {
        batchNonce: batchNonceOf(0n).toString(),
        salt: CALIBUR_SALT,
        deadline: Math.floor(now / 1000) + 86_400,
        signature: SIGNATURE,
        authorization: AUTHORIZATION
      },
      'test'
    )
  );
  return id;
}

async function relaySent(): Promise<{ id: string; hash: Hex }> {
  const id = signed();
  chain.account.balance = 10n * ONE;
  const order = await step(id);
  assert.equal(order.state, 'relay_sent');
  assert.ok(order.relayTxHash);
  return { id, hash: order.relayTxHash };
}

function assertState(order: Order, state: OrderState): void {
  assert.equal(order.state, state);
}

const logEntrySchema = z.object({
  event: z.string(),
  orderId: z.string().optional(),
  from: z.string().nullable().optional(),
  to: z.string().optional(),
  type4: z.boolean().optional(),
  error: z.string().optional(),
  detail: z.string().optional()
});

function entries(event: string): Array<z.infer<typeof logEntrySchema>> {
  return logs.map(line => logEntrySchema.parse(JSON.parse(line))).filter(entry => entry.event === event);
}

function transitions(): string[] {
  return entries('order_transition').map(entry => `${entry.from}->${entry.to}`);
}

describe('createCheckout', () => {
  it('cancels an earlier open order of the same address', () => {
    const first = awaiting();
    const second = checkout();
    assertState(current(first), 'cancelled');
    assertState(current(second), 'checkout');
    assert.deepEqual(transitions(), ['checkout->awaiting_signature', 'awaiting_signature->cancelled']);
  });

  it('refuses a new order while a relay is in flight, and keeps the old order', async () => {
    const { id } = await relaySent();
    assert.throws(() => checkout(), OrderConflictError);
    assertState(current(id), 'relay_sent');
  });

  it('keeps orders of other addresses', () => {
    const first = checkout('0x3333333333333333333333333333333333333333');
    checkout();
    assertState(current(first), 'checkout');
  });
});

describe('checkout', () => {
  it('waits for a Transak order and expires after 1 h without one', async () => {
    const id = checkout();
    assertState(await step(id), 'checkout');
    now += CHECKOUT_TIMEOUT_MS + 1;
    assertState(await step(id), 'expired');
  });

  it('stores the Transak status and waits during payment', async () => {
    const id = checkout();
    transak.set(id, 'AWAITING_PAYMENT_FROM_USER', 10);
    const order = await step(id);
    assertState(order, 'checkout');
    assert.equal(order.transakStatus, 'AWAITING_PAYMENT_FROM_USER');
    assert.equal(order.transakOrderId, `transak-${id}`);
    assert.equal(entries('transak_status').length, 1);
  });

  it('moves to awaiting_signature with the crypto amount at PROCESSING', async () => {
    const id = checkout();
    transak.set(id, 'PROCESSING', 9.87);
    const order = await step(id);
    assertState(order, 'awaiting_signature');
    assert.equal(order.tokenAmount, ((987n * ONE) / 100n).toString());
  });

  it('logs each new crypto amount, also when the status stays the same', async () => {
    const id = checkout();
    transak.set(id, 'PROCESSING', 9.87);
    await step(id);
    transak.set(id, 'PROCESSING', 9.85);
    await step(id);
    await step(id);
    const amounts = logs
      .map(line => z.object({ event: z.string(), cryptoAmount: z.number().nullable().optional() }).parse(JSON.parse(line)))
      .filter(entry => entry.event === 'transak_crypto_amount')
      .map(entry => entry.cryptoAmount);
    assert.deepEqual(amounts, [9.87, 9.85]);
    assert.equal(entries('order_token_amount').length, 1);
  });

  it('waits when PROCESSING has no amount yet', async () => {
    const id = checkout();
    transak.set(id, 'PROCESSING', null);
    assertState(await step(id), 'checkout');
  });

  it('fails when Transak fails the order', async () => {
    const id = checkout();
    transak.set(id, 'CANCELLED', null);
    const order = await step(id);
    assertState(order, 'failed');
    assert.equal(order.error, 'Transak order CANCELLED');
  });
});

describe('awaiting_signature', () => {
  it('fails on a Transak refund', async () => {
    const id = awaiting();
    transak.set(id, 'REFUNDED', 10);
    assertState(await step(id), 'failed');
  });

  it('expires after 24 h without a signature', async () => {
    const id = awaiting();
    transak.set(id, 'PROCESSING', 10);
    now += SIGNATURE_TIMEOUT_MS - 1;
    assertState(await step(id), 'awaiting_signature');
    now += 2;
    assertState(await step(id), 'expired');
  });

  it('uses the balance when Transak delivered less, 10 min after COMPLETED', async () => {
    const id = awaiting();
    transak.set(id, 'COMPLETED', 10);
    chain.account.balance = 9n * ONE;
    assert.equal((await step(id)).tokenAmount, (10n * ONE).toString());
    now += UNDERDELIVERY_GRACE_MS;
    const order = await step(id);
    assertState(order, 'awaiting_signature');
    assert.equal(order.tokenAmount, (9n * ONE).toString());
  });
});

describe('signed', () => {
  it('waits while the funds are not on the address', async () => {
    const id = signed();
    transak.set(id, 'PROCESSING', 10);
    assertState(await step(id), 'signed');
    assert.equal(chain.sent.length, 0);
  });

  it('sends a type-4 relay with the stored batch and authorization', async () => {
    const id = signed();
    chain.account.balance = 10n * ONE;
    const order = await step(id);
    assertState(order, 'relay_sent');
    assert.equal(order.relayAttempts, 1);
    const sent = chain.sent[0];
    assert.ok(sent);
    assert.equal(sent.to, BUYER);
    assert.equal(sent.authorization?.nonce, 0);
    const decoded = decodeFunctionData({ abi: CALIBUR_ABI, data: sent.data });
    assert.equal(decoded.functionName, 'execute');
    assert.equal(entries('relay_sent')[0]?.type4, true);
    assert.equal(JSON.stringify(logs).includes(SIGNATURE.slice(2)), false);
  });

  it('sends with no authorization when the address is already delegated', async () => {
    const id = signed();
    chain.account = { ...chain.account, balance: 10n * ONE, needsAuthorization: false, authorizationNonce: 1 };
    assertState(await step(id), 'relay_sent');
    assert.equal(chain.sent[0]?.authorization, null);
  });

  it('goes back to awaiting_signature on a stale batch nonce or authorization nonce', async () => {
    const id = signed();
    chain.account = { ...chain.account, balance: 10n * ONE, sequence: 1n };
    const order = await step(id);
    assertState(order, 'awaiting_signature');
    assert.equal(order.signature, null);
    assert.equal(order.batchNonce, null);

    const other = signed();
    chain.account = { ...chain.account, sequence: 0n, authorizationNonce: 5 };
    assertState(await step(other), 'awaiting_signature');
    assert.equal(chain.sent.length, 0);
  });

  it('goes back to awaiting_signature when the deadline is near', async () => {
    const id = signed();
    chain.account.balance = 10n * ONE;
    now += 86_400_000;
    assertState(await step(id), 'awaiting_signature');
  });

  it('keeps the state when the send fails, so the next tick tries again', async () => {
    const id = signed();
    chain.account.balance = 10n * ONE;
    chain.failSend = true;
    await assert.rejects(advanceOrder(current(id), deps));
    assertState(current(id), 'signed');
  });

  it('re-signs a lower amount when Transak delivered less, 10 min after COMPLETED', async () => {
    const id = signed();
    transak.set(id, 'COMPLETED', 10);
    chain.account.balance = 9n * ONE;
    assertState(await step(id), 'signed');
    now += UNDERDELIVERY_GRACE_MS;
    const order = await step(id);
    assertState(order, 'awaiting_signature');
    assert.equal(order.tokenAmount, (9n * ONE).toString());
    assert.equal(order.signature, null);
  });

  it('fails on a Transak failure when the funds are not there', async () => {
    const id = signed();
    transak.set(id, 'FAILED', null);
    assertState(await step(id), 'failed');
  });
});

describe('relay_sent', () => {
  it('waits for the receipt, and warns once after 15 min', async () => {
    const { id } = await relaySent();
    assertState(await step(id), 'relay_sent');
    now += RECEIPT_WARNING_MS + 1;
    await step(id);
    await step(id);
    assert.equal(entries('relay_receipt_missing').length, 1);
  });

  it('moves to deposited on success, removes the signature, and stops there', async () => {
    const { id, hash } = await relaySent();
    chain.receipts.set(hash, 'success');
    const order = await step(id);
    assertState(order, 'deposited');
    assert.equal(order.signature, null);
    assert.equal(order.authorization, null);
    assert.equal(order.relayTxHash, hash);
    assert.equal(
      store.listForWorker().some(active => active.id === id),
      false
    );
    const calls = transak.calls.length;
    assertState(await step(id), 'deposited');
    assert.equal(transak.calls.length, calls);
  });

  it('goes back to awaiting_signature on a revert, and fails after 3 attempts', async () => {
    const { id, hash } = await relaySent();
    chain.receipts.set(hash, 'reverted');
    let order = await step(id);
    assertState(order, 'awaiting_signature');
    assert.equal(order.error, 'Relay reverted');

    for (let attempt = 2; attempt <= MAX_RELAY_ATTEMPTS; attempt += 1) {
      assert.ok(
        store.transition(
          id,
          'awaiting_signature',
          'signed',
          {
            batchNonce: batchNonceOf(0n).toString(),
            salt: CALIBUR_SALT,
            deadline: Math.floor(now / 1000) + 86_400,
            signature: SIGNATURE,
            authorization: AUTHORIZATION
          },
          'test'
        )
      );
      order = await step(id);
      assertState(order, 'relay_sent');
      assert.equal(order.relayAttempts, attempt);
      assert.ok(order.relayTxHash);
      chain.receipts.set(order.relayTxHash, 'reverted');
      order = await step(id);
    }
    assertState(order, 'failed');
  });
});

describe('slow Transak poll', () => {
  const INTERVAL = 60_000;

  beforeEach(() => {
    deps.transakPoll.intervalMs = INTERVAL;
  });

  it('calls Transak on the first step, skips it in the interval, and calls it again after the interval', async () => {
    const id = checkout();
    assertState(await step(id), 'checkout');
    assert.deepEqual(transak.calls, [id]);

    transak.set(id, 'PROCESSING', 10);
    now += INTERVAL - 1;
    assertState(await step(id), 'checkout');
    assert.equal(transak.calls.length, 1);

    now += 1;
    assertState(await step(id), 'awaiting_signature');
    assert.equal(transak.calls.length, 2);
  });

  it('calls Transak at once when a feed event marked the order dirty', async () => {
    const id = checkout();
    await step(id);
    transak.set(id, 'PROCESSING', 10);
    deps.transakPoll.dirty.add(id);
    assertState(await step(id), 'awaiting_signature');
    assert.equal(transak.calls.length, 2);
    assert.equal(deps.transakPoll.dirty.has(id), false);
  });

  it('does not expire a checkout on a skipped call, and expires it on the next call', async () => {
    const id = checkout();
    await step(id);
    now += CHECKOUT_TIMEOUT_MS - INTERVAL / 2;
    await step(id);
    now += INTERVAL / 2 + 1;
    assertState(await step(id), 'checkout');
    assert.equal(transak.calls.length, 2);
    now += INTERVAL / 2;
    assertState(await step(id), 'expired');
  });

  it('sends the relay in signed when the Transak call is skipped', async () => {
    const id = signed();
    transak.set(id, 'PROCESSING', 10);
    assertState(await step(id), 'signed');
    chain.account.balance = 10n * ONE;
    assertState(await step(id), 'relay_sent');
    assert.equal(transak.calls.length, 1);
  });

  it('uses the stored Transak status when the call is skipped', async () => {
    const id = signed();
    transak.set(id, 'PROCESSING', 10);
    await step(id);
    // Transak says FAILED now, but the call is skipped: the stored status PROCESSING stays in use.
    transak.set(id, 'FAILED', null);
    assertState(await step(id), 'signed');
    assert.ok(store.update(id, 'signed', { transakStatus: 'FAILED' }));
    const order = await step(id);
    assertState(order, 'failed');
    assert.equal(order.error, 'Transak order FAILED');
    assert.equal(transak.calls.length, 1);

    const waiting = awaiting();
    transak.set(waiting, 'PROCESSING', 10);
    await step(waiting);
    assert.ok(store.update(waiting, 'awaiting_signature', { transakStatus: 'REFUNDED' }));
    assertState(await step(waiting), 'failed');
    assert.equal(transak.calls.length, 2);
  });

  it('uses the stored COMPLETED time for underdelivery when the call is skipped', async () => {
    const id = signed();
    transak.set(id, 'COMPLETED', 10);
    chain.account.balance = 9n * ONE;
    const first = await step(id);
    assert.equal(first.transakCompletedAt, now);
    now += UNDERDELIVERY_GRACE_MS;
    // The step is 10 min after the first call, so it calls Transak again. Hold the call off with a fresh time.
    deps.transakPoll.lastCallAt.set(id, now);
    const order = await step(id);
    assertState(order, 'awaiting_signature');
    assert.equal(order.tokenAmount, (9n * ONE).toString());
    assert.equal(transak.calls.length, 1);
  });
});

describe('worker', () => {
  it('gives the feed the orders that can still get a Transak update', async () => {
    const open = checkout('0x3333333333333333333333333333333333333333');
    const { id: inFlight } = await relaySent();
    const feed = new FakeFeed();
    const worker = createWorker(workerOptions(feed));
    try {
      await worker.tick();
    } finally {
      worker.stop();
    }
    assert.deepEqual(feed.retained[0], [open]);
    assert.equal(feed.retained[0]?.includes(inFlight), false);
  });

  it('logs the TransakError detail in worker_error', async () => {
    const id = checkout();
    const worker = createWorker({
      ...workerOptions(),
      transak: {
        getOrderByPartnerId: async () => {
          throw new TransakError('orders: HTTP 400: {"error":"bad filter"}');
        }
      }
    });
    try {
      await worker.tick();
    } finally {
      worker.stop();
    }
    const error = entries('worker_error')[0];
    assert.equal(error?.orderId, id);
    assert.equal(error?.error, 'TransakError: Transak request failed');
    assert.equal(error?.detail, 'orders: HTTP 400: {"error":"bad filter"}');
  });

  it('runs a trigger after the running tick, not at the same time', async () => {
    const first = checkout('0x3333333333333333333333333333333333333333');
    let release: () => void = () => {};
    transak.gate = new Promise(resolve => {
      release = resolve;
    });
    const worker = createWorker(workerOptions());
    try {
      const ticking = worker.tick();
      assert.deepEqual(transak.calls, [first]);
      // The tick read its order list already, so only the trigger can advance this new order.
      const second = checkout();
      transak.set(second, 'PROCESSING', 10);
      await worker.trigger(second);
      // The tick holds the Transak call of the first order, so the trigger did not start.
      assert.deepEqual(transak.calls, [first]);
      assertState(current(second), 'checkout');
      transak.gate = null;
      release();
      await ticking;
      // The tick ran the trigger when it was done.
      assert.deepEqual(transak.calls, [first, second]);
      assertState(current(second), 'awaiting_signature');
    } finally {
      worker.stop();
    }
  });

  it('advances only the triggered order, with a Transak call in the interval', async () => {
    const other = checkout('0x3333333333333333333333333333333333333333');
    const id = checkout();
    const worker = createWorker(workerOptions());
    try {
      await worker.tick();
      assert.deepEqual(transak.calls, [other, id]);
      transak.set(id, 'PROCESSING', 10);
      transak.set(other, 'PROCESSING', 10);
      await worker.trigger(id);
      // A tick in the interval does not call Transak for the other order.
      await worker.tick();
    } finally {
      worker.stop();
    }
    assert.deepEqual(transak.calls, [other, id, id]);
    assertState(current(id), 'awaiting_signature');
    assertState(current(other), 'checkout');
  });

  it('advances each order in one tick and logs an error without stopping', async () => {
    const failing = checkout('0x3333333333333333333333333333333333333333');
    const moving = signed();
    chain.account.balance = 10n * ONE;
    transak.fail = true;
    const worker = createWorker(workerOptions());
    try {
      await worker.tick();
    } finally {
      worker.stop();
    }
    assertState(current(failing), 'checkout');
    // The signed order also asks Transak first, so it fails this tick too. Only the error log is checked here.
    const errors = entries('worker_error');
    assert.equal(errors.length, 2);
    assert.deepEqual(
      errors.map(entry => entry.orderId),
      [failing, moving]
    );

    transak.fail = false;
    // A new worker has no poll state, so it calls Transak for each order once.
    const again = createWorker(workerOptions());
    try {
      await Promise.all([again.tick(), again.tick()]);
    } finally {
      again.stop();
    }
    assertState(current(moving), 'relay_sent');
    // The second tick started while the first ran, so it did nothing: one send only.
    assert.equal(chain.sent.length, 1);
  });
});
