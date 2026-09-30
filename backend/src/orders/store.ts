import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Address, Hex } from 'viem';
import { z } from 'zod';

import { NONCE_STATES, ORDER_STATES, WORKER_STATES, type OrderState } from './states.js';
import { logEvent } from '../log.js';
import { RELAY_SCHEMA, RelayStore, type NewRelay } from '../relays/store.js';

export interface Order {
  /** The Transak `partnerOrderId`, which is the challenge nonce. */
  id: string;
  evmAddress: Address;
  midenAccountHex: string;
  fiatAmount: string;
  transakOrderId: string | null;
  transakStatus: string | null;
  /** Unix ms of the first COMPLETED status from Transak. */
  transakCompletedAt: number | null;
  /** Token base units. */
  tokenAmount: string | null;
  batchNonce: string | null;
  salt: Hex | null;
  /** Unix seconds. */
  deadline: number | null;
  signature: Hex | null;
  /** The signed EIP-7702 authorization as JSON. */
  authorization: string | null;
  /** Last completed amount from Transak, before any balance adjustment. */
  settledTokenAmount: string | null;
  state: OrderState;
  error: string | null;
  /** Unix ms. */
  createdAt: number;
  updatedAt: number;
  stateChangedAt: number;
}

/** The fields that an update can change. The state changes only through `transition`. */
export interface OrderPatch {
  transakOrderId?: string | null;
  transakStatus?: string | null;
  transakCompletedAt?: number | null;
  tokenAmount?: string | null;
  batchNonce?: string | null;
  salt?: Hex | null;
  deadline?: number | null;
  signature?: Hex | null;
  authorization?: string | null;
  settledTokenAmount?: string | null;
  error?: string | null;
}

const PATCH_COLUMNS: { [K in keyof OrderPatch]-?: string } = {
  transakOrderId: 'transak_order_id',
  transakStatus: 'transak_status',
  transakCompletedAt: 'transak_completed_at',
  tokenAmount: 'token_amount',
  batchNonce: 'batch_nonce',
  salt: 'salt',
  deadline: 'deadline',
  signature: 'signature',
  authorization: 'authorization',
  settledTokenAmount: 'settled_token_amount',
  error: 'error'
};

