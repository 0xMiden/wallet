import { isPayoutSync } from './states.js';
import type { Order, OrderPatch, OrderStore } from './store.js';
import { syncTransak, toBaseUnits, transakPhase, type TransakPollState } from './transak-sync.js';
import { encodeExecution, nonceKeyOf } from '../chain-testnet/calibur.js';
import { batchInputOf, batchNonceOf } from '../chain-testnet/preparation.js';
import type { Chain } from '../chain-testnet/sepolia.js';
import { authorizationSchema, toSignedAuthorization } from '../chain-testnet/signature.js';
import { ONRAMP_TOKEN, tokenOf } from '../chain-testnet/token.js';
import { logEvent } from '../log.js';
import type { TransakClient } from '../transak/client.js';

/** A checkout with no Transak order after this time expires. */
export const CHECKOUT_TIMEOUT_MS = 60 * 60 * 1000;
/** An order that waits for the wallet signature for longer than this time expires. */
export const SIGNATURE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** When Transak says COMPLETED and the balance stays low for this time, the order uses the balance. */
export const UNDERDELIVERY_GRACE_MS = 10 * 60 * 1000;
/** A relay transaction with no receipt after this time gets a warning in the log. */
export const RECEIPT_WARNING_MS = 15 * 60 * 1000;
/** After this number of reverted relays the order fails. */
export const MAX_RELAY_ATTEMPTS = 3;
/** The worker does not send a batch with less than this number of seconds before its deadline. */
const DEADLINE_MARGIN_SECONDS = 60;
/** The worker does not send a sell relay with less than this number of seconds before Transak expires the order. */
export const SELL_EXPIRY_MARGIN_SECONDS = 120;

/** The Transak statuses of a sell order in which Transak still accepts the deposit. */
const SELL_PAYABLE_STATUSES = new Set(['AWAITING_PAYMENT_FROM_USER', 'PAYMENT_DONE_MARKED_BY_USER']);

export interface OrderDeps {
  store: OrderStore;
  transak: Pick<TransakClient, 'getOrderByPartnerId'>;
  chain: Chain;
  /** Returns the time in milliseconds. */
  now: () => number;
  /** The relay hashes that already got the missing-receipt warning. The worker keeps this set. */
  receiptWarnings: Set<string>;
  /** The last Transak `cryptoAmount` that the log shows for each order. The worker keeps this map. */
  loggedCryptoAmounts: Map<string, number | null>;
  /** The signed sells that already got the `sell_funds_waiting` log line. The worker keeps this set. */
  fundsWaits: Set<string>;
  /** The slow poll of the Transak API. The worker keeps this state. */
  transakPoll: TransakPollState;
}

/** The patch that removes the signed batch from an order. */
const CLEAR_SIGNATURE: OrderPatch = {
  batchNonce: null,
  salt: null,
  deadline: null,
  signature: null,
  authorization: null
};

/**
 * Transak says COMPLETED, but the balance stayed below the amount for the grace time.
 * Use the balance as the new amount. A signed order goes back to `awaiting_signature` to sign the lower amount.
 * Return true when the order changed.
 */
async function handleUnderdelivery(order: Order, deps: OrderDeps, balance: bigint | null): Promise<boolean> {
  if (
    order.tokenAmount === null ||
    order.transakCompletedAt === null ||
    deps.now() - order.transakCompletedAt < UNDERDELIVERY_GRACE_MS
  ) {
    return false;
  }
  const current = balance ?? (await deps.chain.readBalance(order.evmAddress, ONRAMP_TOKEN.address));
  if (current >= BigInt(order.tokenAmount)) {
    return false;
  }
  if (current === 0n) {
    logEvent('warn', 'order_no_delivery', { orderId: order.id, tokenAmount: order.tokenAmount });
    return false;
  }
  logEvent('warn', 'order_underdelivered', {
    orderId: order.id,
    tokenAmount: order.tokenAmount,
    balance: current
  });
  const patch: OrderPatch = { ...CLEAR_SIGNATURE, tokenAmount: current.toString() };
  switch (order.state) {
    case 'signed':
      return deps.store.transition(order.id, 'signed', 'awaiting_signature', patch, 'underdelivery');
    case 'awaiting_signature':
      return deps.store.update(order.id, 'awaiting_signature', patch);
    default:
      return false;
  }
}

/** The base units the relay of a sell transfers: the full crypto amount Transak asks for. */
export function sellRelayTokenAmount(depositAmount: number): bigint {
  return toBaseUnits(depositAmount, tokenOf('sell').decimals);
}

