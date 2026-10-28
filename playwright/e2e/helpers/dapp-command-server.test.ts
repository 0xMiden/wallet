/**
 * @jest-environment node
 */
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { CellDeadlineExceeded, deadlineIn, HarnessFault } from './dapp-cells';
import { callOn, ChainUnavailable } from './dapp-channel';
import {
  commandChannel,
  commandShell,
  FETCH_LOG_BODY,
  MOBILE_COMMAND_CEILING_MS,
  startCommandServer,
  type CommandResult,
  type CommandServer
} from './dapp-command-server';
import { createDappServer, resolvePackageRoots } from './test-dapp-server';

// The shell's anchors as test-dapp/index.html carries them.
const SHELL = [
  '<!doctype html><html><head>',
  '<meta charset="utf-8" />',
  '<!-- test-dapp:import-map -->',
  '</head><body>',
  '<script type="module" src="/test-dapp.js"></script>',
  '</body></html>'
].join('\n');

function pageDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dapp-page-'));
  fs.writeFileSync(path.join(dir, 'index.html'), SHELL);
  fs.writeFileSync(path.join(dir, 'sample.ts'), 'export const answer: number = 42;\n');
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))
      );
    });
  });
}

let server: CommandServer | undefined;
let logFile = '';

async function start(holdMs = 2_000): Promise<string> {
  logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dapp-pages-')), 'pages.jsonl');
  server = await startCommandServer({
    port: await freePort(),
    holdMs,
    logFile,
    dappServer: createDappServer({ pageDir: pageDir(), roots: resolvePackageRoots() })
  });
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const poll = (base: string, device: string, dapp: string, signal?: AbortSignal): Promise<Response> =>
  fetch(`${base}/command?device=${device}&dapp=${dapp}`, { signal });
const postResult = (base: string, device: string, dapp: string, body: unknown): Promise<Response> =>
  fetch(`${base}/result?device=${device}&dapp=${dapp}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const idOf = (body: unknown): string => {
  const id = typeof body === 'object' && body !== null ? Reflect.get(body, 'id') : undefined;
  if (typeof id !== 'string') throw new Error(`no command id in ${JSON.stringify(body)}`);
  return id;
};
const live = (): CommandServer => {
  if (server === undefined) throw new Error('no server started');
  return server;
};

// The page's window as the fetch log sees it: the test's fetch, which the log script replaces in place.
interface FakePage {
  crypto: typeof webcrypto;
  fetch: (input: Request | string) => Promise<Response>;
  __dappFetchLog?: unknown;
}

describe('command server', () => {
  it('settles a pending command as HarnessFault after a delayed result-undelivered event', async () => {
    const base = await start();
    const outcome = commandChannel(live(), 'A', 'one')
      .send('session', {})
      .catch((error: unknown) => error);
    const command: unknown = await (await poll(base, 'A', 'one')).json();
    // Coverage instrumentation can delay the event by more than a second along the HTTP path.
    await pause(1_100);
    await fetch(`${base}/event?device=A&dapp=one`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'result-undelivered', data: { id: idOf(command) } })
    });
    await expect(outcome).resolves.toBeInstanceOf(HarnessFault);
    await expect(outcome).resolves.toHaveProperty('message', expect.stringContaining('result could not be delivered'));
  });

  it('ignores stale, unknown and wrong-key undelivered-result events', async () => {
    const base = await start();
    const completed = live().send('A', 'one', 'session', {}, 2_000);
    const stale = idOf(await (await poll(base, 'A', 'one')).json());
    await postResult(base, 'A', 'one', { id: stale, ok: true, value: 1 });
    await completed;
    let settled = false;
    const pending = live()
      .send('A', 'one', 'session', {}, 2_000)
      .then(result => {
        settled = true;
        return result;
      });
    const id = idOf(await (await poll(base, 'A', 'one')).json());
    for (const [key, eventId] of [
      ['device=A&dapp=one', stale],
      ['device=A&dapp=one', 'unknown'],
      ['device=B&dapp=one', id],
      ['device=A&dapp=two', id]
    ]) {
      await fetch(`${base}/event?${key}`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'result-undelivered', data: { id: eventId } })
      });
    }
    expect(settled).toBe(false);
    await postResult(base, 'A', 'one', { id, ok: true, value: 2 });
    await expect(pending).resolves.toMatchObject({ status: 'ok', value: 2 });
  });

  it('delivers a command only to the poll of its own device and dApp, and returns the page answer', async () => {
    const base = await start(300);
    const result = live().send('A', 'one', 'session', {}, 5_000);
    expect((await poll(base, 'B', 'one')).status).toBe(204);
    const mine = await poll(base, 'A', 'one');
    expect(mine.status).toBe(200);
    const command: unknown = await mine.json();
    expect(command).toEqual({ id: expect.any(String), command: 'session', input: {} });
    expect(
      (await postResult(base, 'A', 'one', { id: idOf(command), ok: true, value: { adapterAddress: null } })).status
    ).toBe(204);
    await expect(result).resolves.toMatchObject({
      status: 'ok',
      value: { adapterAddress: null },
      deliveredAt: expect.any(Number)
    });
  });

  it('answers an idle poll with 204 once the hold ends', async () => {
    const base = await start(200);
    const startedAt = Date.now();
    expect((await poll(base, 'A', 'one')).status).toBe(204);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
  });

  it('keeps a command for the next poll when the page abandoned the held one', async () => {
    const base = await start(2_000);
    const abort = new AbortController();
    const abandoned = poll(base, 'A', 'one', abort.signal).catch((error: unknown) => error);
    await pause(100);
    abort.abort();
    await abandoned;
    await pause(100);
    const result = live().send('A', 'one', 'session', {}, 5_000);
    const next = await poll(base, 'A', 'one');
    expect(next.status).toBe(200);
    await postResult(base, 'A', 'one', { id: idOf(await next.json()), ok: true, value: 1 });
    await expect(result).resolves.toMatchObject({ status: 'ok', value: 1 });
  });

  it('answers the older of two held polls 409 and delivers to the newer', async () => {
    const base = await start(3_000);
    const older = poll(base, 'A', 'one');
    await pause(100);
    const newer = poll(base, 'A', 'one');
    expect((await older).status).toBe(409);
    const result = live().send('A', 'one', 'session', {}, 5_000);
    const delivered = await newer;
    expect(delivered.status).toBe(200);
    await postResult(base, 'A', 'one', { id: idOf(await delivered.json()), ok: true, value: 2 });
    await expect(result).resolves.toMatchObject({ status: 'ok', value: 2 });
  });

  it('reports a command the page took and never answered as a timeout with its delivery time', async () => {
    const base = await start(2_000);
    const result = live().send('A', 'one', 'syncHeight', {}, 300);
    expect((await poll(base, 'A', 'one')).status).toBe(200);
    await expect(result).resolves.toMatchObject({ status: 'timeout', deliveredAt: expect.any(Number) });
  });

  it('reports a command no page took as a timeout with no delivery time', async () => {
    await start(2_000);
    await expect(live().send('A', 'one', 'session', {}, 300)).resolves.toEqual({
      status: 'timeout',
      enqueuedAt: expect.any(Number),
      deliveredAt: null
    });
  });

  it('refuses a result for a command it does not hold, and a poll that names no device', async () => {
    const base = await start();
    expect((await postResult(base, 'A', 'one', { id: 'c999', ok: true, value: null })).status).toBe(404);
    expect((await fetch(`${base}/command?dapp=one`)).status).toBe(400);
  });

  it('records page events with their key and logs them', async () => {
    const base = await start();
    const response = await fetch(`${base}/event?device=B&dapp=two`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'boot', at: 5, visibility: 'visible', data: { origin: 'http://127.0.0.1:4810' } })
    });
    expect(response.status).toBe(204);
    await expect(live().waitForEvent('boot', event => event.kind === 'boot', 1_000)).resolves.toMatchObject({
      key: 'B/two',
      at: 5,
      data: { origin: 'http://127.0.0.1:4810' }
    });
    expect(fs.readFileSync(logFile, 'utf8')).toContain('"kind":"boot"');
  });

  it('serves the shell with the fetch log first and the loop ahead of the test dApp, both never cached', async () => {
    const base = await start();
    const response = await fetch(`${base}/?device=A`);
    const html = await response.text();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(html.indexOf('__dappFetchLog')).toBeGreaterThan(-1);
    expect(html.indexOf('__dappFetchLog')).toBeLessThan(html.indexOf('type="importmap"'));
    expect(html.indexOf('/command-loop.js')).toBeGreaterThan(-1);
    expect(html.indexOf('/command-loop.js')).toBeLessThan(html.indexOf('/test-dapp.js'));
    expect(html).toContain('/npm/@miden-sdk/miden-sdk/dist/st/eager.js');
    expect((await fetch(`${base}/sample.js`)).headers.get('cache-control')).toBe('no-store');
    expect(
      (await fetch(`${base}/npm/eventemitter3/dist/eventemitter3.esm.js`)).headers.get('cache-control')
    ).toBeNull();
  });

  it('refuses a shell that lacks the anchors the fetch log and the loop go in', () => {
    expect(() => commandShell('<html></html>')).toThrow('the page shell lacks <meta charset="utf-8" />');
  });

  it('serves the command loop as a page module that parses', () => {
    expect(createDappServer({ roots: resolvePackageRoots() }).serve('/command-loop.js').status).toBe(200);
  });

  it('logs a cross-origin request without consuming the body the SDK sends', async () => {
    const sent: Request[] = [];
    const page: FakePage = {
      crypto: webcrypto,
      fetch: input => {
        sent.push(typeof input === 'string' ? new Request(input) : input);
        return Promise.resolve(new Response('ok', { status: 200 }));
      }
    };
    // eslint-disable-next-line no-new-func
    new Function('window', 'location', FETCH_LOG_BODY)(page, { origin: 'http://localhost:4810' });
    const request = new Request('https://rpc.testnet.miden.io/rpc.Api/SyncChainMmr', {
      method: 'POST',
      headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
      body: new Uint8Array([1, 2, 3])
    });
    expect((await page.fetch(request)).status).toBe(200);
    expect(Array.from(new Uint8Array(await (sent[0] ?? new Request('http://x')).arrayBuffer()))).toEqual([1, 2, 3]);
    expect(page.__dappFetchLog).toEqual([
      expect.objectContaining({
        url: 'https://rpc.testnet.miden.io/rpc.Api/SyncChainMmr',
        method: 'POST',
        completedAt: expect.any(Number),
        bodyDigest: createHash('sha256')
          .update(new Uint8Array([1, 2, 3]))
          .digest('hex'),
        status: 200,
        error: null,
        headers: expect.arrayContaining([
          ['content-type', 'application/grpc-web+proto'],
          ['x-grpc-web', '1']
        ])
      })
    ]);
  });

  it('records response completion order and distinct body digests without storing request bytes', async () => {
    let now = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const replies: Array<(response: Response) => void> = [];
    const firstResponse = new Promise<Response>(resolve => replies.push(resolve));
    const secondResponse = new Promise<Response>(resolve => replies.push(resolve));
    let calls = 0;
    const page: FakePage = {
      crypto: webcrypto,
      fetch: () => {
        calls++;
        return calls === 1 ? firstResponse : secondResponse;
      }
    };
    try {
      // eslint-disable-next-line no-new-func
      new Function('window', 'location', FETCH_LOG_BODY)(page, { origin: 'http://localhost:4810' });
      const request = (body: string): Request =>
        new Request('https://rpc.testnet.miden.io/rpc', { method: 'POST', body });
      const a = page.fetch(request('request-a'));
      now = 10;
      const b = page.fetch(request('request-b'));
      const [first, second] = replies;
      if (first === undefined || second === undefined) throw new Error('response resolvers missing');
      now = 20;
      second(new Response('ok', { status: 200 }));
      await b;
      now = 100;
      first(new Response('unavailable', { status: 503 }));
      await a;
      expect(page.__dappFetchLog).toEqual([
        {
          url: 'https://rpc.testnet.miden.io/rpc',
          method: 'POST',
          headers: [['content-type', 'text/plain;charset=UTF-8']],
          at: 0,
          completedAt: 100,
          ms: 100,
          status: 503,
          error: null,
          bodyDigest: createHash('sha256').update('request-a').digest('hex')
        },
        {
          url: 'https://rpc.testnet.miden.io/rpc',
          method: 'POST',
          headers: [['content-type', 'text/plain;charset=UTF-8']],
          at: 10,
          completedAt: 20,
          ms: 10,
          status: 200,
          error: null,
          bodyDigest: createHash('sha256').update('request-b').digest('hex')
        }
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it('records a rejected fetch completion and preserves its rejection', async () => {
    const failure = new Error('connection reset');
    const page: FakePage = {
      crypto: webcrypto,
      fetch: async () => {
        throw failure;
      }
    };
    // eslint-disable-next-line no-new-func
    new Function('window', 'location', FETCH_LOG_BODY)(page, { origin: 'http://localhost:4810' });
    await expect(
      page.fetch(new Request('https://rpc.testnet.miden.io/rpc', { method: 'POST', body: 'request' }))
    ).rejects.toBe(failure);
    expect(page.__dappFetchLog).toEqual([
      expect.objectContaining({
        completedAt: expect.any(Number),
        status: null,
        error: 'connection reset',
        bodyDigest: createHash('sha256').update('request').digest('hex')
      })
    ]);
  });

  it('passes a same-origin request through without logging it', async () => {
    const sent: Request[] = [];
    const page: FakePage = {
      crypto: webcrypto,
      fetch: input => {
        sent.push(typeof input === 'string' ? new Request(input) : input);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
    };
    // eslint-disable-next-line no-new-func
    new Function('window', 'location', FETCH_LOG_BODY)(page, { origin: 'http://localhost:4810' });
    await page.fetch('http://localhost:4810/command?device=A&dapp=one');
    expect(sent[0]?.url).toBe('http://localhost:4810/command?device=A&dapp=one');
    expect(page.__dappFetchLog).toEqual([]);
  });
});

describe('the command channel', () => {
  // A server stand-in that answers every send with `result` and records the time it was given.
  function serverAnswering(result: CommandResult): { fake: CommandServer; given: number[] } {
    const given: number[] = [];
    const fake: CommandServer = {
      port: 0,
      urlFor: () => '',
      send: async (_device, _dapp, _command, _input, timeoutMs) => {
        given.push(timeoutMs);
        return result;
      },
      events: () => [],
      waitForEvent: () => Promise.reject(new Error('unused')),
      stop: async () => undefined
    };
    return { fake, given };
  }
  const answered = { enqueuedAt: 1, deliveredAt: 2, receivedAt: 3 };

  it('returns the value the page answered', async () => {
    const { fake } = serverAnswering({ status: 'ok', value: { height: 9 }, ...answered });
    await expect(commandChannel(fake, 'A', 'one').send('syncHeight', {}, 1_000)).resolves.toEqual({ height: 9 });
  });

  it('maps a node failure the page reports to ChainUnavailable', async () => {
    const { fake } = serverAnswering({
      status: 'error',
      error: { name: 'ChainUnavailableError', message: 'syncChain: TypeError: Failed to fetch' },
      ...answered
    });
    await expect(commandChannel(fake, 'A', 'one').send('syncHeight', {}, 1_000)).rejects.toBeInstanceOf(
      ChainUnavailable
    );
  });

  it('maps any other page error to a harness fault', async () => {
    const { fake } = serverAnswering({
      status: 'error',
      error: { name: 'HarnessCheckError', message: 'request self-check failed: x' },
      ...answered
    });
    await expect(commandChannel(fake, 'A', 'one').send('buildCustom', {}, 1_000)).rejects.toBeInstanceOf(HarnessFault);
  });

  it('reads a command no page took as a harness fault naming it', async () => {
    const { fake } = serverAnswering({ status: 'timeout', enqueuedAt: 1, deliveredAt: null });
    const sent = commandChannel(fake, 'B', 'one').send('session', {}, 5_000);
    await expect(sent).rejects.toBeInstanceOf(HarnessFault);
    await expect(sent).rejects.toThrow('dApp B/one session was never delivered within 5000 ms');
  });

  it('reads a command the page took and never answered as the cell running out of time', async () => {
    const { fake } = serverAnswering({ status: 'timeout', enqueuedAt: 1, deliveredAt: 5 });
    const sent = commandChannel(fake, 'A', 'one').send('connect', {}, 900);
    await expect(sent).rejects.toBeInstanceOf(CellDeadlineExceeded);
    await expect(sent).rejects.toThrow('dApp A/one connect was delivered 4 ms after it was sent');
  });

  it('never holds a command past the ceiling under the provider timeout', async () => {
    const { fake, given } = serverAnswering({ status: 'ok', value: null, ...answered });
    const channel = commandChannel(fake, 'A', 'one');
    await channel.send('session', {});
    await channel.send('session', {}, 400_000);
    expect(given).toEqual([MOBILE_COMMAND_CEILING_MS, MOBILE_COMMAND_CEILING_MS]);
    expect(MOBILE_COMMAND_CEILING_MS).toBeLessThan(300_000);
  });

  it('hands the server 1 ms, never a negative hold, when the cell deadline leaves less than the channel margin', async () => {
    const { fake, given } = serverAnswering({ status: 'ok', value: null, ...answered });
    await callOn(commandChannel(fake, 'A', 'one'), 'session', {}, deadlineIn(500, 'cell'));
    expect(given).toEqual([1]);
  });

  it('reads a command no page took while the cell had less than the page poll gap left as the cell running out of time', async () => {
    const { fake } = serverAnswering({ status: 'timeout', enqueuedAt: 1, deliveredAt: null });
    const asked = callOn(commandChannel(fake, 'A', 'one'), 'session', {}, deadlineIn(500, 'cell'));
    await expect(asked).rejects.toBeInstanceOf(CellDeadlineExceeded);
    await expect(asked).rejects.toThrow('dApp A/one session was not delivered in the 1 ms the cell had left');
  });
});