function isPatchKey(key: string): key is keyof OrderPatch {
  return Object.hasOwn(PATCH_COLUMNS, key);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  evm_address TEXT NOT NULL,
  miden_account_hex TEXT NOT NULL,
  fiat_amount TEXT NOT NULL,
  transak_order_id TEXT,
  transak_status TEXT,
  transak_completed_at INTEGER,
  token_amount TEXT,
  batch_nonce TEXT,
  salt TEXT,
  deadline INTEGER,
  signature TEXT,
  authorization TEXT,
  settled_token_amount TEXT,
  state TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state_changed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_nonce_order_per_address
  ON orders (evm_address) WHERE state IN (${NONCE_STATES.map(state => `'${state}'`).join(', ')});
CREATE INDEX IF NOT EXISTS orders_by_state ON orders (state);
`;

const hexSchema = z.custom<Hex>(value => typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value));
const addressSchema = z.custom<Address>(value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value));
const integer = z.union([z.number(), z.bigint()]).transform(value => Number(value));

const rowSchema = z
  .object({
    id: z.string(),
    evm_address: addressSchema,
    miden_account_hex: z.string(),
    fiat_amount: z.string(),
    transak_order_id: z.string().nullable(),
    transak_status: z.string().nullable(),
    transak_completed_at: integer.nullable(),
    token_amount: z.string().nullable(),
    batch_nonce: z.string().nullable(),
    salt: hexSchema.nullable(),
    deadline: integer.nullable(),
    signature: hexSchema.nullable(),
    authorization: z.string().nullable(),
    settled_token_amount: z.string().nullable(),
    state: z.enum(ORDER_STATES),
    error: z.string().nullable(),
    created_at: integer,
    updated_at: integer,
    state_changed_at: integer
  })
  .transform(
    (row): Order => ({
      id: row.id,
      evmAddress: row.evm_address,
      midenAccountHex: row.miden_account_hex,
      fiatAmount: row.fiat_amount,
      transakOrderId: row.transak_order_id,
      transakStatus: row.transak_status,
      transakCompletedAt: row.transak_completed_at,
      tokenAmount: row.token_amount,
      batchNonce: row.batch_nonce,
      salt: row.salt,
      deadline: row.deadline,
      signature: row.signature,
      authorization: row.authorization,
      settledTokenAmount: row.settled_token_amount,
      state: row.state,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stateChangedAt: row.state_changed_at
    })
  );

/** Open the database file. Make the directory when it does not exist. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  db.exec(RELAY_SCHEMA);
  return db;
}

export interface NewOrder {
  id: string;
  evmAddress: Address;
  midenAccountHex: string;
  fiatAmount: string;
}

/** A different order of the same address holds the Calibur nonce, and it can not be cancelled now. */
export class OrderConflictError extends Error {
  constructor(readonly orderId: string) {
    super('An earlier buy is being relayed. Try again in a minute.');
    this.name = 'OrderConflictError';
  }
}

/** The states that a new checkout can cancel. A `relay_sent` order has a transaction in flight. */
const CANCELLABLE_STATES: readonly OrderState[] = ['checkout', 'awaiting_signature', 'signed'];

export class OrderStore {
  readonly relays: RelayStore;
  /** `now` returns the time in milliseconds. */
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number
  ) {
    this.relays = new RelayStore(db);
  }

  get(id: string): Order | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    return row === undefined ? null : rowSchema.parse(row);
  }

  /** The orders that the worker advances, oldest first. */
  listForWorker(): Order[] {
    const placeholders = WORKER_STATES.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM orders WHERE state IN (${placeholders}) ORDER BY created_at, id`)
      .all(...WORKER_STATES)
      .map(row => rowSchema.parse(row));
  }

  /**
   * Insert a `checkout` order. First cancel the other orders of the address that hold the nonce.
   * Both steps run in one SQL transaction.
   */
  createCheckout(input: NewOrder): Order {
    const at = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const placeholders = NONCE_STATES.map(() => '?').join(', ');
      const others = this.db
        .prepare(`SELECT * FROM orders WHERE evm_address = ? AND state IN (${placeholders})`)
        .all(input.evmAddress, ...NONCE_STATES)
        .map(row => rowSchema.parse(row));
      for (const other of others) {
        if (!CANCELLABLE_STATES.includes(other.state)) {
          throw new OrderConflictError(other.id);
        }
      }
      for (const other of others) {
        this.transition(other.id, other.state, 'cancelled', { signature: null, authorization: null }, 'new checkout');
      }
      this.db
        .prepare(
          `INSERT INTO orders (id, evm_address, miden_account_hex, fiat_amount,
             state, created_at, updated_at, state_changed_at)
           VALUES (?, ?, ?, ?, 'checkout', ?, ?, ?)`
        )
        .run(input.id, input.evmAddress, input.midenAccountHex, input.fiatAmount, at, at, at);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    logEvent('info', 'order_created', { orderId: input.id, to: 'checkout' });
    const created = this.get(input.id);
    if (created === null) {
      throw new Error(`Order ${input.id} is missing after insert`);
    }
    return created;
  }

  /** Save the relay before broadcast and change the order state in one transaction. */
  reserveRelay(id: string, expectedTokenAmount: string, relay: NewRelay): boolean {
    const changed = this.atomic(() => {
      if (!this.write(id, 'signed', 'relay_sent', { error: null }, expectedTokenAmount)) return false;
      this.relays.reserve(id, relay);
      return true;
    });
    this.logTransition(changed, id, 'signed', 'relay_sent', 'relay reserved');
    return changed;
  }

  /** Store the receipt and the order result together. Ignore receipts for an older attempt. */
  completeRelay(
    id: string,
    txHash: Hex,
    status: 'success' | 'reverted',
    to: 'deposited' | 'awaiting_signature' | 'failed',
    patch: OrderPatch
  ): boolean {
    const changed = this.atomic(() => {
      const relay = this.relays.get(id);
      if (relay === null || relay.txHash !== txHash || relay.status !== 'pending') return false;
      if (!this.write(id, 'relay_sent', to, patch)) return false;
      if (!this.relays.complete(id, txHash, status)) throw new Error('Relay changed during receipt update');
      return true;
    });
    this.logTransition(changed, id, 'relay_sent', to, `relay ${status}`);
    return changed;
  }

  private atomic(action: () => boolean): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = action();
      this.db.exec('COMMIT');
      return changed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Change fields but not the state. Return false when the order is not in `state` any more. */
  update(id: string, state: OrderState, patch: OrderPatch): boolean {
    return this.write(id, state, null, patch);
  }

  /**
   * Move the order from `from` to `to` and apply `patch`. The update has a guard on `from`,
   * so a second writer that saw an older state changes nothing. Return false in that case.
   */
  transition(
    id: string,
    from: OrderState,
    to: OrderState,
    patch: OrderPatch,
    reason: string,
    expectedTokenAmount?: string
  ): boolean {
    const changed = this.write(id, from, to, patch, expectedTokenAmount);
    this.logTransition(changed, id, from, to, reason);
    return changed;
  }

  private logTransition(changed: boolean, id: string, from: OrderState, to: OrderState, reason: string): void {
    if (changed) {
      logEvent(to === 'failed' ? 'warn' : 'info', 'order_transition', { orderId: id, from, to, reason });
    } else {
      logEvent('warn', 'order_transition_skipped', { orderId: id, from, to, reason });
    }
  }

  private write(
    id: string,
    from: OrderState,
    to: OrderState | null,
    patch: OrderPatch,
    expectedTokenAmount?: string
  ): boolean {
    const at = this.now();
    const sets: string[] = ['updated_at = ?'];
    const values: SQLInputValue[] = [at];
    if (to !== null) {
      sets.push('state = ?', 'state_changed_at = ?');
      values.push(to, at);
    }
    for (const key of Object.keys(patch)) {
      if (!isPatchKey(key)) {
        continue;
      }
      const value = patch[key];
      if (value === undefined) {
        continue;
      }
      sets.push(`${PATCH_COLUMNS[key]} = ?`);
      values.push(value);
    }
    values.push(id, from);
    let guard = '';
    if (expectedTokenAmount !== undefined) {
      guard = ' AND token_amount = ?';
      values.push(expectedTokenAmount);
    }
    const result = this.db
      .prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ? AND state = ?${guard}`)
      .run(...values);
    return Number(result.changes) === 1;
  }
}
