import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { z } from 'zod';

import {
  createPusherClient,
  createTransakFeed,
  type PusherChannelLike,
  type PusherEventHandler,
  type PusherLike,
  type TransakFeed
} from './feed.js';
import { captureLogs } from '../test/support.js';

const API_KEY = 'partner-key';

class FakeChannel implements PusherChannelLike {
  handlers: PusherEventHandler[] = [];

  bind_global(callback: PusherEventHandler): this {
    this.handlers.push(callback);
    return this;
  }

  unbind_global(callback?: PusherEventHandler): this {
    this.handlers = callback === undefined ? [] : this.handlers.filter(handler => handler !== callback);
    return this;
  }

  emit(eventName: string, data: unknown): void {
    for (const handler of this.handlers) {
      handler(eventName, data);
    }
  }
}

class FakePusher implements PusherLike {
  channels = new Map<string, FakeChannel>();
  subscribed: string[] = [];
  unsubscribed: string[] = [];
  disconnected = false;
  stateHandlers: Array<(change: unknown) => void> = [];
  connection = {
    bind: (eventName: string, callback: (change: unknown) => void): void => {
      if (eventName === 'state_change') {
        this.stateHandlers.push(callback);
      }
    }
  };

  subscribe(channelName: string): FakeChannel {
    this.subscribed.push(channelName);
    const channel = this.channels.get(channelName) ?? new FakeChannel();
    this.channels.set(channelName, channel);
    return channel;
  }

  unsubscribe(channelName: string): void {
    this.unsubscribed.push(channelName);
    this.channels.delete(channelName);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  channel(orderId: string): FakeChannel {
    const channel = this.channels.get(`${API_KEY}_${orderId}`);
    assert.ok(channel, `no channel for ${orderId}`);
    return channel;
  }
}

const logEntrySchema = z.object({
  event: z.string(),
  orderId: z.string().optional(),
  eventName: z.string().optional(),
  status: z.string().optional(),
  cryptoAmount: z.number().optional(),
  from: z.string().optional(),
  to: z.string().optional()
});

let logs: string[];
let pusher: FakePusher;
let events: string[];
let feed: TransakFeed;

function entries(event: string): Array<z.infer<typeof logEntrySchema>> {
  return logs.map(line => logEntrySchema.parse(JSON.parse(line))).filter(entry => entry.event === event);
}

beforeEach(() => {
  logs = captureLogs();
  pusher = new FakePusher();
  events = [];
  feed = createTransakFeed({ pusher, apiKey: API_KEY, onEvent: orderId => events.push(orderId) });
});

describe('createTransakFeed', () => {
  it('subscribes the missing channels and unsubscribes the others on retain', () => {
    feed.retain(['a', 'b']);
    assert.deepEqual(pusher.subscribed, [`${API_KEY}_a`, `${API_KEY}_b`]);
    feed.retain(['b', 'c']);
    assert.deepEqual(pusher.subscribed, [`${API_KEY}_a`, `${API_KEY}_b`, `${API_KEY}_c`]);
    assert.deepEqual(pusher.unsubscribed, [`${API_KEY}_a`]);
    assert.deepEqual(
      entries('pusher_subscribed').map(entry => entry.orderId),
      ['a', 'b', 'c']
    );
    assert.deepEqual(
      entries('pusher_unsubscribed').map(entry => entry.orderId),
      ['a']
    );
  });

  it('adds one channel and keeps the others', () => {
    feed.retain(['a']);
    feed.add('b');
    feed.add('b');
    assert.deepEqual(pusher.subscribed, [`${API_KEY}_a`, `${API_KEY}_b`]);
    assert.deepEqual(pusher.unsubscribed, []);
  });

  it('triggers the order on a Transak event and logs the payload status and amount', () => {
    feed.retain(['a', 'b']);
    pusher.channel('b').emit('ORDER_PROCESSING', { status: 'PROCESSING', cryptoAmount: 9.5, partnerOrderId: 'x' });
    pusher.channel('a').emit('ORDER_FAILED', 'not an object');
    assert.deepEqual(events, ['b', 'a']);
    const logged = entries('pusher_event');
    assert.deepEqual(logged[0], {
      event: 'pusher_event',
      orderId: 'b',
      eventName: 'ORDER_PROCESSING',
      status: 'PROCESSING',
      cryptoAmount: 9.5
    });
    assert.deepEqual(logged[1], { event: 'pusher_event', orderId: 'a', eventName: 'ORDER_FAILED' });
  });

  it('keeps a lenient log when a payload field has an unexpected type', () => {
    feed.retain(['a']);
    pusher.channel('a').emit('ORDER_COMPLETED', { status: 'COMPLETED', cryptoAmount: '10' });
    assert.deepEqual(events, ['a']);
    assert.equal(entries('pusher_event')[0]?.status, 'COMPLETED');
    assert.equal(entries('pusher_event')[0]?.cryptoAmount, undefined);
  });

  it('ignores the Pusher client events', () => {
    feed.retain(['a']);
    pusher.channel('a').emit('pusher:subscription_succeeded', {});
    pusher.channel('a').emit('pusher_internal:subscription_count', {});
    assert.deepEqual(events, []);
    assert.equal(entries('pusher_event').length, 0);
  });

  it('removes the handler before it unsubscribes a channel', () => {
    feed.retain(['a']);
    const channel = pusher.channel('a');
    feed.retain([]);
    channel.emit('ORDER_COMPLETED', {});
    assert.deepEqual(events, []);
    assert.equal(channel.handlers.length, 0);
  });

  it('logs connection state changes', () => {
    for (const handler of pusher.stateHandlers) {
      handler({ previous: 'connecting', current: 'connected' });
      handler('bad');
    }
    assert.deepEqual(
      entries('pusher_connection').map(entry => `${entry.from}->${entry.to}`),
      ['connecting->connected']
    );
  });

  it('unsubscribes all channels and disconnects on close', () => {
    feed.retain(['a', 'b']);
    feed.close();
    assert.deepEqual(pusher.unsubscribed, [`${API_KEY}_a`, `${API_KEY}_b`]);
    assert.equal(pusher.disconnected, true);
  });
});

describe('createPusherClient', () => {
  it('loads the real pusher-js class, which has the methods of PusherLike', () => {
    // The key is a test value. The client connects in the background, so disconnect at once.
    const client = createPusherClient('test-key', 'ap2');
    try {
      assert.equal(typeof client.subscribe, 'function');
      assert.equal(typeof client.unsubscribe, 'function');
      assert.equal(typeof client.connection.bind, 'function');
    } finally {
      client.disconnect();
    }
  });
});
