// The offscreen document's side of the prove worker (#945): spawns it lazily, keeps
// one prove in flight at a time, and retires the worker (terminate, drop, next call
// spawns fresh) on any failure or after a minute idle. WASM memory only grows, so
// retiring is the only way the prove peak is ever handed back.
//
// Every worker-side fact is recorded here, in the document: the worker has no
// `chrome.runtime`, so it can neither relay a marker nor report telemetry.

import {
  type LocalProveOptions,
  type LocalProveRequest,
  type LocalProveResult,
  type LocalProveTransport,
  ProveWorkerError,
  type ProveWorkerErrorKind,
  proveWorkerErrorDetail,
  recordProveTiming
} from 'lib/miden/sdk/local-prove-transport';

import { isProveWorkerMessage, type ProveWorkerMessage, transferable } from './prove-worker-protocol';
import { spawnProveWorker } from './spawn-prove-worker';

/** Same bound the service worker gives this document's own `OFFSCREEN_READY`. */
export const PROVE_WORKER_READY_TIMEOUT_MS = 30_000;
/** Long enough to carry a claim followed by a send on one warm worker. */
export const PROVE_WORKER_IDLE_MS = 60_000;
/**
 * A posted prove with no result by then fails and retires its worker: above the
 * slowest prove observed (75 s), below the relaxed lock watchdog (30 min). The relayed
 * OFFSCREEN_PROVE passes no cancel, so this is all that bounds a hung worker there.
 */
export const PROVE_WORKER_PROVE_TIMEOUT_MS = 10 * 60_000;

type RetireReason = ProveWorkerErrorKind | 'cancelled' | 'idle';

interface PendingProve {
  readonly id: number;
  readonly request: LocalProveRequest;
  readonly resolve: (result: LocalProveResult) => void;
  readonly reject: (reason: unknown) => void;
  posted: boolean;
}

