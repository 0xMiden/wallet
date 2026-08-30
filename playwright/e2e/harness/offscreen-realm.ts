import type { BrowserContext, CDPSession, Worker } from '@playwright/test';

import { installFetchInstrumentation, SW_FETCH_LOG_PREFIX } from './network-capture';
import type { FetchFaultWire } from './network-faults';

/**
 * The THIRD fetch-fault realm: the extension's OFFSCREEN DOCUMENT.
 *
 * WHY THIS EXISTS. `fetch-faults.ts` arms the service worker and the SDK's
 * `web-client-methods-worker`, and for a long time that was where the node
 * gRPC-web traffic came from. It is not any more. In the Chrome build the SW's
 * `midenClientProxy.syncState()` forwards `syncState` over
 * `chrome.runtime.sendMessage` to `offscreen.html`, which runs it on a client
 * created with `useWorker: false` — i.e. on the offscreen document's OWN main
 * thread (`src/offscreen/main.ts`; `src/lib/miden/back/miden-client-proxy.ts`).
 * The switch is `MIDEN_USE_OFFSCREEN_CLIENT`, which `vite.background.config.ts`
 * defaults to `'true'` and the E2E build never overrides, so on Chrome EVERY
 * proxied sync runs there. The two realms the seam armed still had the wrapper
 * installed and still reported `wrapped:true` — they had simply stopped issuing
 * the sync, which is why `sync-rate-limit-recovery.spec.ts` armed a fault
 * successfully and then measured zero hits.
 *
 * WHY IT NEEDS CDP. An offscreen document is not a `page.workers()` entry, not
 * the service worker, and not a `context.pages()` page: Chrome reports it as a
 * `background_page` target and playwright-core attaches to it and immediately
 * detaches (`CRBrowser._onAttachedToTarget` builds a page only for `page` /
 * `other`-with-`PW_CHROMIUM_ATTACH_TO_OTHER`, and a worker only for
 * `service_worker`). `context.backgroundPages()` is an MV2-era stub that returns
 * `[]`. So there is no Playwright handle to evaluate against, and the way in is
 * the browser-level CDP session Playwright DOES expose: `Target.getTargets` to
 * find the document, `Target.attachToTarget` to attach, and
 * `Target.sendMessageToTarget` to tunnel `Runtime.evaluate` into it.
 *
 * `flatten: false` is deliberate. Flat child sessions are routed by Playwright's
 * own connection, which knows nothing about a session we opened ourselves, so
 * their replies are dropped; the deprecated-but-supported non-flat tunnel is the
 * only shape whose replies come back to us (as `Target.receivedMessageFromTarget`
 * on the browser session). Verified against Chrome for Testing 149.
 *
 * We deliberately do NOT use `PW_CHROMIUM_ATTACH_TO_OTHER=1`, which would turn
 * the document into a real `Page`: that flag is process-global and would also
 * put the offscreen document into `context.pages()` (which `two-wallets.ts`
 * scans by extension id, and then CLOSES every page it did not pick) and under
 * `context.route`, silently changing which realm the guardian specs' route seam
 * intercepts. This module changes nothing Playwright already sees.
 *
 * BEST EFFORT, LIKE THE REST OF THE SEAM. Every round trip is bounded — the
 * offscreen main thread is where the single-threaded WASM client sits, and it
 * holds that thread for seconds at a time — and a realm that cannot be reached
 * simply contributes nothing rather than hanging or throwing. `hits()` staying
 * at zero is a real outcome, which is exactly what the specs' `hits > 0` check
 * exists to catch.
 */

/** `OFFSCREEN_URL` in `src/lib/miden/back/offscreen-prover.ts`, extension-root-relative. */
const OFFSCREEN_DOC_PATH = '/offscreen.html';

/** Same ceiling `applyToRealm` uses for a worker evaluate, for the same reason. */
const EVAL_TIMEOUT_MS = 3_000;

/** Same bounded-retry budget as `applyToRealm`. */
const EVAL_ATTEMPTS = 4;