/**
 * The funds gate of a signed sell. The wallet signs before the bridge-out releases the token on Sepolia, so the
 * balance can stay below the amount for about 30 minutes. Return true when the balance covers the amount.
 * The log shows the start of the wait and the arrival of the funds, one line each.
 */
function sellFundsPresent(order: Order, tokenAmount: bigint, balance: bigint, deps: OrderDeps): boolean {
  if (balance < tokenAmount) {
    if (!deps.fundsWaits.has(order.id)) {
      deps.fundsWaits.add(order.id);
      logEvent('info', 'sell_funds_waiting', { orderId: order.id, tokenAmount, balance });
    }
    return false;
  }
  if (deps.fundsWaits.delete(order.id)) {
    logEvent('info', 'sell_funds_arrived', { orderId: order.id, tokenAmount, balance });
  }
  return true;
}

/** True when Transak expires the sell order in less than the margin, so a relay could land too late. */
function sellExpiryNear(order: Order, deps: OrderDeps): boolean {
  return (
    order.autoExpiresAt !== null && order.autoExpiresAt - Math.floor(deps.now() / 1000) < SELL_EXPIRY_MARGIN_SECONDS
  );
}

/** A buy at checkout waits for Transak to deliver, then asks for the bridge signature. */
function advanceBuyCheckout(
  synced: Order,
  transak: NonNullable<Awaited<ReturnType<typeof syncTransak>>['transak']>,
  deps: OrderDeps
): void {
  switch (transakPhase(transak.status)) {
    case 'failed':
      deps.store.transition(synced.id, 'checkout', 'failed', { error: `Transak order ${transak.status}` }, 'transak');
      return;
    case 'delivering':
    case 'completed': {
      if (transak.cryptoAmount === null || transak.cryptoAmount <= 0) {
        return;
      }
      const tokenAmount = toBaseUnits(transak.cryptoAmount, ONRAMP_TOKEN.decimals);
      if (tokenAmount <= 0n) {
        return;
      }
      logEvent('info', 'order_token_amount', {
        orderId: synced.id,
        transakStatus: transak.status,
        cryptoAmount: transak.cryptoAmount,
        tokenAmount,
        tokenDecimals: ONRAMP_TOKEN.decimals
      });
      deps.store.transition(
        synced.id,
        'checkout',
        'awaiting_signature',
        { tokenAmount: tokenAmount.toString() },
        `transak ${transak.status}`
      );
      return;
    }
    case 'waiting':
      return;
  }
}

/**
 * A sell at checkout waits for the Transak order to show its deposit address and amount, then asks for the
 * transfer signature. The order is payable until Transak expires it.
 */
function advanceSellCheckout(synced: Order, status: string, deps: OrderDeps): void {
  if (transakPhase(status) === 'failed') {
    deps.store.transition(synced.id, 'checkout', 'failed', { error: `Transak order ${status}` }, 'transak');
    return;
  }
  if (!SELL_PAYABLE_STATUSES.has(status)) return;
  if (sellExpiryNear(synced, deps)) {
    deps.store.transition(synced.id, 'checkout', 'expired', {}, 'Transak order expiry near');
    return;
  }
  if (synced.depositAddress === null || synced.depositAmount === null || synced.depositAmount <= 0) return;
  const tokenAmount = sellRelayTokenAmount(synced.depositAmount);
  if (tokenAmount <= 0n) return;
  logEvent('info', 'order_token_amount', {
    orderId: synced.id,
    transakStatus: status,
    cryptoAmount: synced.depositAmount,
    tokenAmount,
    tokenDecimals: tokenOf('sell').decimals
  });
  deps.store.transition(
    synced.id,
    'checkout',
    'awaiting_signature',
    { tokenAmount: tokenAmount.toString() },
    `transak ${status}`
  );
}

async function advanceCheckout(order: Order, deps: OrderDeps): Promise<void> {
  const { order: synced, called, transak } = await syncTransak(order, deps);
  if (!called) {
    // A checkout changes only on Transak data. The next call does the expiry check too.
    return;
  }
  if (transak === null) {
    if (deps.now() - synced.createdAt > CHECKOUT_TIMEOUT_MS) {
      deps.store.transition(synced.id, 'checkout', 'expired', {}, 'no Transak order after 1 h');
    }
    return;
  }
  switch (synced.side) {
    case 'buy':
      advanceBuyCheckout(synced, transak, deps);
      return;
    case 'sell':
      advanceSellCheckout(synced, transak.status, deps);
      return;
  }
}

