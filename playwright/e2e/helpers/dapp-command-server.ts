import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import { CellDeadlineExceeded, HarnessFault } from './dapp-cells';
import { ChainUnavailable, type DappChannel } from './dapp-channel';
import { createDappServer, serveTestDappOnLoopback, type DappLabel, type DappServer } from './test-dapp-server';

/**
 * The mobile page's command channel (spec 3.3). The loopback listener that serves the test dApp also answers the routes
 * its command loop uses (test-dapp/command-loop.ts): GET /command, held until a command or the hold ends, POST /result
 * and POST /event. It stays outside the wallet bridge, as the dApp-browser fixture server's report channel does
 * (harness/dapp-fixture-server.ts:31-34), so a bridge bug cannot validate itself.
 */

export type DeviceKey = 'A' | 'B';
/** The two phase-1 origins by host: the wallet keys sessions by origin, so these are two dApps to it. */
export const PAGE_HOSTS: Readonly<Record<DappLabel, string>> = { one: 'localhost', two: '127.0.0.1' };
/**
 * The longest a command is held for an answer: under the mobile provider's 300 s request timeout
 * (injection-script.ts:104-110), so the harness's own verdict is the one recorded.
 */
export const MOBILE_COMMAND_CEILING_MS = 280_000;
const DEFAULT_HOLD_MS = 25_000;
/** How long the page's loop waits after a failed poll: command-loop.ts imports nothing, so its test pins it to this. */
export const PAGE_RETRY_MS = 1_000;
// The longest a polling page goes between polls: that wait, then a second for the round trip.
const PAGE_POLL_GAP_MS = PAGE_RETRY_MS + 1_000;
const ROUTES = new Set(['/command', '/result', '/event']);
const CHARSET_TAG = '<meta charset="utf-8" />';
const TEST_DAPP_TAG = '<script type="module" src="/test-dapp.js"></script>';
const LOOP_TAG = '<script type="module" src="/command-loop.js"></script>';

export interface PageEvent {
  key: string;
  kind: string;
  /** The page's clock. */
  at: number;
  /** This process's clock, the one every driver timestamp uses. */
  receivedAt: number;
  visibility: string;
  data: Record<string, unknown>;
}

export type CommandResult =
  | { status: 'ok'; value: unknown; enqueuedAt: number; deliveredAt: number; receivedAt: number }
  | {
      status: 'error';
      error: { name: string; message: string };
      enqueuedAt: number;
      deliveredAt: number;
      receivedAt: number;
    }
  | { status: 'timeout'; enqueuedAt: number; deliveredAt: number | null };

export interface CommandServerOptions {
  port: number;
  /** Every poll, delivery, answer and event, one JSON line each. */
  logFile: string;
  /** How long an idle poll is held before it is answered 204. */
  holdMs?: number;
  dappServer?: DappServer;
}

export interface CommandServer {
  readonly port: number;
  urlFor(device: DeviceKey, dapp: DappLabel): string;
  send(device: DeviceKey, dapp: DappLabel, command: string, input: unknown, timeoutMs: number): Promise<CommandResult>;
  events(key?: string): PageEvent[];
  waitForEvent(what: string, predicate: (event: PageEvent) => boolean, timeoutMs: number): Promise<PageEvent>;
  stop(): Promise<void>;
}

/**
 * Runs in the page before any module and logs every cross-origin fetch (the SDK's node calls) with the headers the
 * browser kept and when it ended. A clone supplies only a body digest for retry identity; the sent body stays intact.
 */