/**
 * How often the live document is re-checked while faults are armed.
 *
 * This is not an optimisation, it is what keeps an armed fault ARMED. A hung
 * sync is force-killed by the wallet itself: `syncState` is dispatched with
 * `SYNC_DEADLINE_MS` (45s), and `onDeadline` in `miden-client-proxy.ts` responds
 * by calling `forceCloseOffscreenDocument()` and reopening it. So under a `hang`
 * fault the offscreen realm is destroyed and replaced roughly every 45 seconds —
 * taking the wrapper, the armed config AND the in-realm hit counter with it. The
 * poll re-installs into each new generation (a hung node stays hung after the
 * wallet restarts its realm — modelling anything else would silently lift the
 * fault mid-assertion) and banks the outgoing generation's hits.
 */
const WATCH_INTERVAL_MS = 500;

/** The subset of a `Runtime.evaluate` reply this module reads. */
interface CdpEvaluateReply {
  id?: number;
  error?: { message?: string };
  result?: {
    result?: { value?: string };
    exceptionDetails?: { text?: string };
  };
}

/** What the in-realm arm/read expression reports back, as JSON. */
interface RealmReport {
  wrapped: boolean;
  hits: number;
}

export interface OffscreenFaultRealm {
  /** Install (idempotently) and arm `wire` in the live offscreen document. */
  arm(wire: FetchFaultWire[]): Promise<void>;
  /** Injections recorded in the offscreen realm, summed ACROSS document generations. */
  hits(): Promise<number>;
  /** Disarm and zero the counters, in the realm and in this module. */
  clear(): Promise<void>;
}

const parseReply = (raw: string): CdpEvaluateReply | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as CdpEvaluateReply) : undefined;
  } catch {
    return undefined;
  }
};

const parseReport = (raw: string | undefined): RealmReport | undefined => {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const report = parsed as Partial<RealmReport>;
    return typeof report.hits === 'number' ? { wrapped: !!report.wrapped, hits: report.hits } : undefined;
  } catch {
    return undefined;
  }
};

const debug = (message: string): void => {
  if (process.env.FETCH_FAULT_DEBUG) {
    // eslint-disable-next-line no-console
    console.log(`[fetch-fault-debug] offscreen: ${message}`);
  }
};

/**
 * Install the offscreen-document fault realm. Both arguments are thunks for the
 * same reason `installFetchFaultControls` takes one: `reopen()` relaunches the
 * whole persistent context after a browser crash, and the controls must follow
 * the LIVE context and service worker, not the dead ones.
 */