async function advanceAwaitingSignature(order: Order, deps: OrderDeps): Promise<void> {
  const { order: synced, status } = await syncTransak(order, deps);
  if (synced.state !== 'awaiting_signature') {
    return;
  }
  if (transakPhase(status) === 'failed') {
    deps.store.transition(synced.id, 'awaiting_signature', 'failed', { error: `Transak order ${status}` }, 'transak');
    return;
  }
  if (deps.now() - synced.stateChangedAt > SIGNATURE_TIMEOUT_MS) {
    deps.store.transition(synced.id, 'awaiting_signature', 'expired', {}, 'no signature after 24 h');
    return;
  }
  switch (synced.side) {
    case 'buy':
      await handleUnderdelivery(synced, deps, null);
      return;
    case 'sell':
      if (sellExpiryNear(synced, deps)) {
        deps.store.transition(synced.id, 'awaiting_signature', 'expired', {}, 'Transak order expiry near');
      }
      return;
  }
}

/** The reason why the stored signed batch can not be sent now, or null when it can. */
function staleReason(
  order: Order,
  fresh: Awaited<ReturnType<Chain['readAccount']>>,
  nowSeconds: number,
  authorizationNonce: number | null
): string | null {
  switch (true) {
    case order.batchNonce !== batchNonceOf(order.side, fresh.sequence).toString():
      return 'batch nonce changed';
    case order.salt === null || order.salt.toLowerCase() !== fresh.salt.toLowerCase():
      return 'domain salt changed';
    case order.deadline === null || order.deadline <= nowSeconds + DEADLINE_MARGIN_SECONDS:
      return 'deadline passed';
    case fresh.needsAuthorization && authorizationNonce !== fresh.authorizationNonce:
      return 'authorization nonce changed';
    default:
      return null;
  }
}

/**
 * The Transak gate of a signed order: true when Transak permits the relay now. A buy relays once Transak settled
 * the delivery. A sell relays while Transak still accepts the deposit, and not within the expiry margin. On false
 * the order waits or has moved on. The balance check comes after this gate, so a sell that waits for its bridged
 * funds still expires when the Transak expiry is near.
 */
async function relayGateOpen(synced: Order, status: string | null, deps: OrderDeps): Promise<boolean> {
  switch (synced.side) {
    case 'buy':
      // A provisional quote must not spend an existing wallet balance.
      return status === 'COMPLETED' && synced.settledTokenAmount !== null;
    case 'sell':
      if (status === null || !SELL_PAYABLE_STATUSES.has(status)) return false;
      if (sellExpiryNear(synced, deps)) {
        deps.store.transition(synced.id, 'signed', 'expired', CLEAR_SIGNATURE, 'Transak order expiry near');
        return false;
      }
      return true;
  }
}

async function advanceSigned(order: Order, deps: OrderDeps): Promise<void> {
  const { order: synced, status } = await syncTransak(order, deps);
  if (synced.state !== 'signed') {
    return;
  }
  if (synced.tokenAmount === null) {
    deps.store.transition(synced.id, 'signed', 'failed', { error: 'Order has no token amount' }, 'bad row');
    return;
  }
  if (transakPhase(status) === 'failed') {
    deps.store.transition(
      synced.id,
      'signed',
      'failed',
      { ...CLEAR_SIGNATURE, error: `Transak order ${status}` },
      'transak'
    );
    return;
  }
  if (!(await relayGateOpen(synced, status, deps))) {
    return;
  }
  const token = tokenOf(synced.side);
  const balance = await deps.chain.readBalance(synced.evmAddress, token.address);
  const tokenAmount = BigInt(synced.tokenAmount);
  switch (synced.side) {
    case 'buy':
      if (balance < tokenAmount) {
        await handleUnderdelivery(synced, deps, balance);
        return;
      }
      break;
    case 'sell':
      // No relay attempt and no failure while the bridged token is not on the address. The order stays `signed`.
      if (!sellFundsPresent(synced, tokenAmount, balance, deps)) return;
      break;
  }

  const fresh = await deps.chain.readAccount(synced.evmAddress, token.address, nonceKeyOf(synced.side));
  const storedAuthorization =
    synced.authorization === null ? null : authorizationSchema.parse(JSON.parse(synced.authorization));
  const reason = staleReason(
    synced,
    fresh,
    Math.floor(deps.now() / 1000),
    storedAuthorization === null ? null : storedAuthorization.nonce
  );
  if (
    reason !== null ||
    synced.batchNonce === null ||
    synced.salt === null ||
    synced.deadline === null ||
    synced.signature === null
  ) {
    deps.store.transition(synced.id, 'signed', 'awaiting_signature', CLEAR_SIGNATURE, reason ?? 'signature missing');
    return;
  }

  const input = batchInputOf(
    synced,
    { tokenAmount: synced.tokenAmount, batchNonce: synced.batchNonce, salt: synced.salt, deadline: synced.deadline },
    deps.chain.executor
  );
  // An address that is already delegated to Calibur needs no authorization.
  const authorization =
    fresh.needsAuthorization && storedAuthorization !== null ? toSignedAuthorization(storedAuthorization) : null;
  const sent = await deps.chain.prepareRelay(
    {
      to: synced.evmAddress,
      data: encodeExecution(input, synced.signature),
      authorization
    },
    deps.store.relays.nextNonce(deps.chain.executor)
  );
  // Store the signed bytes before broadcast. A cancelled order cannot reserve this relay.
  const reserved = deps.store.reserveRelay(synced.id, synced.tokenAmount, {
    txHash: sent.hash,
    rawTransaction: sent.serializedTransaction,
    nonce: sent.nonce,
    sender: deps.chain.executor
  });
  if (!reserved) {
    return;
  }
  await deps.chain.broadcastRelay(sent.serializedTransaction);
  logEvent('info', 'relay_sent', {
    orderId: synced.id,
    side: synced.side,
    hash: sent.hash,
    relayerNonce: sent.nonce,
    type4: sent.type4,
    attempt: deps.store.relays.get(synced.id)?.attempts
  });
}

