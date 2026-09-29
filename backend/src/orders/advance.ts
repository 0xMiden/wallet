import type { Order, OrderPatch, OrderStore } from './store.js';
import { syncTransak, toBaseUnits, transakPhase, type TransakPollState } from './transak-sync.js';
import { encodeBuyExecution } from '../chain-testnet/calibur.js';
import { batchInputOf, batchNonceOf } from '../chain-testnet/preparation.js';
import type { Chain } from '../chain-testnet/sepolia.js';
import { authorizationSchema, toSignedAuthorization } from '../chain-testnet/signature.js';
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
  const current = balance ?? (await deps.chain.readBalance(order.evmAddress, order.tokenAddress));
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
  switch (transakPhase(transak.status)) {
    case 'failed':
      deps.store.transition(synced.id, 'checkout', 'failed', { error: `Transak order ${transak.status}` }, 'transak');
      return;
    case 'delivering':
    case 'completed': {
      if (transak.cryptoAmount === null || transak.cryptoAmount <= 0) {
        return;
      }
      const tokenAmount = toBaseUnits(transak.cryptoAmount, synced.tokenDecimals);
      if (tokenAmount <= 0n) {
        return;
      }
      logEvent('info', 'order_token_amount', {
        orderId: synced.id,
        transakStatus: transak.status,
        cryptoAmount: transak.cryptoAmount,
        tokenAmount,
        tokenDecimals: synced.tokenDecimals
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

async function advanceAwaitingSignature(order: Order, deps: OrderDeps): Promise<void> {
  const { order: synced, status } = await syncTransak(order, deps);
  if (transakPhase(status) === 'failed') {
    deps.store.transition(
      synced.id,
      'awaiting_signature',
      'failed',
      { error: `Transak order ${status}` },
      'transak'
    );
    return;
  }
  if (deps.now() - synced.stateChangedAt > SIGNATURE_TIMEOUT_MS) {
    deps.store.transition(synced.id, 'awaiting_signature', 'expired', {}, 'no signature after 24 h');
    return;
  }
  await handleUnderdelivery(synced, deps, null);
}

/** The reason why the stored signed batch can not be sent now, or null when it can. */
function staleReason(
  order: Order,
  fresh: Awaited<ReturnType<Chain['readAccount']>>,
  nowSeconds: number,
  authorizationNonce: number | null
): string | null {
  switch (true) {
    case order.batchNonce !== batchNonceOf(fresh.sequence).toString():
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

async function advanceSigned(order: Order, deps: OrderDeps): Promise<void> {
  const { order: synced, status } = await syncTransak(order, deps);
  if (synced.tokenAmount === null) {
    deps.store.transition(synced.id, 'signed', 'failed', { error: 'Order has no token amount' }, 'bad row');
    return;
  }
  const balance = await deps.chain.readBalance(synced.evmAddress, synced.tokenAddress);
  if (balance < BigInt(synced.tokenAmount)) {
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
    await handleUnderdelivery(synced, deps, balance);
    return;
  }

  const fresh = await deps.chain.readAccount(synced.evmAddress, synced.tokenAddress);
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
  const sent = await deps.chain.sendRelay({
    to: synced.evmAddress,
    data: encodeBuyExecution(input, synced.signature),
    authorization
  });
  const attempts = synced.relayAttempts + 1;
  logEvent('info', 'relay_sent', {
    orderId: synced.id,
    hash: sent.hash,
    relayerNonce: sent.nonce,
    type4: sent.type4,
    attempt: attempts
  });
  deps.store.transition(
    synced.id,
    'signed',
    'relay_sent',
    { relayTxHash: sent.hash, relayAttempts: attempts, error: null },
    'relay sent'
  );
}

async function advanceRelaySent(order: Order, deps: OrderDeps): Promise<void> {
  if (order.relayTxHash === null) {
    deps.store.transition(order.id, 'relay_sent', 'awaiting_signature', CLEAR_SIGNATURE, 'relay hash missing');
    return;
  }
  const status = await deps.chain.getReceiptStatus(order.relayTxHash);
  if (status !== null) {
    logEvent(status === 'success' ? 'info' : 'warn', 'relay_receipt', {
      orderId: order.id,
      hash: order.relayTxHash,
      status
    });
    deps.receiptWarnings.delete(order.relayTxHash);
  }
  switch (status) {
    case 'success':
      // The deposit is on Sepolia now. The job of the backend stops here: the wallet reads the Agglayer indexer.
      deps.store.transition(
        order.id,
        'relay_sent',
        'deposited',
        { signature: null, authorization: null },
        'relay succeeded'
      );
      return;
    case 'reverted':
      if (order.relayAttempts >= MAX_RELAY_ATTEMPTS) {
        deps.store.transition(
          order.id,
          'relay_sent',
          'failed',
          { ...CLEAR_SIGNATURE, error: `Relay reverted ${order.relayAttempts} times` },
          'relay reverted'
        );
        return;
      }
      // A reverted batch does not use its Calibur nonce, so the wallet signs again.
      deps.store.transition(
        order.id,
        'relay_sent',
        'awaiting_signature',
        { ...CLEAR_SIGNATURE, relayTxHash: null, error: 'Relay reverted' },
        'relay reverted'
      );
      return;
    case null:
      if (deps.now() - order.stateChangedAt > RECEIPT_WARNING_MS && !deps.receiptWarnings.has(order.relayTxHash)) {
        deps.receiptWarnings.add(order.relayTxHash);
        logEvent('warn', 'relay_receipt_missing', { orderId: order.id, hash: order.relayTxHash });
      }
      return;
  }
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
    case 'failed':
    case 'expired':
    case 'cancelled':
      return;
  }
}
