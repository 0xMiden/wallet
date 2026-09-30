import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { openDatabase, OrderStore } from './store.js';
import { EXECUTOR, MIDEN_ACCOUNT } from '../test/support.js';

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
    db.close();
    db = openDatabase(path);
    const reopenedStore = new OrderStore(db, Date.now);
    assert.deepEqual(reopenedStore.get(order.id), order);
    assert.ok(
      reopenedStore.transition(
        order.id,
        'checkout',
        'relay_sent',
        {
          relayTxHash: `0x${'ab'.repeat(32)}`,
          relayRawTransaction: '0x1234',
          relayNonce: 7,
          relaySender: EXECUTOR,
          settledTokenAmount: '100',
          tokenAmount: '100'
        },
        'test'
      )
    );
    db.close();
    db = openDatabase(path);
    const reopened = new OrderStore(db, Date.now);
    assert.equal(reopened.get(order.id)?.relayRawTransaction, '0x1234');
    assert.equal(reopened.nextRelayNonce(EXECUTOR), 8);
    assert.equal(reopened.get(order.id)?.settledTokenAmount, '100');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
