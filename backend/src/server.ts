import 'dotenv/config';

import { loadConfig } from './config.js';
import { openDatabase, OrderStore } from './db.js';
import { createApp } from './index.js';
import { errorText, logEvent } from './log.js';
import { createSepoliaChain } from './relay.js';
import { createTransakClient, type FetchLike } from './transak.js';
import { createPusherClient, createTransakFeed } from './transak-feed.js';
import { createUserIpResolver } from './user-ip.js';
import { startWorker, type Worker } from './worker.js';

const config = loadConfig(process.env);
const globalFetch: FetchLike = (url, init) => fetch(url, init);
const transak = createTransakClient({
  apiKey: config.transakApiKey,
  apiSecret: config.transakApiSecret,
  env: config.transakEnv,
  fetch: globalFetch,
  now: Date.now
});
const resolveUserIp = createUserIpResolver(globalFetch);
const orders = new OrderStore(openDatabase(config.dbPath), Date.now);
const chain = createSepoliaChain({ rpcUrl: config.sepoliaRpcUrl, relayerPrivateKey: config.relayerPrivateKey });

/** A feed event makes the worker advance that order at once. */
function triggerOrder(worker: Worker, orderId: string): void {
  worker.trigger(orderId).catch(error => {
    logEvent('error', 'worker_error', { orderId, error: errorText(error) });
  });
}

// The feed events come only after the connection opens, so `worker` is set before the first event.
const feed = createTransakFeed({
  pusher: createPusherClient(config.transakPusherKey, config.transakPusherCluster),
  apiKey: config.transakApiKey,
  onEvent: orderId => triggerOrder(worker, orderId)
});
const worker = startWorker({
  store: orders,
  transak,
  chain,
  feed,
  now: Date.now,
  intervalMs: config.workerIntervalMs,
  transakPollIntervalMs: config.transakPollIntervalMs
});
logEvent('info', 'worker_started', {
  relayer: chain.executor,
  intervalMs: config.workerIntervalMs,
  transakPollIntervalMs: config.transakPollIntervalMs
});

createApp({
  config,
  transak,
  resolveUserIp,
  orders,
  chain,
  now: Date.now,
  onOrderCreated: orderId => {
    feed.add(orderId);
    triggerOrder(worker, orderId);
  }
}).listen(config.port, () => {
  console.log(`Miden Wallet backend (${config.transakEnv}) on port ${config.port}`);
});