export const FETCH_LOG_BODY = `
var log = [];
window.__dappFetchLog = log;
var original = window.fetch.bind(window);
window.fetch = function (input, init) {
  var request;
  try {
    request = new Request(input, init);
  } catch (error) {
    return original(input, init);
  }
  if (request.url.indexOf(location.origin + '/') === 0) return original(request);
  var entry = { url: request.url, method: request.method, headers: [], at: Date.now(), status: null, error: null, ms: null,
    completedAt: null, bodyDigest: null };
  var identity = Promise.resolve();
  try {
    identity = request.clone().arrayBuffer().then(function (bytes) {
      return window.crypto.subtle.digest('SHA-256', bytes);
    }).then(function (digest) {
      var bytes = new Uint8Array(digest);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
      entry.bodyDigest = hex;
    }).catch(function () {});
  } catch (error) {}
  request.headers.forEach(function (value, name) {
    entry.headers.push([name, value]);
  });
  log.push(entry);
  // Hashing latency must not change the order in which fetches completed.
  return original(request).then(
    function (response) {
      entry.status = response.status;
      entry.completedAt = Date.now();
      entry.ms = entry.completedAt - entry.at;
      return identity.then(function () { return response; });
    },
    function (error) {
      entry.error = String((error && error.message) || error);
      entry.completedAt = Date.now();
      entry.ms = entry.completedAt - entry.at;
      return identity.then(function () { throw error; });
    }
  );
};
`;

/** The page shell with the fetch log first and the command loop ahead of the test dApp module. */
export function commandShell(html: string): string {
  for (const tag of [CHARSET_TAG, TEST_DAPP_TAG]) {
    if (!html.includes(tag)) throw new Error(`the page shell lacks ${tag}`);
  }
  return html
    .split(CHARSET_TAG)
    .join(`${CHARSET_TAG}\n    <script>(function () {${FETCH_LOG_BODY}})();</script>`)
    .split(TEST_DAPP_TAG)
    .join(`${LOOP_TAG}\n    ${TEST_DAPP_TAG}`);
}