export function installOffscreenFaultRealm(
  getContext: () => BrowserContext,
  getServiceWorker: () => Worker | undefined
): OffscreenFaultRealm {
  let session: CDPSession | undefined;
  let connecting: Promise<CDPSession | undefined> | undefined;
  /** targetId → CDP sessionId of our non-flat attachment to it. */
  const attachments = new Map<string, string>();
  const pending = new Map<number, (reply: CdpEvaluateReply) => void>();
  let nextMessageId = 1;

  // Hit accounting spans document GENERATIONS. The counter lives in the realm
  // (that is what the wrapper increments), so it dies with the document — and
  // under a `hang` the wallet kills that document every 45s, which would erase
  // the very evidence the spec then asserts on. `liveHits` is the running count
  // of the generation identified by `liveTargetId`; when a different targetId
  // appears, the previous generation is gone for good and its last known count
  // is banked into `deadHits`. targetIds are never reused, so nothing is
  // double-counted.
  let liveTargetId: string | undefined;
  let liveHits = 0;
  let deadHits = 0;

  let armedWire: FetchFaultWire[] = [];
  let watcher: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  const browserSession = async (): Promise<CDPSession | undefined> => {
    if (session) return session;
    if (!connecting) {
      connecting = (async (): Promise<CDPSession | undefined> => {
        const browser = getContext().browser();
        // Persistent contexts DO expose their browser in playwright-core 1.61
        // (`two-wallets.ts` and `wallet-page.ts` already rely on it); this guard
        // is for the day that changes, and it degrades to "realm unreachable".
        if (!browser) return undefined;
        const opened = await browser.newBrowserCDPSession();
        opened.on('Target.receivedMessageFromTarget', event => {
          const reply = parseReply(event.message);
          if (!reply || reply.id === undefined) return; // a protocol event, not our reply
          const settle = pending.get(reply.id);
          if (!settle) return; // already timed out — drop it
          pending.delete(reply.id);
          settle(reply);
        });
        opened.on('Target.detachedFromTarget', event => {
          for (const [targetId, sessionId] of attachments) {
            if (sessionId === event.sessionId) attachments.delete(targetId);
          }
        });
        return opened;
      })().catch(() => undefined);
    }
    session = await connecting;
    // Failed to connect: forget the attempt so the next arm can retry.
    if (!session) connecting = undefined;
    return session;
  };

  const forgetSession = (): void => {
    session = undefined;
    connecting = undefined;
    attachments.clear();
  };

  const offscreenUrl = (): string | undefined => {
    const serviceWorker = getServiceWorker();
    if (!serviceWorker) return undefined;
    try {
      return `chrome-extension://${new URL(serviceWorker.url()).host}${OFFSCREEN_DOC_PATH}`;
    } catch {
      return undefined;
    }
  };

  /** The live document's targetId, or undefined while none exists (it is created lazily). */
  const resolveTarget = async (): Promise<string | undefined> => {
    const url = offscreenUrl();
    if (!url) return undefined;
    const opened = await browserSession();
    if (!opened) return undefined;
    try {
      const { targetInfos } = await opened.send('Target.getTargets');
      // Matched by URL, not by type: Chrome reports the document as `other`
      // between creation and navigation and as `background_page` afterwards.
      return targetInfos.find(info => info.url === url)?.targetId;
    } catch {
      forgetSession();
      return undefined;
    }
  };

  const attachTo = async (opened: CDPSession, targetId: string): Promise<string | undefined> => {
    const cached = attachments.get(targetId);
    if (cached) return cached;
    try {
      const { sessionId } = await opened.send('Target.attachToTarget', { targetId, flatten: false });
      attachments.set(targetId, sessionId);
      return sessionId;
    } catch {
      return undefined;
    }
  };

  /**
   * One bounded `Runtime.evaluate` in the document. Returns the expression's
   * string value, or undefined if the realm was busy, gone or unreachable —
   * never throws, never outlives {@link EVAL_TIMEOUT_MS}.
   */
  const evaluateInDoc = async (targetId: string, expression: string): Promise<string | undefined> => {
    const opened = await browserSession();
    if (!opened) return undefined;
    const sessionId = await attachTo(opened, targetId);
    if (!sessionId) return undefined;
    const messageId = nextMessageId++;
    const reply = new Promise<CdpEvaluateReply>(resolve => pending.set(messageId, resolve));
    try {
      await opened.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({
          id: messageId,
          method: 'Runtime.evaluate',
          // `awaitPromise: false`: every expression below is synchronous. An
          // awaited promise could park for the whole test — precisely what a
          // `hang` fault does to the realm we are talking to.
          params: { expression, returnByValue: true, awaitPromise: false }
        })
      });
      const settled = await Promise.race([
        reply,
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), EVAL_TIMEOUT_MS))
      ]);
      if (!settled) {
        debug(`evaluate timed out after ${EVAL_TIMEOUT_MS}ms (realm busy)`);
        return undefined;
      }
      if (settled.error || settled.result?.exceptionDetails) {
        debug(`evaluate failed: ${JSON.stringify(settled.error ?? settled.result?.exceptionDetails).slice(0, 120)}`);
        return undefined;
      }
      return settled.result?.result?.value;
    } catch {
      // The document went away mid-round-trip (the SW closes it on a dispatch
      // deadline), or the browser is gone. Drop the stale attachment; the next
      // call re-resolves and re-attaches.
      attachments.delete(targetId);
      return undefined;
    } finally {
      pending.delete(messageId);
    }
  };

  /**
   * Install the wrapper (idempotent — it guards on `__e2e_fetch_wrapped`), push
   * the config and read the counter back, in ONE round trip.
   *
   * `__E2E_NET_FAULT_HITS` is preserved across a re-arm and zeroed only by
   * `clear()`, exactly as `applyToRealm` does for the other realms.
   */
  const installAndArmExpression = (wire: FetchFaultWire[]): string =>
    `(() => {
      (${installFetchInstrumentation.toString()})(${JSON.stringify(SW_FETCH_LOG_PREFIX)});
      const g = globalThis;
      g.__E2E_NET_FAULTS = ${JSON.stringify(wire)};
      g.__E2E_NET_FAULT_HITS = g.__E2E_NET_FAULT_HITS || {};
      return JSON.stringify({
        wrapped: !!g.__e2e_fetch_wrapped,
        hits: Object.values(g.__E2E_NET_FAULT_HITS).reduce((total, n) => total + n, 0)
      });
    })()`;

  /**
   * The steady-state round trip: re-push the config and read the counter,
   * WITHOUT shipping the installer source again. Reports `wrapped: false` for a
   * document that has not been instrumented yet (a fresh generation), which is
   * the caller's signal to send the full install instead.
   */
  const refreshExpression = (wire: FetchFaultWire[]): string =>
    `(() => {
      const g = globalThis;
      if (!g.__e2e_fetch_wrapped) return JSON.stringify({ wrapped: false, hits: 0 });
      g.__E2E_NET_FAULTS = ${JSON.stringify(wire)};
      g.__E2E_NET_FAULT_HITS = g.__E2E_NET_FAULT_HITS || {};
      return JSON.stringify({
        wrapped: true,
        hits: Object.values(g.__E2E_NET_FAULT_HITS).reduce((total, n) => total + n, 0)
      });
    })()`;

  const readExpression = (): string =>
    `JSON.stringify({ wrapped: !!globalThis.__e2e_fetch_wrapped,
      hits: Object.values(globalThis.__E2E_NET_FAULT_HITS || {}).reduce((total, n) => total + n, 0) })`;

  const clearExpression = (): string =>
    `(() => {
      const g = globalThis;
      g.__E2E_NET_FAULTS = [];
      g.__E2E_NET_FAULT_HITS = {};
      return JSON.stringify({ wrapped: !!g.__e2e_fetch_wrapped, hits: 0 });
    })()`;

  /** Fold one observation into the cross-generation accounting. */
  const sample = (targetId: string, hits: number): void => {
    if (targetId !== liveTargetId) {
      if (liveTargetId !== undefined) deadHits += liveHits;
      liveTargetId = targetId;
      liveHits = 0;
    }
    liveHits = hits;
  };

  /**
   * Ensure the live document carries `armedWire`, and sample its counter.
   * `attempts` bounds the retries the way `applyToRealm` does: a realm busy for
   * the whole window drops out rather than hanging the caller.
   */
  const syncRealm = async (attempts: number): Promise<RealmReport | undefined> => {
    const targetId = await resolveTarget();
    if (!targetId) {
      debug('no offscreen document exists yet (created lazily on the first dispatched op)');
      return undefined;
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      let report = parseReport(await evaluateInDoc(targetId, refreshExpression(armedWire)));
      if (report && !report.wrapped) {
        report = parseReport(await evaluateInDoc(targetId, installAndArmExpression(armedWire)));
      }
      if (report) {
        sample(targetId, report.hits);
        return report;
      }
    }
    return undefined;
  };

  const tick = async (): Promise<void> => {
    if (ticking) return; // a previous tick is still waiting on a busy realm
    ticking = true;
    try {
      await syncRealm(1);
    } catch {
      // instrumentation must never be the thing that fails a run
    } finally {
      ticking = false;
    }
  };

  const startWatching = (): void => {
    if (watcher) return;
    watcher = setInterval(() => void tick(), WATCH_INTERVAL_MS);
    // Node's timer, not the DOM's: an interval left running must never be the
    // reason a worker process stays alive after the run.
    if (typeof watcher !== 'number') watcher.unref();
  };

  const stopWatching = (): void => {
    if (!watcher) return;
    clearInterval(watcher);
    watcher = undefined;
  };

  return {
    async arm(wire: FetchFaultWire[]): Promise<void> {
      armedWire = wire;
      const report = await syncRealm(EVAL_ATTEMPTS);
      debug(`arm -> ${report ? `wrapped=${report.wrapped} hits=${report.hits}` : 'realm unreachable'}`);
      if (wire.length) startWatching();
      else stopWatching();
    },

    async hits(): Promise<number> {
      const targetId = await resolveTarget();
      if (targetId) {
        const report = parseReport(await evaluateInDoc(targetId, readExpression()));
        // A realm that cannot be evaluated keeps its last sampled count (the
        // watcher refreshes it every WATCH_INTERVAL_MS) instead of throwing or
        // reporting zero — the same best-effort contract as the other realms.
        if (report) sample(targetId, report.hits);
      }
      return deadHits + liveHits;
    },

    async clear(): Promise<void> {
      armedWire = [];
      stopWatching();
      const targetId = await resolveTarget();
      if (targetId) await evaluateInDoc(targetId, clearExpression());
      deadHits = 0;
      liveHits = 0;
      liveTargetId = targetId;
    }
  };
}
