import { createRequire } from 'node:module';

import type * as PusherModule from 'pusher-js';
import { z } from 'zod';

import { logEvent } from './log.js';

/**
 * The Transak order feed (Pusher, public channels). The feed is only a trigger: an event makes the worker read the
 * Transak Get Orders API for that order at once. The worker never uses the event payload for the state or the amount.
 */

/** The Transak Pusher app. Transak publishes these values in its WebSocket docs. */
export const DEFAULT_TRANSAK_PUSHER_KEY = '1d9ffac87de599c61283';
export const DEFAULT_TRANSAK_PUSHER_CLUSTER = 'ap2';

export type PusherEventHandler = (eventName: string, data: unknown) => void;

/** The part of a `pusher-js` channel that the feed uses. */
export interface PusherChannelLike {
  bind_global(callback: PusherEventHandler): unknown;
  unbind_global(callback?: PusherEventHandler): unknown;
}

/** The part of a `pusher-js` client that the feed uses. The real client satisfies it with no cast. */
export interface PusherLike {
  subscribe(channelName: string): PusherChannelLike;
  unsubscribe(channelName: string): void;
  disconnect(): void;
  connection: {
    bind(eventName: string, callback: (change: unknown) => void): unknown;
  };
}

export interface TransakFeed {
  /** Watch these orders only: subscribe the missing channels and unsubscribe the others. */
  retain(orderIds: readonly string[]): void;
  /** Watch one more order. The other channels stay. */
  add(orderId: string): void;
  /** Unsubscribe all channels and close the connection. */
  close(): void;
}

export interface TransakFeedOptions {
  pusher: PusherLike;
  /** The Transak partner API key. It is the first part of each channel name. */
  apiKey: string;
  /** The feed calls this for each Transak event of an order. */
  onEvent: (orderId: string) => void;
}

// Only for the log. The payload shape can change, so each field is optional and a bad value becomes absent.
const eventLogSchema = z.object({
  status: z.string().optional().catch(undefined),
  cryptoAmount: z.number().optional().catch(undefined)
});

const stateChangeSchema = z.object({
  previous: z.string(),
  current: z.string()
});

/** The Pusher client events (`pusher:` and `pusher_internal:`) are not Transak events. */
function isPusherInternal(eventName: string): boolean {
  return eventName.startsWith('pusher:') || eventName.startsWith('pusher_internal:');
}

export function createTransakFeed({ pusher, apiKey, onEvent }: TransakFeedOptions): TransakFeed {
  /** The subscribed channels, by order ID. */
  const channels = new Map<string, { name: string; channel: PusherChannelLike; handler: PusherEventHandler }>();

  pusher.connection.bind('state_change', change => {
    const parsed = stateChangeSchema.safeParse(change);
    if (parsed.success) {
      logEvent(parsed.data.current === 'connected' ? 'info' : 'warn', 'pusher_connection', {
        from: parsed.data.previous,
        to: parsed.data.current
      });
    }
  });

  function subscribe(orderId: string): void {
    if (channels.has(orderId)) {
      return;
    }
    const name = `${apiKey}_${orderId}`;
    const handler: PusherEventHandler = (eventName, data) => {
      if (isPusherInternal(eventName)) {
        return;
      }
      const payload = eventLogSchema.safeParse(data);
      logEvent('info', 'pusher_event', {
        orderId,
        eventName,
        status: payload.success ? payload.data.status : undefined,
        cryptoAmount: payload.success ? payload.data.cryptoAmount : undefined
      });
      onEvent(orderId);
    };
    const channel = pusher.subscribe(name);
    channel.bind_global(handler);
    channels.set(orderId, { name, channel, handler });
    logEvent('info', 'pusher_subscribed', { orderId });
  }

  function unsubscribe(orderId: string): void {
    const entry = channels.get(orderId);
    if (entry === undefined) {
      return;
    }
    // Remove the handler first. Pusher can keep a channel object that has a pending subscription.
    entry.channel.unbind_global(entry.handler);
    pusher.unsubscribe(entry.name);
    channels.delete(orderId);
    logEvent('info', 'pusher_unsubscribed', { orderId });
  }

  function retain(orderIds: readonly string[]): void {
    const wanted = new Set(orderIds);
    for (const orderId of [...channels.keys()]) {
      if (!wanted.has(orderId)) {
        unsubscribe(orderId);
      }
    }
    for (const orderId of wanted) {
      subscribe(orderId);
    }
  }

  function close(): void {
    retain([]);
    pusher.disconnect();
  }

  return { retain, add: subscribe, close };
}

/**
 * The type of the Pusher class. `pusher-js` is CommonJS and its type file says `export default`. For an ES module,
 * TypeScript types the default import as `module.exports`, so the class type is at `.default.default`.
 */
type PusherClass = typeof PusherModule.default.default;

/**
 * Make the real Pusher client. At run time `module.exports` of `pusher-js` is the class itself, so an ESM default
 * import does not match its type. For this reason the module loads with `require`.
 * The Node build has its own WebSocket client, so Node 22 needs no polyfill.
 */
export function createPusherClient(key: string, cluster: string): PusherLike {
  const require = createRequire(import.meta.url);
  const Pusher: PusherClass = require('pusher-js');
  return new Pusher(key, { cluster });
}
