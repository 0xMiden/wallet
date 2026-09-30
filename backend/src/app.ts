import express, { type Express } from 'express';

import type { Chain } from './chain-testnet/sepolia.js';
import type { Config } from './config.js';
import { cors } from './http/cors.js';
import { errorHandler } from './http/errors.js';
import { createOrderRouter } from './http/order-routes.js';
import { createTransakRouter } from './http/transak-routes.js';
import type { OrderStore } from './orders/store.js';
import type { TransakClient } from './transak/client.js';
import type { UserIpResolver } from './transak/user-ip.js';

export interface AppDeps {
  config: Pick<
    Config,
    | 'trustedProxies'
    | 'referrerDomain'
    | 'allowedOrigins'
    | 'maxFiatAmountUsd'
    | 'onrampTokenAddress'
    | 'onrampTokenDecimals'
  >;
  transak: TransakClient;
  /** Maps the caller IP to the IP that Transak pins the session to. */
  resolveUserIp: UserIpResolver;
  orders: Pick<OrderStore, 'get' | 'createCheckout' | 'transition'>;
  chain: Chain;
  /** Returns the time in milliseconds. */
  now: () => number;
  /** Called after a new order is stored. The server uses it to watch the Transak feed and to advance the order. */
  onOrderCreated: (orderId: string) => void;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustedProxies);
  app.use(cors(deps.config.allowedOrigins));
  app.use(express.json({ limit: '8kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/transak', createTransakRouter(deps));
  app.use('/orders', createOrderRouter(deps));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(errorHandler);

  return app;
}
