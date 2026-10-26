import { parseUnits } from 'viem';

import type { OrderDeps } from './advance.js';
import { addressFields, autoExpiresAtOf, findDepositAddress } from './deposit-address.js';
import type { Order, OrderPatch } from './store.js';
import { ONRAMP_TOKEN } from '../chain-testnet/token.js';
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

/** The buy-only part of a sync: the log of each new amount, and the settled amount at COMPLETED. */
function syncBuy(order: Order, transak: TransakOrder, patch: OrderPatch, deps: OrderDeps): TransakSync | null {
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
          : toBaseUnits(transak.cryptoAmount, ONRAMP_TOKEN.decimals),
      signedTokenAmount: order.tokenAmount
    });
    deps.loggedCryptoAmounts.set(order.id, transak.cryptoAmount);
  }
  if (transak.status === 'COMPLETED' && order.transakCompletedAt === null) {
    patch.transakCompletedAt = deps.now();
  }
  if (transak.status === 'COMPLETED' && transak.cryptoAmount !== null && transak.cryptoAmount > 0) {
    const amount = toBaseUnits(transak.cryptoAmount, ONRAMP_TOKEN.decimals).toString();
    if (amount !== '0' && amount !== order.settledTokenAmount) {
      patch.settledTokenAmount = amount;
      patch.tokenAmount = amount;
      if (order.tokenAmount !== amount && order.state === 'signed') {
        deps.store.transition(
          order.id,
          'signed',
          'awaiting_signature',
          { ...patch, batchNonce: null, salt: null, deadline: null, signature: null, authorization: null },
          'settled amount changed'
        );
        const fresh = deps.store.get(order.id) ?? order;
        return { order: fresh, called: true, transak, status: transak.status };
      }
    }
  }
  return null;
}

/**
 * The sell-only part of a sync: the deposit address, the deposit amount and the expiry of the Transak order. The
 * order fields are logged on each status change, with every address and its path: the shape of a sell order is not
 * documented, so the log is how the deposit rule was pinned and how a change would show.
 */
function syncSell(order: Order, transak: TransakOrder, patch: OrderPatch): void {
  const deposit = findDepositAddress(transak.raw, order.evmAddress);
  if (deposit !== null && deposit.address.toLowerCase() !== order.depositAddress?.toLowerCase()) {
    patch.depositAddress = deposit.address;
  }
  if (transak.cryptoAmount !== order.depositAmount) patch.depositAmount = transak.cryptoAmount;
  const autoExpiresAt = autoExpiresAtOf(transak.raw);
  if (autoExpiresAt !== null && autoExpiresAt !== order.autoExpiresAt) patch.autoExpiresAt = autoExpiresAt;
  if (patch.transakStatus !== undefined) {
    logEvent('info', 'sell_order_fields', {
      orderId: order.id,
      transakOrderId: transak.id,
      status: transak.status,
      keys: typeof transak.raw === 'object' && transak.raw !== null ? Object.keys(transak.raw).join(',') : '',
      addresses: JSON.stringify(addressFields(transak.raw)),
      depositPath: deposit?.path ?? null,
      depositAddress: deposit?.address ?? null,
      autoExpiresAt
    });
  }
}

/**
 * Read the Transak order and keep its ID, status and side-specific values on the row.
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
  switch (order.side) {
    case 'buy': {
      const resigned = syncBuy(order, transak, patch, deps);
      if (resigned !== null) return resigned;
      break;
    }
    case 'sell':
      syncSell(order, transak, patch);
      break;
  }
  if (Object.keys(patch).length === 0) {
    return { order, called: true, transak, status: transak.status };
  }
  deps.store.update(order.id, order.state, patch);
  const fresh = deps.store.get(order.id) ?? order;
  return { order: fresh, called: true, transak, status: transak.status };
}
