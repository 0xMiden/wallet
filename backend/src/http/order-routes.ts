import { Router } from 'express';

import { HttpError } from './errors.js';
import { NONCE_PATTERN } from './transak-routes.js';
import type { AppDeps } from '../app.js';
import { buildPreparation, type Preparation } from '../chain-testnet/preparation.js';
import { signatureBodySchema, verifySignedBatch } from '../chain-testnet/signature.js';
import { ONRAMP_TOKEN } from '../chain-testnet/token.js';
import { errorText, logEvent } from '../log.js';
import type { Order } from '../orders/store.js';

/** The order ID is the challenge nonce. */
const ORDER_ID_PATTERN = NONCE_PATTERN;

/** The public status of an order. `GET /orders/:id` sends this object. */
interface OrderView {
  id: string;
  state: Order['state'];
  transakStatus: string | null;
  tokenAddress: string;
  tokenDecimals: number;
  tokenAmount: string | null;
  relayTxHash: string | null;
  error: string | null;
  prepare: Preparation | null;
}

function orderView(order: Order, prepare: Preparation | null, relayTxHash: string | null): OrderView {
  return {
    id: order.id,
    state: order.state,
    transakStatus: order.transakStatus,
    tokenAddress: ONRAMP_TOKEN.address,
    tokenDecimals: ONRAMP_TOKEN.decimals,
    tokenAmount: order.tokenAmount,
    relayTxHash,
    error: order.error,
    prepare
  };
}

export type OrderRoutesDeps = Pick<AppDeps, 'orders' | 'chain' | 'now'>;

/** `GET /orders/:id` and `POST /orders/:id/signature`. Mount at `/orders`. */
export function createOrderRouter({ orders, chain, now }: OrderRoutesDeps): Router {
  const router = Router();

  function findOrder(id: string | string[] | undefined): Order {
    const order = typeof id === 'string' && ORDER_ID_PATTERN.test(id) ? orders.get(id) : null;
    if (order === null) {
      throw new HttpError(404, 'Order not found');
    }
    return order;
  }

  router.get('/:id', async (req, res) => {
    const order = findOrder(req.params.id);
    let prepare: Preparation | null = null;
    if (order.state === 'awaiting_signature' && order.tokenAmount !== null) {
      try {
        const account = await chain.readAccount(order.evmAddress, ONRAMP_TOKEN.address);
        prepare = buildPreparation(order, order.tokenAmount, account, chain.executor, now());
      } catch (error) {
        // The wallet asks again on its next poll. The status is still correct without the prepare values.
        logEvent('warn', 'prepare_failed', { orderId: order.id, error: errorText(error) });
      }
    }
    const relay = orders.relays.get(order.id);
    const showRelay = order.state === 'relay_sent' || order.state === 'deposited' || order.state === 'failed';
    res.json(orderView(order, prepare, showRelay ? (relay?.txHash ?? null) : null));
  });

  router.post('/:id/signature', async (req, res) => {
    const body = signatureBodySchema.parse(req.body);
    const order = findOrder(req.params.id);
    if (order.state !== 'awaiting_signature' || order.tokenAmount === null) {
      throw new HttpError(409, 'Order does not wait for a signature');
    }
    const account = await chain.readAccount(order.evmAddress, ONRAMP_TOKEN.address);
    const current = buildPreparation(order, order.tokenAmount, account, chain.executor, now());
    await verifySignedBatch(order, body, current, now());
    const changed = orders.transition(
      order.id,
      'awaiting_signature',
      'signed',
      {
        batchNonce: body.batchNonce,
        salt: body.salt,
        deadline: body.deadline,
        signature: body.signature,
        authorization: body.authorization === undefined ? null : JSON.stringify(body.authorization),
        error: null
      },
      'wallet signed',
      order.tokenAmount
    );
    if (!changed) {
      throw new HttpError(409, 'Order does not wait for a signature');
    }
    res.json({ state: 'signed' });
  });

  return router;
}