/** `server` with its shell served through `commandShell`; every other path is served as is. */
export function withCommandShell(server: DappServer): DappServer {
  return {
    importMap: server.importMap,
    serve(urlPath) {
      const served = server.serve(urlPath);
      const shell = urlPath === '/' || urlPath === '/index.html';
      return shell && served.status === 200
        ? { ...served, body: Buffer.from(commandShell(served.body.toString('utf8'))) }
        : served;
    }
  };
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
const text = (value: unknown, key: string): string => {
  const found = field(value, key);
  return typeof found === 'string' ? found : '';
};
const count = (value: unknown, key: string): number => {
  const found = field(value, key);
  return typeof found === 'number' ? found : 0;
};
const object = (value: unknown, key: string): Record<string, unknown> => {
  const found = field(value, key);
  return typeof found === 'object' && found !== null ? Object.fromEntries(Object.entries(found)) : {};
};

function keyOf(params: URLSearchParams): string | null {
  const device = params.get('device');
  const dapp = params.get('dapp');
  if ((device !== 'A' && device !== 'B') || (dapp !== 'one' && dapp !== 'two')) return null;
  return `${device}/${dapp}`;
}

function reply(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

interface HeldPoll {
  response: ServerResponse;
  timer: NodeJS.Timeout;
}
interface PendingCommand {
  key: string;
  enqueuedAt: number;
  deliveredAt: number | null;
  settle(result: CommandResult): void;
}

export async function startCommandServer(options: CommandServerOptions): Promise<CommandServer> {
  const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  fs.writeFileSync(options.logFile, '');
  const write = (line: Record<string, unknown>): void =>
    fs.appendFileSync(options.logFile, `${JSON.stringify(line)}\n`);

  const events: PageEvent[] = [];
  const queues = new Map<string, Array<{ id: string; command: string; input: unknown }>>();
  const held = new Map<string, HeldPoll>();
  const pending = new Map<string, PendingCommand>();
  const eventWaiters = new Set<{ predicate: (event: PageEvent) => boolean; resolve: (event: PageEvent) => void }>();
  let nextId = 0;

  const endPoll = (key: string, status: number, body?: unknown): void => {
    const entry = held.get(key);
    if (entry === undefined) return;
    held.delete(key);
    clearTimeout(entry.timer);
    write({ type: 'poll', key, status, at: Date.now() });
    reply(entry.response, status, body);
  };

  const deliver = (key: string): void => {
    if (!held.has(key)) return;
    const next = queues.get(key)?.shift();
    if (next === undefined) return;
    const entry = pending.get(next.id);
    if (entry !== undefined) entry.deliveredAt = Date.now();
    write({ type: 'deliver', key, id: next.id, command: next.command, at: Date.now() });
    endPoll(key, 200, next);
  };

  const holdPoll = (key: string, response: ServerResponse): void => {
    // 409, not the idle 204: a page still waiting on the older poll runs a second loop for the key, and stops it.
    endPoll(key, 409);
    const timer = setTimeout(() => endPoll(key, 204), holdMs);
    held.set(key, { response, timer });
    // A page that went away mid-poll (hidden, suspended, reloaded) must not be handed the next command.
    response.on('close', () => {
      const entry = held.get(key);
      if (entry?.response !== response || response.writableFinished) return;
      held.delete(key);
      clearTimeout(entry.timer);
      write({ type: 'poll', key, status: 'aborted', at: Date.now() });
    });
    deliver(key);
  };

  const acceptResult = (key: string, body: unknown, response: ServerResponse): void => {
    const id = text(body, 'id');
    const entry = pending.get(id);
    if (entry === undefined || entry.key !== key) {
      reply(response, 404, { error: `no pending command ${id} for ${key}` });
      return;
    }
    pending.delete(id);
    const timing = {
      enqueuedAt: entry.enqueuedAt,
      deliveredAt: entry.deliveredAt ?? Date.now(),
      receivedAt: Date.now()
    };
    const error = field(body, 'error');
    const result: CommandResult =
      field(body, 'ok') === true
        ? { status: 'ok', value: field(body, 'value'), ...timing }
        : { status: 'error', error: { name: text(error, 'name'), message: text(error, 'message') }, ...timing };
    write({ type: 'result', key, id, status: result.status, at: timing.receivedAt });
    entry.settle(result);
    reply(response, 204);
  };

  const acceptEvent = (key: string, body: unknown, response: ServerResponse): void => {
    const event: PageEvent = {
      key,
      kind: text(body, 'kind'),
      at: count(body, 'at'),
      receivedAt: Date.now(),
      visibility: text(body, 'visibility'),
      data: object(body, 'data')
    };
    events.push(event);
    write({ type: 'event', ...event });
    for (const waiter of [...eventWaiters]) {
      if (!waiter.predicate(event)) continue;
      eventWaiters.delete(waiter);
      waiter.resolve(event);
    }
    reply(response, 204);
  };

  const routes = (request: IncomingMessage, response: ServerResponse): boolean => {
    const url = new URL(request.url ?? '/', 'http://loopback');
    if (!ROUTES.has(url.pathname)) return false;
    const key = keyOf(url.searchParams);
    if (key === null) {
      reply(response, 400, { error: 'device=A|B and dapp=one|two are required' });
      return true;
    }
    if (url.pathname === '/command') {
      if (request.method === 'GET') holdPoll(key, response);
      else reply(response, 405, { error: 'GET /command only' });
      return true;
    }
    if (request.method !== 'POST') {
      reply(response, 405, { error: `POST ${url.pathname} only` });
      return true;
    }
    readJson(request).then(
      body => (url.pathname === '/result' ? acceptResult(key, body, response) : acceptEvent(key, body, response)),
      (error: unknown) => reply(response, 400, { error: String(error) })
    );
    return true;
  };

  const stopListener = await serveTestDappOnLoopback(
    withCommandShell(options.dappServer ?? createDappServer()),
    options.port,
    routes
  );

  const send = (
    device: DeviceKey,
    dapp: DappLabel,
    command: string,
    input: unknown,
    timeoutMs: number
  ): Promise<CommandResult> =>
    new Promise(resolve => {
      const key = `${device}/${dapp}`;
      nextId += 1;
      const id = `c${nextId}`;
      const enqueuedAt = Date.now();
      const timer = setTimeout(() => {
        const entry = pending.get(id);
        pending.delete(id);
        const queue = queues.get(key) ?? [];
        const index = queue.findIndex(item => item.id === id);
        if (index >= 0) queue.splice(index, 1);
        const result: CommandResult = { status: 'timeout', enqueuedAt, deliveredAt: entry?.deliveredAt ?? null };
        write({ type: 'result', key, id, command, status: 'timeout', at: Date.now() });
        resolve(result);
      }, timeoutMs);
      pending.set(id, {
        key,
        enqueuedAt,
        deliveredAt: null,
        settle: result => {
          clearTimeout(timer);
          resolve(result);
        }
      });
      queues.set(key, [...(queues.get(key) ?? []), { id, command, input }]);
      write({ type: 'enqueue', key, id, command, at: enqueuedAt });
      deliver(key);
    });

  return {
    port: options.port,
    urlFor: (device, dapp) => `http://${PAGE_HOSTS[dapp]}:${options.port}/?device=${device}`,
    send,
    events: key => events.filter(event => key === undefined || event.key === key),
    waitForEvent: (what, predicate, timeoutMs) => {
      const seen = events.find(predicate);
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const waiter = {
          predicate,
          resolve: (event: PageEvent) => {
            clearTimeout(timer);
            resolve(event);
          }
        };
        timer = setTimeout(() => {
          eventWaiters.delete(waiter);
          reject(new Error(`no ${what} event within ${timeoutMs} ms`));
        }, timeoutMs);
        eventWaiters.add(waiter);
      });
    },
    stop: async () => {
      for (const key of [...held.keys()]) endPoll(key, 204);
      for (const entry of [...pending.values()]) {
        entry.settle({ status: 'timeout', enqueuedAt: entry.enqueuedAt, deliveredAt: entry.deliveredAt });
      }
      pending.clear();
      await stopListener();
    }
  };
}

