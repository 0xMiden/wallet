import { parseUnits } from 'viem';

import type { OrderDeps } from './advance.js';
import type { Order, OrderPatch } from './store.js';
import { logEvent } from '../log.js';
import type { TransakOrder } from '../transak/client.js';

/**
 * The Transak API call of an order runs only when one of these is true:
 * the order is dirty (a Transak feed event came), the order had no call yet, or the last call is
 * `intervalMs` old or more. The chain steps run on each tick and do not use this state.
 */
export interface TransakPollState {
  intervalMs: number;
  /** Unix ms of the last Transak call for each order. */
  lastCallAt: Map<string, number>;
  /** The orders that got a Transak feed event after their last Transak call. */
  dirty: Set<string>;
}

export type TransakPhase = 'waiting' | 'delivering' | 'completed' | 'failed';

export function transakPhase(status: string | null): TransakPhase {
  switch (status) {
    case 'PROCESSING':
    case 'PENDING_DELIVERY_FROM_TRANSAK':
      return 'delivering';
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
    case 'REFUNDED':
      return 'failed';
    default:
      return 'waiting';
  }
}

/** Convert the Transak `cryptoAmount` (a JSON number) to base units. Extra decimals are cut, not rounded. */
export function toBaseUnits(cryptoAmount: number, decimals: number): bigint {
  const text = /e/i.test(String(cryptoAmount)) ? cryptoAmount.toFixed(Math.min(decimals, 100)) : String(cryptoAmount);
  const [whole = '0', fraction = ''] = text.split('.');
  const kept = fraction.slice(0, decimals);
  return parseUnits(kept.length > 0 ? `${whole}.${kept}` : whole, decimals);
}

/** The result of `syncTransak`. */
export interface TransakSync {
  /** The order with the new Transak values. */
  order: Order;
  /** True when this step called the Transak API. False when the slow poll skipped the call. */
  called: boolean;
  /** The Transak order from this call. Null when Transak has no order, or when the call was skipped. */
  transak: TransakOrder | null;
  /** The Transak status to use: from this call, or the stored status when the call was skipped. */
  status: string | null;
}

/** True when the slow poll lets this step call the Transak API for the order. */
function transakCallDue(order: Order, deps: OrderDeps): boolean {
  const lastCallAt = deps.transakPoll.lastCallAt.get(order.id);
  if (deps.transakPoll.dirty.has(order.id) || lastCallAt === undefined) {
    return true;
  }
  return deps.now() - lastCallAt >= deps.transakPoll.intervalMs;
}

/**
 * Read the Transak order and keep its ID, status and first COMPLETED time on the row.
 * When the slow poll skips the call, return the stored row values: `status` is the stored `transakStatus`, and
 * `transakCompletedAt` stays on the row.
 */
export async function syncTransak(order: Order, deps: OrderDeps): Promise<TransakSync> {
  if (!transakCallDue(order, deps)) {
    return { order, called: false, transak: null, status: order.transakStatus };
  }
  // Record the call before it starts. A feed event during the call marks the order dirty again.
  // A failed call also waits for the interval, so a Transak outage does not get a call on each tick.
  deps.transakPoll.dirty.delete(order.id);
  deps.transakPoll.lastCallAt.set(order.id, deps.now());
  const transak = await deps.transak.getOrderByPartnerId(order.id);
  if (transak === null) {
    return { order, called: true, transak, status: null };
  }
  // Transak can change the amount at settlement with no status change. Log each new amount.
  if (!deps.loggedCryptoAmounts.has(order.id) || deps.loggedCryptoAmounts.get(order.id) !== transak.cryptoAmount) {
    logEvent('info', 'transak_crypto_amount', {
      orderId: order.id,
      transakOrderId: transak.id,
      status: transak.status,
      previousCryptoAmount: deps.loggedCryptoAmounts.get(order.id) ?? null,
      cryptoAmount: transak.cryptoAmount,
      baseUnits:
        transak.cryptoAmount === null || transak.cryptoAmount <= 0
          ? null
          : toBaseUnits(transak.cryptoAmount, order.tokenDecimals),
      signedTokenAmount: order.tokenAmount
    });
    deps.loggedCryptoAmounts.set(order.id, transak.cryptoAmount);
  }
  const patch: OrderPatch = {};
  if (transak.id !== order.transakOrderId) {
    patch.transakOrderId = transak.id;
  }
  if (transak.status !== order.transakStatus) {
    patch.transakStatus = transak.status;
    logEvent('info', 'transak_status', {
      orderId: order.id,
      transakOrderId: transak.id,
      from: order.transakStatus,
      to: transak.status,
      cryptoAmount: transak.cryptoAmount
    });
  }
  if (transak.status === 'COMPLETED' && order.transakCompletedAt === null) {
    patch.transakCompletedAt = deps.now();
  }
  if (Object.keys(patch).length === 0) {
    return { order, called: true, transak, status: transak.status };
  }
  deps.store.update(order.id, order.state, patch);
  return { order: { ...order, ...patch }, called: true, transak, status: transak.status };
}