interface LiveWorker {
  readonly worker: Worker;
  readonly spawnedAt: number;
  ready: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
  proveTimer: ReturnType<typeof setTimeout> | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ProveWorkerClient implements LocalProveTransport {
  private live: LiveWorker | null = null;
  /** FIFO. The head is the call in flight: posted, or waiting for `ready`. */
  private readonly queue: PendingProve[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly spawn: () => Worker;

  constructor(spawn: () => Worker = spawnProveWorker) {
    this.spawn = spawn;
  }

  prove(request: LocalProveRequest, options: LocalProveOptions = {}): Promise<LocalProveResult> {
    return new Promise<LocalProveResult>((resolve, reject) => {
      const call: PendingProve = { id: this.nextId++, request, resolve, reject, posted: false };
      this.queue.push(call);
      // Registered before the pump below is queued: a cancel that has already
      // rejected runs its handler first, so that call is never posted.
      options.cancel?.then(undefined, reason => this.cancel(call, reason));
      this.schedulePump();
    });
  }

  prewarm(): void {
    // A new worker is retired by its ready timeout or, once ready and idle, by the
    // idle timer. A warm idle one gets a fresh idle window, or a slow execute and
    // sign could outlast what was left of the last prove's and retire it first.
    if (!this.live) this.start();
    else if (this.queue.length === 0) this.armIdleTimer();
  }

  private pump(): void {
    const head = this.queue[0];
    if (!head) {
      if (this.live) this.armIdleTimer();
      return;
    }
    if (head.posted) return;
    const live = this.live ?? this.start();
    if (!live || !live.ready) return;
    // Transferring detaches the caller's buffer; every caller serializes a fresh one.
    const { bytes, transfer } = transferable(head.request.txResult);
    try {
      live.worker.postMessage({ type: 'prove', id: head.id, txResult: bytes }, transfer);
    } catch (error) {
      this.fail('crashed', messageOf(error));
      return;
    }
    head.posted = true;
    // Cleared by the result, so it can only ever fire on the call it was armed for.
    live.proveTimer = setTimeout(() => {
      if (this.live === live) this.fail('prove-timeout', `no result within ${PROVE_WORKER_PROVE_TIMEOUT_MS}ms`);
    }, PROVE_WORKER_PROVE_TIMEOUT_MS);
    recordProveTiming(`prove-worker posted id=${head.id} bytes=${bytes.byteLength}`);
  }

  /** Spawn and wire a worker. A spawn that throws fails the head call, if any. */
  private start(): LiveWorker | null {
    let worker: Worker;
    try {
      worker = this.spawn();
    } catch (error) {
      recordProveTiming('prove-worker retired reason=spawn-failed');
      this.failHead(new ProveWorkerError('spawn-failed', messageOf(error)));
      this.schedulePump();
      return null;
    }
    const live: LiveWorker = {
      worker,
      spawnedAt: performance.now(),
      ready: false,
      readyTimer: null,
      proveTimer: null
    };
    live.readyTimer = setTimeout(() => {
      if (this.live === live) this.fail('init-timeout', `no ready within ${PROVE_WORKER_READY_TIMEOUT_MS}ms`);
    }, PROVE_WORKER_READY_TIMEOUT_MS);
    // Each listener is bound to its own worker: once that worker is retired, its late
    // messages can settle nothing, since the call they answered was already rejected.
    worker.addEventListener('message', event => {
      if (this.live === live) this.onMessage(live, event.data);
    });
    worker.addEventListener('error', (event: Event) => {
      // First, and for a retired worker too: an unprevented worker error reaches this
      // realm's global `error` listener, whose WASM trap predicate would evict the
      // current lock holder and poison a healthy client.
      event.preventDefault();
      // A worker script that fails to LOAD (bad URL, CSP, a parse error) fires a plain
      // `Event` here, not an `ErrorEvent` - reading `.message` off it is `undefined`, so
      // the fixed text below is what actually reaches `detail` in that case.
      const detail = event instanceof ErrorEvent ? event.message : 'the prove worker failed to load';
      if (this.live === live) this.fail('crashed', detail);
    });
    worker.addEventListener('messageerror', () => {
      if (this.live === live) this.fail('crashed', 'messageerror');
    });
    this.live = live;
    recordProveTiming('prove-worker spawned');
    return live;
  }

  private onMessage(live: LiveWorker, data: unknown): void {
    if (!isProveWorkerMessage(data)) {
      this.fail('crashed', 'unrecognized message from the prove worker');
      return;
    }
    this.handle(live, data);
  }

  private handle(live: LiveWorker, message: ProveWorkerMessage): void {
    switch (message.type) {
      case 'ready': {
        if (live.readyTimer) clearTimeout(live.readyTimer);
        live.readyTimer = null;
        live.ready = true;
        const ms = (performance.now() - live.spawnedAt).toFixed(0);
        recordProveTiming(`prove-worker ready threads=${message.threads} coi=${message.crossOriginIsolated} ms=${ms}`);
        this.pump();
        return;
      }
      case 'init-failed':
        this.fail('init-failed', `${message.reason}: ${message.message}`);
        return;
      case 'result': {
        if (live.proveTimer) clearTimeout(live.proveTimer);
        live.proveTimer = null;
        // One prove is in flight, so a result for anything else is a protocol break.
        const head = this.queue[0];
        if (!head || !head.posted || head.id !== message.id) {
          this.fail('crashed', `result for unexpected id ${message.id}`);
          return;
        }
        recordProveTiming(
          `prove-worker result id=${message.id} ok=${message.ok}` +
            (message.ok
              ? ` ms=${message.durationMs.toFixed(0)}`
              : // On one line: the worker's raw text may embed newlines (a stack trace).
                ` detail=${message.message.replace(/\r?\n/g, ' ')}`)
        );
        if (!message.ok) {
          this.fail('prove-failed', message.message);
          return;
        }
        this.queue.shift();
        head.resolve({ proven: message.proven, durationMs: message.durationMs });
        this.pump();
      }
    }
  }

  private cancel(call: PendingProve, reason: unknown): void {
    if (this.queue[0] === call) {
      this.retire('cancelled', reason);
      return;
    }
    // A call no longer queued has settled; its cancel is moot.
    const index = this.queue.indexOf(call);
    if (index < 0) return;
    this.queue.splice(index, 1);
    call.reject(reason);
  }

  private fail(kind: ProveWorkerErrorKind, detail: string): void {
    this.retire(kind, new ProveWorkerError(kind, detail));
  }

  /**
   * Terminate and drop the current worker, rejecting only the call in flight (the
   * FIFO head, posted or still waiting for `ready`) with `error`. Later calls stay
   * queued, and the next one spawns a fresh worker.
   */
  private retire(reason: RetireReason, error?: unknown): void {
    const live = this.live;
    this.live = null;
    this.clearIdleTimer();
    if (live) {
      if (live.readyTimer) clearTimeout(live.readyTimer);
      if (live.proveTimer) clearTimeout(live.proveTimer);
      live.worker.terminate();
    }
    const detail = proveWorkerErrorDetail(error);
    recordProveTiming(`prove-worker retired reason=${reason}${detail === undefined ? '' : ` detail=${detail}`}`);
    if (reason !== 'idle') this.failHead(error);
    this.schedulePump();
  }

  /**
   * A promise job rather than a direct call, so a cancel that had already rejected
   * when its call was queued (its handler is the earlier job) removes that call first.
   */
  private schedulePump(): void {
    void Promise.resolve().then(() => this.pump());
  }

  private failHead(reason: unknown): void {
    this.queue.shift()?.reject(reason);
  }

  /**
   * Posting a call does not clear this timer - only `retire()` and a fresh call here
   * do. That is safe only because the callback below re-checks `queue.length === 0`:
   * a timer armed while idle and left running through a later post fires as a no-op
   * instead of retiring a worker that is busy again by the time it goes off.
   */
  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.queue.length === 0 && this.live) this.retire('idle');
    }, PROVE_WORKER_IDLE_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