/**
 * The mobile `DappChannel`. A command no page took within the page's poll gap is the channel's fault (the page stopped
 * polling); one the page took and never answered, or one held for less than that gap, is the cell running out of time,
 * as an evaluate that never returns is on the extension (spike plan change 8). Each names the command.
 */
export function commandChannel(server: CommandServer, device: DeviceKey, dapp: DappLabel): DappChannel {
  const label = `${device}/${dapp}`;
  return {
    label,
    send: async (command, input, timeoutMs) => {
      const ms = Math.min(timeoutMs ?? MOBILE_COMMAND_CEILING_MS, MOBILE_COMMAND_CEILING_MS);
      const result = await server.send(device, dapp, command, input, ms);
      if (result.status === 'ok') return result.value;
      if (result.status === 'error') {
        const what = `${result.error.name}: ${result.error.message}`;
        if (result.error.name === 'ChainUnavailableError')
          throw new ChainUnavailable(`dApp ${label} ${command}: ${what}`);
        throw new HarnessFault(`dApp ${label} ${command} threw: ${what}`);
      }
      if (result.deliveredAt === null) {
        if (ms < PAGE_POLL_GAP_MS) {
          throw new CellDeadlineExceeded(
            `dApp ${label} ${command} was not delivered in the ${ms} ms the cell had left, under the page's ` +
              `${PAGE_POLL_GAP_MS} ms poll gap`
          );
        }
        throw new HarnessFault(
          `dApp ${label} ${command} was never delivered within ${ms} ms: the page stopped polling`
        );
      }
      throw new CellDeadlineExceeded(
        `dApp ${label} ${command} was delivered ${result.deliveredAt - result.enqueuedAt} ms after it was sent and ` +
          `not answered within ${ms} ms`
      );
    }
  };
}
