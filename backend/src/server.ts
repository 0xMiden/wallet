import 'dotenv/config';

import { createApp } from './app.js';
import { createSepoliaChain } from './chain-testnet/sepolia.js';
import { loadConfig } from './config.js';
import { acquireInstanceLock } from './instance-lock.js';
import { errorText, logEvent } from './log.js';
import { openDatabase, OrderStore } from './orders/store.js';
import { startWorker, type Worker } from './orders/worker.js';
import { createShutdown } from './shutdown.js';
import { createTransakClient, type FetchLike } from './transak/client.js';
import { createPusherClient, createTransakFeed } from './transak/feed.js';
import { userIpResolverFor } from './transak/user-ip.js';

const config = loadConfig(process.env);
const lock = acquireInstanceLock(config.dbPath);
const globalFetch: FetchLike = (url, init) => fetch(url, init);
const transak = createTransakClient({
  apiKey: config.transakApiKey,
  apiSecret: config.transakApiSecret,
  env: config.transakEnv,
  fetch: globalFetch,
  now: Date.now
});
const resolveUserIp = userIpResolverFor(config.transakEnv, globalFetch);
const database = openDatabase(config.dbPath);
const orders = new OrderStore(database, Date.now);
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

const server = createApp({
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
  logEvent('info', 'server_started', { env: config.transakEnv, port: config.port });
});

const shutdown = createShutdown({ server, worker, feed, database, lock, exit: process.exit, timeoutMs: 30_000 });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.on('error', () => {
  logEvent('error', 'server_failed');
  process.exit(1);
});
