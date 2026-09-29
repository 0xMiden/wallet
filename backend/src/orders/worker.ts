import { advanceOrder, type OrderDeps } from './advance.js';
import { TRANSAK_FEED_STATES, WORKER_STATES } from './states.js';
import type { Order } from './store.js';
import { errorText, logEvent, type LogFields } from '../log.js';
import { TransakError } from '../transak/client.js';
import type { TransakFeed } from '../transak/feed.js';

export interface WorkerOptions extends Omit<OrderDeps, 'receiptWarnings' | 'loggedCryptoAmounts' | 'transakPoll'> {
  intervalMs: number;
  /** The minimum time between two Transak API calls for one order, when no feed event comes. */
  transakPollIntervalMs: number;
  /** The worker gives the feed the orders to watch at the start of each tick. */
  feed: Pick<TransakFeed, 'retain'>;
}

export interface Worker {
  /** Run one tick now. A tick that starts while a tick or a trigger runs does nothing. */
  tick(): Promise<void>;
  /**
   * Advance one order now, with a Transak call. When a tick or a trigger runs, the order waits, and the running call
   * advances it when it is done. Two advances never run at the same time.
   */
  trigger(orderId: string): Promise<void>;
  stop(): void;
}

/** The fields of a `worker_error` line. A Transak error also gives its detail, which has no secret. */
function errorFields(error: unknown): LogFields {
  return {
    error: errorText(error),
    detail: error instanceof TransakError ? error.detail : undefined
  };
}

/**
 * Advance each active order by one step per tick.
 * The orders go in sequence, so two relay sends never race for the relayer nonce.
 * A tick never waits for a receipt: it sends and stores the hash, and a later tick reads the receipt.
 * The Transak API call of an order runs only on a feed event or after the slow-poll interval (see `syncTransak`).
 */
export function createWorker(options: WorkerOptions): Worker {
  const { intervalMs, transakPollIntervalMs, feed, ...rest } = options;
  const deps: OrderDeps = {
    ...rest,
    receiptWarnings: new Set(),
    loggedCryptoAmounts: new Map(),
    transakPoll: { intervalMs: transakPollIntervalMs, lastCallAt: new Map(), dirty: new Set() }
  };
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  /** The triggered orders that wait for the running tick or trigger. */
  const pending = new Set<string>();

  async function advance(order: Order): Promise<void> {
    try {
      await advanceOrder(order, deps);
    } catch (error) {
      // The order stays in its state. The next tick tries again.
      logEvent('error', 'worker_error', { orderId: order.id, state: order.state, ...errorFields(error) });
    }
  }

  /** Advance each triggered order once. A trigger during this loop goes into the same loop. */
  async function drainPending(): Promise<void> {
    for (const orderId of pending) {
      pending.delete(orderId);
      let order: Order | null;
      try {
        order = deps.store.get(orderId);
      } catch (error) {
        logEvent('error', 'worker_error', { orderId, ...errorFields(error) });
        continue;
      }
      if (order !== null && WORKER_STATES.includes(order.state)) {
        await advance(order);
      }
    }
  }

  async function runTick(): Promise<void> {
    let orders: Order[];
    try {
      orders = deps.store.listForWorker();
    } catch (error) {
      logEvent('error', 'worker_error', errorFields(error));
      return;
    }
    // Forget the poll state of the orders that are not active any more.
    const active = new Set(orders.map(order => order.id));
    for (const orderId of deps.transakPoll.lastCallAt.keys()) {
      if (!active.has(orderId)) {
        deps.transakPoll.lastCallAt.delete(orderId);
      }
    }
    for (const orderId of deps.transakPoll.dirty) {
      if (!active.has(orderId) && !pending.has(orderId)) {
        deps.transakPoll.dirty.delete(orderId);
      }
    }
    try {
      feed.retain(orders.filter(order => TRANSAK_FEED_STATES.includes(order.state)).map(order => order.id));
    } catch (error) {
      // The slow poll still reads Transak without the feed.
      logEvent('error', 'worker_error', errorFields(error));
    }
    for (const order of orders) {
      await advance(order);
    }
  }

  async function tick(): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    try {
      await runTick();
      await drainPending();
    } finally {
      running = false;
    }
  }

  async function trigger(orderId: string): Promise<void> {
    deps.transakPoll.dirty.add(orderId);
    pending.add(orderId);
    if (running) {
      // The running tick or trigger advances the order when it is done.
      return;
    }
    running = true;
    try {
      await drainPending();
    } finally {
      running = false;
    }
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  timer = setInterval(() => {
    tick().catch(error => {
      logEvent('error', 'worker_error', errorFields(error));
    });
  }, intervalMs);
  // The timer does not keep the process alive alone.
  timer.unref();

  return { tick, trigger, stop };
}

/** Start the worker and run the first tick at once. */
export function startWorker(options: WorkerOptions): Worker {
  const worker = createWorker(options);
  worker.tick().catch(error => {
    logEvent('error', 'worker_error', errorFields(error));
  });
  return worker;
}
