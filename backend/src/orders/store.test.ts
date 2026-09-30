import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { openDatabase, OrderStore } from './store.js';
import type { NewRelay } from '../relays/store.js';
import { EXECUTOR, MIDEN_ACCOUNT } from '../test/support.js';

const relayInput: NewRelay = { txHash: '0x1234', rawTransaction: '0xabcd', nonce: 7, sender: EXECUTOR };

function signedOrder(store: OrderStore, id = 'a'.repeat(32)) {
  store.createCheckout({ id, evmAddress: EXECUTOR, midenAccountHex: MIDEN_ACCOUNT, fiatAmount: '10' });
  store.transition(id, 'checkout', 'signed', { tokenAmount: '100' }, 'test');
  return id;
}

it('does not reserve a relay after the amount or order state changes', () => {
  const db = openDatabase(':memory:');
  try {
    const store = new OrderStore(db, Date.now);
    const id = signedOrder(store);
    assert.equal(store.reserveRelay(id, '99', relayInput), false);
    assert.equal(store.relays.get(id), null);
    store.transition(id, 'signed', 'cancelled', {}, 'test');
    assert.equal(store.reserveRelay(id, '100', relayInput), false);
    assert.equal(store.relays.get(id), null);
    assert.equal(store.get(id)?.state, 'cancelled');
  } finally {
    db.close();
  }
});

it('requires a parent order for every relay', () => {
  const db = openDatabase(':memory:');
  try {
    const store = new OrderStore(db, Date.now);
    assert.throws(() => store.relays.reserve('missing', relayInput), /FOREIGN KEY/);
    assert.equal(store.relays.get('missing'), null);
  } finally {
    db.close();
  }
});

it('rolls back the order result when the relay receipt write fails', () => {
  const db = openDatabase(':memory:');
  try {
    const store = new OrderStore(db, Date.now);
    const id = signedOrder(store);
    store.reserveRelay(id, '100', relayInput);
    const order = store.get(id);
    const relay = store.relays.get(id);
    db.exec(`CREATE TRIGGER reject_receipt BEFORE UPDATE ON relays
      BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END;`);
    assert.throws(() => store.completeRelay(id, relayInput.txHash, 'success', 'deposited', {}), /receipt write failed/);
    assert.deepEqual(store.get(id), order);
    assert.deepEqual(store.relays.get(id), relay);
    assert.equal(store.relays.nextNonce(EXECUTOR), 8);
  } finally {
    db.close();
  }
});

it('releases completed nonces, counts retries, and ignores an older receipt', () => {
  const db = openDatabase(':memory:');
  try {
    const store = new OrderStore(db, Date.now);
    const id = signedOrder(store);
    assert.ok(store.reserveRelay(id, '100', relayInput));
    assert.equal(store.relays.nextNonce('0x3333333333333333333333333333333333333333'), 0);
    assert.ok(store.completeRelay(id, relayInput.txHash, 'reverted', 'awaiting_signature', {}));
    assert.equal(store.relays.get(id)?.rawTransaction, null);
    assert.equal(store.relays.get(id)?.status, 'reverted');
    assert.equal(store.relays.nextNonce(EXECUTOR), 0);
    store.transition(id, 'awaiting_signature', 'signed', {}, 'test');
    assert.ok(store.reserveRelay(id, '100', { ...relayInput, txHash: '0x5678', nonce: 8 }));
    assert.equal(store.relays.get(id)?.attempts, 2);
    assert.equal(store.completeRelay(id, relayInput.txHash, 'success', 'deposited', {}), false);
    assert.equal(store.get(id)?.state, 'relay_sent');
    assert.equal(store.relays.get(id)?.status, 'pending');
    assert.ok(store.completeRelay(id, '0x5678', 'success', 'deposited', {}));
    assert.equal(store.relays.get(id)?.rawTransaction, null);
    assert.equal(store.relays.get(id)?.txHash, '0x5678');
    assert.equal(store.relays.get(id)?.status, 'success');
    assert.equal(store.completeRelay(id, '0x5678', 'success', 'deposited', {}), false);
  } finally {
    db.close();
  }
});

it('retains orders, relay bytes and reserved nonces after reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-orders-'));
  const path = join(directory, 'orders.sqlite');
  let db = openDatabase(path);
  try {
    const oldStore = new OrderStore(db, Date.now);
    const order = oldStore.createCheckout({
      id: 'a'.repeat(32),
      evmAddress: EXECUTOR,
      midenAccountHex: MIDEN_ACCOUNT,
      fiatAmount: '10'
    });
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    assert.ok(row);
    assert.equal(Object.hasOwn(row, 'token_address'), false);
    assert.equal(Object.hasOwn(row, 'token_decimals'), false);
    assert.equal(
      Object.keys(row).some(key => key.startsWith('relay_')),
      false
    );
    assert.equal(oldStore.relays.get(order.id), null);
    db.close();
    db = openDatabase(path);
    const reopenedStore = new OrderStore(db, Date.now);
    assert.deepEqual(reopenedStore.get(order.id), order);
    reopenedStore.transition(
      order.id,
      'checkout',
      'signed',
      {
        settledTokenAmount: '100',
        tokenAmount: '100'
      },
      'test'
    );
    assert.ok(
      reopenedStore.reserveRelay(order.id, '100', {
        txHash: `0x${'ab'.repeat(32)}`,
        rawTransaction: '0x1234',
        nonce: 7,
        sender: EXECUTOR
      })
    );
    db.close();
    db = openDatabase(path);
    const reopened = new OrderStore(db, Date.now);
    assert.equal(reopened.relays.get(order.id)?.rawTransaction, '0x1234');
    assert.equal(reopened.relays.nextNonce(EXECUTOR), 8);
    assert.equal(reopened.get(order.id)?.settledTokenAmount, '100');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