async function advanceRelaySent(order: Order, deps: OrderDeps): Promise<void> {
  const relay = deps.store.relays.get(order.id);
  if (relay === null || relay.status !== 'pending') {
    throw new Error(`Order ${order.id} has no pending relay`);
  }
  const status = await deps.chain.getReceiptStatus(relay.txHash);
  if (status !== null) {
    logEvent(status === 'success' ? 'info' : 'warn', 'relay_receipt', {
      orderId: order.id,
      hash: relay.txHash,
      status
    });
    deps.receiptWarnings.delete(relay.txHash);
  }
  switch (status) {
    case 'success':
      // A buy: the wallet tracks the Miden claim after this deposit. A sell: Transak pays out after this deposit.
      deps.store.completeRelay(order.id, relay.txHash, status, 'deposited', {
        signature: null,
        authorization: null
      });
      // A sell: read Transak on the next step, with no wait for the slow poll. Transak sees the deposit soon.
      if (order.side === 'sell') deps.transakPoll.dirty.add(order.id);
      return;
    case 'reverted':
      if (relay.attempts >= MAX_RELAY_ATTEMPTS) {
        deps.store.completeRelay(order.id, relay.txHash, status, 'failed', {
          ...CLEAR_SIGNATURE,
          error: `Relay reverted ${relay.attempts} times`
        });
        return;
      }
      // A reverted batch does not use its Calibur nonce. The wallet must sign again.
      deps.store.completeRelay(order.id, relay.txHash, status, 'awaiting_signature', {
        ...CLEAR_SIGNATURE,
        error: 'Relay reverted'
      });
      return;
    case null:
      if (deps.now() - order.stateChangedAt > RECEIPT_WARNING_MS && !deps.receiptWarnings.has(relay.txHash)) {
        deps.receiptWarnings.add(relay.txHash);
        logEvent('warn', 'relay_receipt_missing', { orderId: order.id, hash: relay.txHash });
      }
      // Repeat the same transaction after a crash or a lost RPC response.
      if (relay.rawTransaction !== null) {
        await deps.chain.broadcastRelay(relay.rawTransaction);
      }
      return;
  }
}

/**
 * A `deposited` order does not change its state. For a sell, the worker keeps the Transak status on the row fresh
 * until Transak reaches a final status, with the feed and the slow poll: the wallet shows the payout from it.
 */
async function advanceDeposited(order: Order, deps: OrderDeps): Promise<void> {
  if (!isPayoutSync(order, deps.now())) {
    return;
  }
  await syncTransak(order, deps);
}

/** Advance one order by one step. The worker calls this in sequence for each order in a tick. */
export async function advanceOrder(order: Order, deps: OrderDeps): Promise<void> {
  switch (order.state) {
    case 'checkout':
      return advanceCheckout(order, deps);
    case 'awaiting_signature':
      return advanceAwaitingSignature(order, deps);
    case 'signed':
      return advanceSigned(order, deps);
    case 'relay_sent':
      return advanceRelaySent(order, deps);
    case 'deposited':
      return advanceDeposited(order, deps);
    case 'failed':
    case 'expired':
    case 'cancelled':
      return;
  }
}
