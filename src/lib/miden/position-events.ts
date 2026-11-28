import Dexie from 'dexie';

import type { TokenPriceInfo } from 'lib/prices/binance';
import {
  EMPTY_POSITION,
  openPosition,
  recordArrival,
  recordDeparture,
  type TrackedPosition
} from 'lib/prices/position-pnl';
import { USD_SCALE } from 'lib/prices/usd';

import { db, Table } from './repo';

/** The quote an arrival was priced with, as stored when its transaction completed. */
export interface PositionQuote {
  priceMicro: bigint;
  kind: 'market' | 'fixed';
  /** Retrieval time in milliseconds; a fixed quote has none. */
  observedAt?: number;
}

/**
 * What one completed transaction did to one token of one account, recorded on this device only.
 * `heldAfter` is the vault balance read right after the transaction, or null when it could not be read.
 */
export interface PositionEvent {
  /** `${txId}:${faucetId}`. */
  key: string;
  seq?: number;
  txId: string;
  accountId: string;
  network: string;
  /** Canonical bech32 faucet id. */
  faucetId: string;
  /** Milliseconds: the row's completion time. */
  eventAt: number;
  arrived: bigint;
  departed: bigint;
  heldAfter: bigint | null;
  decimals: number | null;
  quote: PositionQuote | null;
}

const events = () => db.table<PositionEvent, number>(Table.PositionEvents);

/** Writes one transaction's events once: a transaction that already has any is left as it is. */
export async function appendPositionEvents(txId: string, rows: readonly PositionEvent[]): Promise<boolean> {
  if (rows.length === 0) return false;
  const table = events();
  return db.transaction('rw', table, async () => {
    if ((await table.where('txId').equals(txId).count()) > 0) return false;
    await table.bulkAdd(rows.map(({ seq: _seq, ...row }) => row));
    return true;
  });
}

/** One token's events for one account and network, oldest first. */
export async function readPositionEvents(
  accountId: string,
  network: string,
  faucetId: string
): Promise<PositionEvent[]> {
  return events()
    .where('[accountId+network+faucetId+seq]')
    .between([accountId, network, faucetId, Dexie.minKey], [accountId, network, faucetId, Dexie.maxKey])
    .toArray();
}

/** When this device first recorded an event for the account on the network, in milliseconds. */
export async function readTrackingSince(accountId: string, network: string): Promise<number | undefined> {
  const row = await events()
    .where('[accountId+network+eventAt]')
    .between([accountId, network, Dexie.minKey], [accountId, network, Dexie.maxKey])
    .first();
  return row?.eventAt;
}

const toQuote = (quote: PositionQuote | null): TokenPriceInfo | undefined =>
  quote === null
    ? undefined
    : {
        price: Number(quote.priceMicro) / Number(USD_SCALE),
        change24h: 0,
        percentageChange24h: 0,
        kind: quote.kind,
        observedAt: quote.observedAt
      };

/**
 * The position the events leave. Each event that read the vault anchors it: when the balance before the event is not
 * what the earlier events leave (holdings from before tracking, another device, a completion this device did not
 * record), the position restarts there with a known quantity and an unknown cost. A balance of zero before the event
 * restarts it at a known zero, which is how an unknown cost ends once the holding is sold out.
 */
export function foldPositionEvents(rows: readonly PositionEvent[]): TrackedPosition {
  // Before the first anchor nothing says what was already held.
  let position: TrackedPosition = { quantity: 0n, costMicro: undefined };
  for (const row of rows) {
    if (row.heldAfter !== null) {
      const before = row.heldAfter - row.arrived + row.departed;
      if (before < 0n) {
        // The amounts disagree with the vault: keep its quantity, not their cost.
        position = openPosition(row.heldAfter);
        continue;
      }
      if (before === 0n || position.quantity !== before)
        position = before === 0n ? EMPTY_POSITION : openPosition(before);
    }
    position = recordArrival(position, {
      amount: row.arrived,
      eventAt: row.eventAt,
      quote: toQuote(row.quote),
      decimals: row.decimals ?? undefined
    });
    position = recordDeparture(position, row.departed);
  }
  return position;
}
