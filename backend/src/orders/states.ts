/** A buy brings fiat in and bridges the bought token to Miden. A sell sends the released token to Transak. */
export type OrderSide = 'buy' | 'sell';

export const ORDER_SIDES: readonly [OrderSide, ...OrderSide[]] = ['buy', 'sell'];

export type OrderState =
  | 'checkout'
  | 'awaiting_signature'
  | 'signed'
  | 'relay_sent'
  | 'deposited'
  | 'failed'
  | 'expired'
  | 'cancelled';

export const ORDER_STATES: readonly [OrderState, ...OrderState[]] = [
  'checkout',
  'awaiting_signature',
  'signed',
  'relay_sent',
  'deposited',
  'failed',
  'expired',
  'cancelled'
];

/**
 * The worker advances orders in these states. The other states are terminal.
 * The relay job of the backend stops at `deposited`: the relay is mined. For a buy the deposit is in the bridge on
 * Sepolia and the wallet reads the Agglayer indexer for the claim on Miden. For a sell the token is at Transak's
 * deposit address and Transak pays the fiat out; the worker only reads the Transak status of that sell until the
 * status is final (see `isPayoutSync`).
 */
export const WORKER_STATES: readonly OrderState[] = ['checkout', 'awaiting_signature', 'signed', 'relay_sent'];

/** The worker watches the Transak feed for orders in these states. They can still get a Transak update. */
export const TRANSAK_FEED_STATES: readonly OrderState[] = ['checkout', 'awaiting_signature', 'signed'];

/** Transak does not change an order after one of these statuses. */
export const TRANSAK_FINAL_STATUSES: readonly string[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'];

/** The worker stops the status read of a `deposited` sell this long after the deposit, final status or not. */
export const SELL_PAYOUT_SYNC_MS = 7 * 24 * 60 * 60 * 1000;

/** The order fields that the worker rules read. */
export interface WorkerOrderFields {
  state: OrderState;
  side: OrderSide;
  transakStatus: string | null;
  /** Unix ms. */
  stateChangedAt: number;
}

/**
 * True for a `deposited` sell that Transak has not settled yet. The worker keeps the `transakStatus` of this order
 * fresh, so the wallet can show the payout (`PENDING_DELIVERY_FROM_TRANSAK`, then `COMPLETED`). The order state
 * does not change. `nowMs` is the time in milliseconds.
 */
export function isPayoutSync(order: WorkerOrderFields, nowMs: number): boolean {
  return (
    order.state === 'deposited' &&
    order.side === 'sell' &&
    (order.transakStatus === null || !TRANSAK_FINAL_STATUSES.includes(order.transakStatus)) &&
    nowMs - order.stateChangedAt < SELL_PAYOUT_SYNC_MS
  );
}

/** True when the worker has work for the order: a state step, or the payout status read of a sell. */
export function isWorkerOrder(order: WorkerOrderFields, nowMs: number): boolean {
  return WORKER_STATES.includes(order.state) || isPayoutSync(order, nowMs);
}

/** True when the order can still get a Transak update, so the worker watches its feed channel. */
export function watchesTransakFeed(order: WorkerOrderFields, nowMs: number): boolean {
  return TRANSAK_FEED_STATES.includes(order.state) || isPayoutSync(order, nowMs);
}

/**
 * An address has at most one order of each side in these states. The states use the Calibur nonce of the EOA,
 * so one order at a time keeps the batch nonce of that side serial.
 */
export const NONCE_STATES: readonly OrderState[] = ['checkout', 'awaiting_signature', 'signed', 'relay_sent'];
