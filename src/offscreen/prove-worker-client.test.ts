/**
 * The offscreen document's prove worker client (#945), driven against a fake worker
 * the spawn seam hands out. Every retirement path is checked for its effect on the
 * call in flight and on the calls queued behind it.
 */
import { ProveWorkerError } from 'lib/miden/sdk/local-prove-transport';

import { PROVE_WORKER_IDLE_MS, PROVE_WORKER_READY_TIMEOUT_MS, ProveWorkerClient } from './prove-worker-client';

class FakeWorker extends EventTarget {
  readonly posted: Array<{ message: unknown; transfer: Transferable[] }> = [];
  terminated = 0;

  postMessage(message: unknown, transfer: Transferable[]): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated++;
  }

  emit(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  ready(threads = 6): void {
    this.emit({ type: 'ready', threads, crossOriginIsolated: true });
  }

  succeed(id: number, proven = new Uint8Array([9, 9]), durationMs = 1234): void {
    this.emit({ type: 'result', id, ok: true, proven, durationMs });
  }

  emitError(message = 'Uncaught RuntimeError: unreachable'): ErrorEvent {
    const event = new ErrorEvent('error', { message, cancelable: true });
    this.dispatchEvent(event);
    return event;
  }

  /** A worker script that fails to load fires a plain `Event`, not an `ErrorEvent`. */
  emitLoadFailure(): Event {
    const event = new Event('error', { cancelable: true });
    this.dispatchEvent(event);
    return event;
  }
}

const mockWorkers: FakeWorker[] = [];
function spawnFakeWorker(): FakeWorker {
  const worker = new FakeWorker();
  mockWorkers.push(worker);
  return worker;
}
const mockSpawn = jest.fn(spawnFakeWorker);

jest.mock('./spawn-prove-worker', () => ({ spawnProveWorker: () => mockSpawn() }));

const request = (bytes = [1, 2, 3]) => ({ txResult: new Uint8Array(bytes), proverDescriptor: 'local' });

function worker(index: number): FakeWorker {
  const found = mockWorkers[index];
  if (!found) throw new Error(`no worker #${index} was spawned`);
  return found;
}

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

/** Attach a handler now so a rejection the test drives later is never unhandled. */
function outcome(promise: Promise<unknown>): Promise<{ ok: boolean; value: unknown }> {
  return promise.then(
    value => ({ ok: true, value }),
    value => ({ ok: false, value })
  );
}

