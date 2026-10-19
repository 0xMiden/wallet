import type { DatabaseSync } from 'node:sqlite';
import type { Address, Hex } from 'viem';
import { z } from 'zod';

export interface Relay {
  orderId: string;
  txHash: Hex;
  /** Keep signed bytes until a receipt is stored. Never return them through the API. */
  rawTransaction: Hex | null;
  nonce: number;
  sender: Address;
  attempts: number;
  status: 'pending' | 'success' | 'reverted';
}

export interface NewRelay {
  txHash: Hex;
  rawTransaction: Hex;
  nonce: number;
  sender: Address;
}

export const RELAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS relays (
  order_id TEXT PRIMARY KEY NOT NULL REFERENCES orders(id),
  tx_hash TEXT NOT NULL,
  raw_transaction TEXT,
  nonce INTEGER NOT NULL,
  sender TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'reverted'))
);
CREATE UNIQUE INDEX IF NOT EXISTS relays_pending_nonce
  ON relays (sender, nonce) WHERE status = 'pending';
`;

const hex = z.custom<Hex>(value => typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value));
const address = z.custom<Address>(value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value));
const rowSchema = z
  .object({
    order_id: z.string(),
    tx_hash: hex,
    raw_transaction: hex.nullable(),
    nonce: z.number().int(),
    sender: address,
    attempts: z.number().int().positive(),
    status: z.enum(['pending', 'success', 'reverted'])
  })
  .transform(
    (row): Relay => ({
      orderId: row.order_id,
      txHash: row.tx_hash,
      rawTransaction: row.raw_transaction,
      nonce: row.nonce,
      sender: row.sender,
      attempts: row.attempts,
      status: row.status
    })
  );

export class RelayStore {
  constructor(private readonly db: DatabaseSync) {}

  get(orderId: string): Relay | null {
    const row = this.db.prepare('SELECT * FROM relays WHERE order_id = ?').get(orderId);
    return row === undefined ? null : rowSchema.parse(row);
  }

  /** Include transactions that the RPC has not received yet. */
  nextNonce(sender: Address): number {
    const row = this.db
      .prepare("SELECT MAX(nonce) AS nonce FROM relays WHERE status = 'pending' AND sender = ?")
      .get(sender);
    const { nonce } = z.object({ nonce: z.number().nullable() }).parse(row);
    return nonce === null ? 0 : nonce + 1;
  }

  /** Call in the same transaction as the order state update. */
  reserve(orderId: string, relay: NewRelay): void {
    this.db
      .prepare(
        `INSERT INTO relays (order_id, tx_hash, raw_transaction, nonce, sender, attempts, status)
      VALUES (?, ?, ?, ?, ?, 1, 'pending')
      ON CONFLICT(order_id) DO UPDATE SET
        tx_hash = excluded.tx_hash, raw_transaction = excluded.raw_transaction,
        nonce = excluded.nonce, sender = excluded.sender, attempts = relays.attempts + 1, status = 'pending'`
      )
      .run(orderId, relay.txHash, relay.rawTransaction, relay.nonce, relay.sender);
  }

  /** Reject a stale receipt and remove signed bytes when the receipt is stored. */
  complete(orderId: string, txHash: Hex, status: 'success' | 'reverted'): boolean {
    const result = this.db
      .prepare(
        `UPDATE relays SET status = ?, raw_transaction = NULL
      WHERE order_id = ? AND tx_hash = ? AND status = 'pending'`
      )
      .run(status, orderId, txHash);
    return Number(result.changes) === 1;
  }
}