beforeEach(() => {
  mockWorkers.length = 0;
  // `mockClear()` alone leaves a `mockImplementationOnce` queued by a test whose
  // mutated code never consumed it (e.g. a mutant that stops pumping before its
  // respawn) sitting for the NEXT test's first spawn call - `mockReset()` drops that
  // queue too, so a spawn-throw test can never leak its once-implementation forward.
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(spawnFakeWorker);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ProveWorkerClient spawn', () => {
  it('spawns nothing until the first prove or prewarm', () => {
    new ProveWorkerClient();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('prewarm spawns without posting, and a second prewarm reuses the worker', () => {
    const client = new ProveWorkerClient();
    client.prewarm();
    client.prewarm();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(worker(0).posted).toEqual([]);
  });

  it('rejects a non-local descriptor as unsupported-prover without spawning or posting', async () => {
    const client = new ProveWorkerClient();
    const result = await outcome(client.prove({ txResult: new Uint8Array([1]), proverDescriptor: 'remote|x' }));
    expect(result.ok).toBe(false);
    expect(result.value).toBeInstanceOf(ProveWorkerError);
    expect(result.value).toMatchObject({ kind: 'unsupported-prover' });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('retires a prewarmed worker whose boot fails, and the next prove spawns a fresh one', async () => {
    const client = new ProveWorkerClient();
    client.prewarm();
    worker(0).emit({ type: 'init-failed', reason: 'not-cross-origin-isolated', message: 'no isolation' });
    expect(worker(0).terminated).toBe(1);

    void client.prove(request());
    await flush();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('fails a prove whose spawn throws as spawn-failed, and the next prove spawns again', async () => {
    mockSpawn.mockImplementationOnce(() => {
      // A thrown non-Error still reaches `detail` as text.
      // eslint-disable-next-line no-throw-literal
      throw 'blocked by CSP';
    });
    const client = new ProveWorkerClient();
    const first = await outcome(client.prove(request()));
    expect(first.value).toMatchObject({ kind: 'spawn-failed', detail: 'blocked by CSP' });

    const second = outcome(client.prove(request()));
    await flush();
    worker(0).ready();
    worker(0).succeed(2);
    expect((await second).ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

describe('ProveWorkerClient proving', () => {
  it('fails only the next call when the respawn after a crash throws; the one behind it spawns again', async () => {
    const client = new ProveWorkerClient();
    const a = outcome(client.prove(request([1])));
    const b = outcome(client.prove(request([2])));
    const c = outcome(client.prove(request([3])));
    await flush();
    worker(0).ready();
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('blocked by CSP');
    });
    worker(0).emitError();
    expect((await a).value).toMatchObject({ kind: 'crashed' });
    expect((await b).value).toMatchObject({ kind: 'spawn-failed', detail: 'blocked by CSP' });

    await flush();
    worker(1).ready();
    worker(1).succeed(3);
    expect((await c).ok).toBe(true);
  });

  it('waits for ready, then posts the bytes with their buffer in the transfer list', async () => {
    const client = new ProveWorkerClient();
    const bytes = new Uint8Array([4, 5, 6]);
    void client.prove({ txResult: bytes, proverDescriptor: 'local' });
    await flush();
    expect(worker(0).posted).toEqual([]);

    worker(0).ready();
    expect(worker(0).posted).toEqual([
      { message: { type: 'prove', id: 1, txResult: bytes, proverDescriptor: 'local' }, transfer: [bytes.buffer] }
    ]);
  });

  it('resolves with the proof bytes and the duration the worker measured', async () => {
    const client = new ProveWorkerClient();
    const proving = client.prove(request());
    await flush();
    worker(0).ready();
    const proven = new Uint8Array([7, 7, 7]);
    worker(0).succeed(1, proven, 4321);
    await expect(proving).resolves.toEqual({ proven, durationMs: 4321 });
    expect(worker(0).terminated).toBe(0);
  });

  it('keeps one prove in flight and posts the next only when the first settles', async () => {
    const client = new ProveWorkerClient();
    const first = client.prove(request([1]));
    await flush();
    worker(0).ready();
    const second = client.prove(request([2]));
    await flush();
    expect(worker(0).posted).toHaveLength(1);

    worker(0).succeed(1);
    await first;
    expect(worker(0).posted).toHaveLength(2);
    expect(worker(0).posted[1]?.message).toMatchObject({ id: 2 });
    worker(0).succeed(2);
    await second;
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('copies a view into a larger buffer instead of transferring memory the caller owns', async () => {
    const client = new ProveWorkerClient();
    const backing = new Uint8Array([0, 1, 2, 3, 0]);
    void client.prove({ txResult: backing.subarray(1, 4), proverDescriptor: 'local' });
    await flush();
    worker(0).ready();
    const [posted] = worker(0).posted;
    expect(posted?.message).toMatchObject({ txResult: new Uint8Array([1, 2, 3]) });
    expect(posted?.transfer[0]).not.toBe(backing.buffer);
    expect(backing.byteLength).toBe(5);
  });
});

describe('ProveWorkerClient retirement', () => {
  /** Resolves once the prove is posted; `proving` settles with the prove itself. */
  async function inFlight(client: ProveWorkerClient) {
    const proving = outcome(client.prove(request()));
    await flush();
    worker(0).ready();
    return { proving };
  }

  it('retires and rejects init-timeout when ready never comes within 30 s', async () => {
    jest.useFakeTimers();
    const client = new ProveWorkerClient();
    const proving = outcome(client.prove(request()));
    await flush();
    await jest.advanceTimersByTimeAsync(PROVE_WORKER_READY_TIMEOUT_MS - 1);
    expect(worker(0).terminated).toBe(0);

    await jest.advanceTimersByTimeAsync(1);
    expect(worker(0).terminated).toBe(1);
    expect((await proving).value).toMatchObject({ kind: 'init-timeout' });
  });

  it('retires and rejects init-failed, keeping the reason on detail', async () => {
    const client = new ProveWorkerClient();
    const proving = outcome(client.prove(request()));
    await flush();
    worker(0).emit({ type: 'init-failed', reason: 'wasm-load', message: 'fetch failed' });
    expect(worker(0).terminated).toBe(1);
    expect((await proving).value).toMatchObject({ kind: 'init-failed', detail: 'wasm-load: fetch failed' });
  });

  it('prevents a worker error event, retires, and rejects crashed', async () => {
    const client = new ProveWorkerClient();
    const { proving } = await inFlight(client);
    const event = worker(0).emitError();
    expect(event.defaultPrevented).toBe(true);
    expect(worker(0).terminated).toBe(1);
    expect((await proving).value).toMatchObject({ kind: 'crashed' });
  });

  it('treats a plain Event on error (a worker script load failure) as crashed with fixed detail', async () => {
    const client = new ProveWorkerClient();
    const { proving } = await inFlight(client);
    const event = worker(0).emitLoadFailure();
    expect(event.defaultPrevented).toBe(true);
    expect(worker(0).terminated).toBe(1);
    expect((await proving).value).toMatchObject({ kind: 'crashed', detail: 'the prove worker failed to load' });
  });

  it('retires and rejects crashed on a messageerror', async () => {
    const client = new ProveWorkerClient();
    const { proving } = await inFlight(client);
    worker(0).dispatchEvent(new MessageEvent('messageerror'));
    expect(worker(0).terminated).toBe(1);
    expect((await proving).value).toMatchObject({ kind: 'crashed', detail: 'messageerror' });
  });

  it('retires and rejects prove-failed on an ok:false result', async () => {
    const client = new ProveWorkerClient();
    const { proving } = await inFlight(client);
    worker(0).emit({ type: 'result', id: 1, ok: false, message: 'RuntimeError: unreachable' });
    expect(worker(0).terminated).toBe(1);
    expect((await proving).value).toMatchObject({ kind: 'prove-failed', detail: 'RuntimeError: unreachable' });
  });

  it('never puts the worker text in the error message, so it cannot look like a WASM trap', async () => {
    const client = new ProveWorkerClient();
    const { proving } = await inFlight(client);
    worker(0).emit({ type: 'result', id: 1, ok: false, message: 'RuntimeError: unreachable' });
    const { value } = await proving;
    expect(value).toBeInstanceOf(ProveWorkerError);
    expect(value).toHaveProperty('message', 'Local prove failed in the prove worker (prove-failed)');
  });

  it('retires as crashed on a message it cannot parse, or a result for another id', async () => {
    const client = new ProveWorkerClient();
    const { proving: first } = await inFlight(client);
    worker(0).emit({ type: 'progress' });
    expect((await first).value).toMatchObject({ kind: 'crashed' });

    const second = outcome(client.prove(request()));
    await flush();
    worker(1).ready();
    worker(1).succeed(99);
    expect((await second).value).toMatchObject({ kind: 'crashed', detail: 'result for unexpected id 99' });
  });

  it('retires as crashed when posting throws', async () => {
    const client = new ProveWorkerClient();
    const proving = outcome(client.prove(request()));
    await flush();
    jest.spyOn(worker(0), 'postMessage').mockImplementation(() => {
      throw new Error('DataCloneError');
    });
    worker(0).ready();
    expect((await proving).value).toMatchObject({ kind: 'crashed', detail: 'DataCloneError' });
  });

  it('a cancel mid-prove terminates the worker and rejects with the cancel reason', async () => {
    const client = new ProveWorkerClient();
    let evict!: (reason: unknown) => void;
    const cancel = new Promise<never>((_resolve, reject) => {
      evict = reject;
    });
    const proving = outcome(client.prove(request(), { cancel }));
    await flush();
    worker(0).ready();
    expect(worker(0).posted).toHaveLength(1);

    const eviction = new Error('evicted');
    evict(eviction);
    await flush();
    expect(worker(0).terminated).toBe(1);
    expect((await proving).value).toBe(eviction);
  });

  it('ignores a cancel that rejects after its prove resolved, so later proves keep the worker', async () => {
    const client = new ProveWorkerClient();
    let evict!: (reason: unknown) => void;
    const cancel = new Promise<never>((_resolve, reject) => {
      evict = reject;
    });
    const first = client.prove(request([1]), { cancel });
    await flush();
    worker(0).ready();
    worker(0).succeed(1);
    await first;
    const second = outcome(client.prove(request([2])));
    const third = outcome(client.prove(request([3])));
    await flush();

    evict(new Error('evicted after the prove'));
    await flush();
    expect(worker(0).terminated).toBe(0);
    worker(0).succeed(2);
    await flush();
    // Pins the no-op: without it, `cancel()` would splice a live, unrelated queue
    // entry (here, the still-queued `third`) out from under it, and `third` would
    // never be posted at all - failing this the moment it can, instead of `await
    // third` below hanging to the jest timeout.
    expect(worker(0).posted).toHaveLength(3);
    worker(0).succeed(3);
    expect((await second).ok).toBe(true);
    expect((await third).ok).toBe(true);
  });

  it('never posts a call whose cancel had already rejected', async () => {
    const client = new ProveWorkerClient();
    client.prewarm();
    worker(0).ready();
    const eviction = new Error('evicted before the prove');
    const cancel = Promise.reject<never>(eviction);
    const result = await outcome(client.prove(request(), { cancel }));
    expect(result.value).toBe(eviction);
    expect(worker(0).posted).toEqual([]);
    // The cancelled call was the FIFO head, unposted - not because the prewarmed
    // worker's `ready` hadn't fired yet (it already had, above), but because the
    // cancel handler is registered before `schedulePump()`, so its microtask runs
    // first and retires the worker before `pump()` ever gets a turn to post.
    expect(worker(0).terminated).toBe(1);
  });

  it('drops a queued call whose cancel rejects, leaving the call in flight alone', async () => {
    const client = new ProveWorkerClient();
    const first = outcome(client.prove(request([1])));
    let evict!: (reason: unknown) => void;
    const cancel = new Promise<never>((_resolve, reject) => {
      evict = reject;
    });
    const second = outcome(client.prove(request([2]), { cancel }));
    await flush();
    worker(0).ready();
    evict(new Error('evicted while queued'));
    await flush();
    expect((await second).ok).toBe(false);
    expect(worker(0).terminated).toBe(0);

    worker(0).succeed(1);
    expect((await first).ok).toBe(true);
    expect(worker(0).posted).toHaveLength(1);
  });

  it('keeps a queued call through the retirement ahead of it and runs it on a fresh worker', async () => {
    const client = new ProveWorkerClient();
    const first = outcome(client.prove(request([1])));
    const second = outcome(client.prove(request([2])));
    await flush();
    worker(0).ready();
    worker(0).emitError();
    expect((await first).value).toMatchObject({ kind: 'crashed' });

    await flush();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    worker(1).ready();
    expect(worker(1).posted[0]?.message).toMatchObject({ id: 2 });
    worker(1).succeed(2);
    expect((await second).ok).toBe(true);
  });

  it('still prevents an error from a worker it already retired, and ignores its late messages', async () => {
    const client = new ProveWorkerClient();
    const { proving: first } = await inFlight(client);
    worker(0).emit({ type: 'result', id: 1, ok: false, message: 'boom' });
    await first;
    const second = outcome(client.prove(request()));
    await flush();

    const late = worker(0).emitError();
    worker(0).succeed(2);
    expect(late.defaultPrevented).toBe(true);
    worker(1).ready();
    worker(1).succeed(2, new Uint8Array([5]));
    expect(await second).toEqual({ ok: true, value: { proven: new Uint8Array([5]), durationMs: 1234 } });
  });

  it('retires an idle worker after 60 s, and a prove inside the window keeps it', async () => {
    jest.useFakeTimers();
    const client = new ProveWorkerClient();
    const first = client.prove(request());
    await jest.advanceTimersByTimeAsync(0);
    worker(0).ready();
    worker(0).succeed(1);
    await first;

    await jest.advanceTimersByTimeAsync(PROVE_WORKER_IDLE_MS - 1);
    const second = client.prove(request());
    // Past the first idle deadline with the second prove still in flight.
    await jest.advanceTimersByTimeAsync(2);
    expect(worker(0).terminated).toBe(0);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    worker(0).succeed(2);
    await second;

    await jest.advanceTimersByTimeAsync(PROVE_WORKER_IDLE_MS);
    expect(worker(0).terminated).toBe(1);
  });

  it('retires a prewarmed worker that no prove ever reaches', async () => {
    jest.useFakeTimers();
    const client = new ProveWorkerClient();
    client.prewarm();
    worker(0).ready();
    await jest.advanceTimersByTimeAsync(PROVE_WORKER_IDLE_MS);
    expect(worker(0).terminated).toBe(1);
  });
});

describe('ProveWorkerClient E2E markers', () => {
  const realFlag = process.env.MIDEN_E2E_TEST;
  afterEach(() => {
    process.env.MIDEN_E2E_TEST = realFlag;
  });

  it('records spawn, ready, post, result and retirement as prove-timing markers', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation(() => {});
    let Client: typeof ProveWorkerClient | undefined;
    jest.isolateModules(() => {
      jest.doMock('lib/miden/sdk/prove-telemetry', () => ({ recordProveMarker: (line: string) => lines.push(line) }));
      ({ ProveWorkerClient: Client } =
        jest.requireActual<typeof import('./prove-worker-client')>('./prove-worker-client'));
    });
    if (!Client) throw new Error('the client module did not load');
    const client = new Client();
    const proving = outcome(client.prove(request()));
    await flush();
    worker(0).ready(6);
    worker(0).emit({ type: 'result', id: 1, ok: false, message: 'boom' });
    await proving;

    expect(lines).toEqual([
      '[prove-timing] prove-worker spawned',
      expect.stringMatching(/^\[prove-timing\] prove-worker ready threads=6 coi=true ms=\d+$/),
      '[prove-timing] prove-worker posted id=1 bytes=3',
      '[prove-timing] prove-worker result id=1 ok=false detail=boom',
      '[prove-timing] prove-worker retired reason=prove-failed detail=boom'
    ]);
  });

  // #945: `ProveWorkerError.detail` used to be written and never read, so the
  // prover's real failure text reached nothing a developer could see - these two
  // markers are this realm's only debug channel. A detail spanning several lines
  // (a worker stack trace) would otherwise break the marker parser's one-line
  // format, so it is flattened before either marker is written.
  it('flattens a multi-line prove failure detail to one line on both markers', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation(() => {});
    let Client: typeof ProveWorkerClient | undefined;
    jest.isolateModules(() => {
      jest.doMock('lib/miden/sdk/prove-telemetry', () => ({ recordProveMarker: (line: string) => lines.push(line) }));
      ({ ProveWorkerClient: Client } =
        jest.requireActual<typeof import('./prove-worker-client')>('./prove-worker-client'));
    });
    if (!Client) throw new Error('the client module did not load');
    const client = new Client();
    const proving = outcome(client.prove(request()));
    await flush();
    worker(0).ready(6);
    worker(0).emit({ type: 'result', id: 1, ok: false, message: 'RuntimeError: unreachable\nsecond line' });
    await proving;

    expect(lines).toEqual([
      '[prove-timing] prove-worker spawned',
      expect.stringMatching(/^\[prove-timing\] prove-worker ready threads=6 coi=true ms=\d+$/),
      '[prove-timing] prove-worker posted id=1 bytes=3',
      '[prove-timing] prove-worker result id=1 ok=false detail=RuntimeError: unreachable second line',
      '[prove-timing] prove-worker retired reason=prove-failed detail=RuntimeError: unreachable second line'
    ]);
  });

  it('records the ok=true result marker with its measured duration', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation(() => {});
    let Client: typeof ProveWorkerClient | undefined;
    jest.isolateModules(() => {
      jest.doMock('lib/miden/sdk/prove-telemetry', () => ({ recordProveMarker: (line: string) => lines.push(line) }));
      ({ ProveWorkerClient: Client } =
        jest.requireActual<typeof import('./prove-worker-client')>('./prove-worker-client'));
    });
    if (!Client) throw new Error('the client module did not load');
    const client = new Client();
    const proving = client.prove(request());
    await flush();
    worker(0).ready(6);
    worker(0).succeed(1, new Uint8Array([9, 9]), 4321);
    await proving;

    expect(lines).toEqual([
      '[prove-timing] prove-worker spawned',
      expect.stringMatching(/^\[prove-timing\] prove-worker ready threads=6 coi=true ms=\d+$/),
      '[prove-timing] prove-worker posted id=1 bytes=3',
      '[prove-timing] prove-worker result id=1 ok=true ms=4321'
    ]);
  });
});
