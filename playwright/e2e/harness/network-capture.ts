import type { BrowserContext, Page, Request, Response as PwResponse, Worker } from '@playwright/test';

import type { FetchFaultWire } from './network-faults';
import type { TimelineRecorder } from './timeline-recorder';
import { decodeSendNoteBase64, decodeSendNoteBody, isSendNoteUrl } from './transport-wire';
import type { NetworkCategory } from './types';

/**
 * How a URL is classified into a network category.
 *
 * The transport arm matches the gRPC SERVICE PATH from its proto
 * (`package miden_note_transport; service MidenNoteTransport`) rather than a host,
 * so capture follows the service wherever it is pointed.
 * A host list cannot: `MIDEN_NOTE_TRANSPORT_URL` is a build-time override, so the
 * endpoint is whatever the build baked, and traffic to an unlisted host is
 * classified `other` and dropped with no signal that anything went unrecorded.
 *
 * That is not hypothetical. The localnet transport is configured as
 * `http://127.0.0.1:57292` (`environments.ts`, `networks-config.ts`) while this
 * list only ever named `localhost:57292` — so transport was the ONE category
 * silently uncaptured on localnet, since rpc and prover happen to be configured as
 * `localhost` and matched. Both spellings are now accepted as a fallback, but the
 * path is what makes the classification robust.
 */
const ENDPOINT_PATTERNS: Record<NetworkCategory, RegExp> = {
  rpc: /rpc\.(testnet|devnet)\.miden\.io|(localhost|127\.0\.0\.1):57291/,
  transport: /miden_note_transport\.MidenNoteTransport\/|transport\.miden\.io|(localhost|127\.0\.0\.1):57292/,
  prover: /tx-prover\.(testnet|devnet)\.miden\.io|(localhost|127\.0\.0\.1):5005[12]/,
  other: /.*/
};

/** Prefix used by the SW fetch wrapper so the console stream can be demuxed. */
export const SW_FETCH_LOG_PREFIX = '[E2E_NET] ';

export function classifyUrl(url: string): NetworkCategory {
  for (const [category, pattern] of Object.entries(ENDPOINT_PATTERNS)) {
    if (category !== 'other' && pattern.test(url)) {
      return category as NetworkCategory;
    }
  }
  return 'other';
}

export function isMidenRelated(url: string): boolean {
  return classifyUrl(url) !== 'other';
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + `... (truncated, ${s.length} total)` : s;
}

async function safeResponseText(response: PwResponse): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/**
 * Attach network request/response capture at the BrowserContext level.
 *
 * Captures every PAGE-initiated request in the context. Service-worker
 * requests are filtered out (Playwright 1.48's context events DO include
 * them, but attachServiceWorkerFetchCapture instruments those separately
 * with a cleaner durationMs shape) — keeping the two sources distinct
 * prevents duplicate events in the timeline while preserving Playwright's
 * full request.timing() breakdown (DNS/TLS/ttfb/receive) for page traffic.
 */
export function attachNetworkCapture(
  context: BrowserContext,
  walletLabel: 'A' | 'B',
  timeline: TimelineRecorder
): void {
  context.on('requestfinished', async (request: Request) => {
    // Whole body guarded, like the SW listeners below. This is an ASYNC
    // listener, so a rejection here is an unhandled rejection that Playwright
    // charges to whichever test is running, and capture is diagnostic only —
    // it must never fail a run.
    //
    // This guard does NOT catch "Object with guid handle@… was not bound in the
    // connection", despite that being the failure the surrounding change chased
    // (guardian-recovery-stress's browser-crash spec on main at d77bc51d / run
    // 32478703603). That error is thrown by Playwright's connection dispatcher
    // while deserializing a channel, not delivered as a rejection: `dispatch`
    // deletes the pending callback and then evaluates the result validator as
    // the argument to `callback.resolve`, so a throw there escapes `dispatch`
    // and the awaited promise simply never settles — no `catch` in this body is
    // on the stack. Nor can this listener avoid it: the `requestfinished` event
    // payload itself carries `request` and `response` as channels, resolved
    // before the listener runs. Removing the `request.response()` call below
    // would not help. The handle-free rewrite in `two-wallets.ts` works because
    // it drops a handle the WALLET code asked for; there is no equivalent lever
    // here.
    try {
      if (request.serviceWorker()) return; // handled by attachServiceWorkerFetchCapture
      const url = request.url();
      if (!isMidenRelated(url)) return;

      const category = classifyUrl(url);
      const response = await request.response();
      const status = response?.status() ?? 0;
      const responseBody = response ? truncate((await safeResponseText(response)) ?? '', 4096) : undefined;
      // Identity of the notes this push carried. Without it the timeline can say a
      // SendNote happened but not WHICH note, which is precisely what a
      // silently-undelivered note needs in order to be correlated after the fact.
      const sentNotes =
        category === 'transport' && isSendNoteUrl(url) ? decodeSendNoteBody(request.postDataBuffer()) : [];

      timeline.emit({
        category: 'network_request',
        severity: status >= 400 ? 'error' : 'info',
        wallet: walletLabel,
        message: `${request.method()} ${url} -> ${status}`,
        data: {
          url,
          method: request.method(),
          status,
          responseBody,
          networkCategory: category,
          ...(sentNotes.length > 0 ? { sentNotes } : {}),
          timing: request.timing(),
          source: 'page'
        }
      });
    } catch {
      // browser/context gone mid-capture — drop the event
    }
  });

  context.on('requestfailed', (request: Request) => {
    if (request.serviceWorker()) return;
    const url = request.url();
    if (!isMidenRelated(url)) return;

    const category = classifyUrl(url);
    timeline.emit({
      category: 'network_request',
      severity: 'error',
      wallet: walletLabel,
      message: `FAILED ${request.method()} ${url}: ${request.failure()?.errorText}`,
      data: {
        url,
        method: request.method(),
        failureText: request.failure()?.errorText,
        networkCategory: category,
        source: 'page'
      }
    });
  });
}

/**
 * The fetch instrumentation itself, hoisted to module scope so it has exactly ONE
 * definition. `attachServiceWorkerFetchCapture` installs it with `evaluate`, which ships
 * this function's SOURCE into the realm -- so the same source can be installed over raw
 * CDP into a realm Playwright will not hand out a handle for (the extension's offscreen
 * document; see `offscreen-realm.ts`). Keep it free of closure references for that
 * reason: it has to stand alone as source text.
 */
export const installFetchInstrumentation = (prefix: string): void => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.__e2e_fetch_wrapped) return;
  g.__e2e_fetch_wrapped = true;

  const origFetch: typeof fetch = g.fetch.bind(g);
  // Mirrors ENDPOINT_PATTERNS / classifyUrl in this module, which is the
  // canonical copy — this runs as source text inside evaluate() and cannot
  // import it. Keep the two in step; `network-capture.test.ts` pins the
  // behaviour they must agree on. The transport arm matches the gRPC SERVICE
  // PATH rather than a host, so capture follows a build-time
  // MIDEN_NOTE_TRANSPORT_URL override to any host or port.
  const HOST_PATTERN =
    /miden_note_transport\.MidenNoteTransport\/|rpc\.(testnet|devnet)\.miden\.io|tx-prover\.(testnet|devnet)\.miden\.io|transport\.miden\.io|(localhost|127\.0\.0\.1):(57291|57292|5005[12])/;

  function classify(url: string): string {
    if (/rpc\.(testnet|devnet)\.miden\.io|(localhost|127\.0\.0\.1):57291/.test(url)) return 'rpc';
    if (/tx-prover\.(testnet|devnet)\.miden\.io|(localhost|127\.0\.0\.1):5005[12]/.test(url)) return 'prover';
    if (/miden_note_transport\.MidenNoteTransport\/|transport\.miden\.io|(localhost|127\.0\.0\.1):57292/.test(url))
      return 'transport';
    return 'other';
  }

  g.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET');
    if (!HOST_PATTERN.test(url)) return origFetch(input, init);

    const category = classify(url);

    // --- Fault injection (resilience harness) ---
    // context.route CANNOT reach node/prover/transport gRPC-web (it runs in
    // this realm — the SW or the SDK's page-worker — not on a routable page
    // request), so faults for those targets are applied HERE at the fetch
    // layer. Gated on `__E2E_NET_FAULTS` (set by armFetchFaults): unarmed, this
    // is a pure pass-through, so every non-resilience suite is unaffected.
    const faults = (g.__E2E_NET_FAULTS as FetchFaultWire[] | undefined) || [];
    if (faults.length) {
      g.__E2E_NET_FAULT_HITS = g.__E2E_NET_FAULT_HITS || {};
      const hits = g.__E2E_NET_FAULT_HITS as Record<string, number>;
      for (const f of faults) {
        if (!url.includes(f.host)) continue;
        if (f.path && !url.includes(f.path)) continue;
        const prior = hits[f.id] || 0;
        if (f.mode === 'failFirstN' && prior >= (f.count || 1)) break; // recovered — pass through
        hits[f.id] = prior + 1;
        console.log(prefix + JSON.stringify({ url, method, status: 0, category, err: 'INJECTED:' + f.mode }));
        if (f.mode === 'delay' || f.mode === 'slowStream') {
          await new Promise(r => setTimeout(r, f.delayMs || (f.mode === 'slowStream' ? 8000 : 3000)));
          break; // fall through to the real fetch below
        }
        if (f.mode === 'hang') return new Promise<Response>(() => {}); // never settles
        if (f.mode === 'status500' || f.mode === 'failFirstN') {
          return new Response('injected network fault', { status: 500 });
        }
        if (f.mode === 'status429RetryAfter') {
          return new Response(JSON.stringify({ error: 'rate_limited', retryable: true }), {
            status: 429,
            headers: { 'retry-after': String(f.retryAfterSec || 1) }
          });
        }
        if (f.mode === 'truncatedBody') return new Response('{', { status: 200 });
        if (f.mode === 'malformedBody') return new Response('not a valid response body', { status: 200 });
        // connectionRefused / abort / timeout → surface as a transport error
        throw new TypeError('Failed to fetch (injected ' + f.mode + ')');
      }
    }

    const realm = (g.location && g.location.href) || 'unknown';

    // Carry the request body for transport pushes ONLY. It is the sole way to
    // learn which note a SendNote carried, and at ~300 bytes it is cheap; every
    // other category would add real log volume for no diagnostic gain.
    //
    // The body has to be SECURED before the fetch but READ after it. The SDK's
    // gRPC-web transport calls `fetch(request, initWithSignal)`, so the body
    // lives on the Request rather than on `init`, and the fetch disturbs that
    // stream — hence the `clone()`, which is synchronous and tees the stream so
    // the bytes stay readable afterwards. Reading it only once the fetch has
    // settled keeps capture out of the measured `durationMs`; it does NOT keep a
    // slow read off the caller's critical path, which is what the ceiling in
    // `encodeBody` is for. The URL pattern mirrors `isSendNoteUrl`, the canonical
    // copy; this function cannot close over module scope.
    // Held as `unknown` and narrowed by `instanceof` below on purpose: this file
    // type-checks with both the DOM and the Node fetch typings in scope, so a
    // written-out union naming `Request` picks one of the two declarations and
    // then rejects the other one's `clone()`.
    let bodySource: unknown;
    try {
      if (category === 'transport' && /MidenNoteTransport\/SendNote$/.test(url)) {
        const isRequest = typeof input !== 'string' && !(input instanceof URL);
        bodySource = init?.body ?? (isRequest ? input.clone() : undefined);
      }
    } catch {
      // capture is diagnostic; never let it disturb the fetch it wraps
    }

    const encodeBody = async (): Promise<string | undefined> => {
      try {
        if (!bodySource) return undefined;
        let bytes: Uint8Array | undefined;
        if (bodySource instanceof Uint8Array) bytes = bodySource;
        else if (bodySource instanceof ArrayBuffer) bytes = new Uint8Array(bodySource);
        else if (ArrayBuffer.isView(bodySource))
          bytes = new Uint8Array(bodySource.buffer, bodySource.byteOffset, bodySource.byteLength);
        else if (bodySource instanceof Request) {
          // The only unbounded step here. A buffered body resolves in a
          // microtask, but a streaming one need never finish arriving, and both
          // call sites await this between the fetch settling and the wrapper
          // returning — so an unbounded read would let the capture wedge the
          // very request it is observing. Give it a ceiling and drop the body.
          const buffered = await Promise.race([
            bodySource.arrayBuffer(),
            new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1000))
          ]);
          if (!buffered) return undefined;
          bytes = new Uint8Array(buffered);
        }
        if (!bytes || bytes.length === 0 || bytes.length > 8192) return undefined;
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        return btoa(bin);
      } catch {
        return undefined;
      }
    };

    const start = performance.now();
    try {
      const res = await origFetch(input, init);
      const durationMs = Math.round(performance.now() - start);
      const reqBody = await encodeBody();
      console.log(prefix + JSON.stringify({ url, method, status: res.status, durationMs, category, realm, reqBody }));
      return res;
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const errStr = err instanceof Error ? err.message : String(err);
      // A push that threw is at least as diagnostic as one that returned 200 —
      // a real transport failure is exactly when you need to know which note —
      // so the identity has to ride along here too.
      const reqBody = await encodeBody();
      console.log(
        prefix + JSON.stringify({ url, method, status: 0, durationMs, category, err: errStr, realm, reqBody })
      );
      throw err;
    }
  };
};

/**
 * SW-scoped network capture. Most Miden RPC + prover traffic originates
 * in the extension's service worker (the SDK's WASM client runs there),
 * which page-level and context-level Playwright events do not surface.
 *
 * Instrument by installing a globalThis.fetch wrapper via evaluate(), with
 * instrumentation results tunnelled back to the harness through the SW's
 * console stream. A sentinel prefix lets the fixture's generic console
 * handler skip them so the data lands on the network_request timeline
 * category instead of browser_console.
 *
 * Captures: URL, method, HTTP status, duration. Not response bodies —
 * those are already truncated at 4 KB in the page-side capture and add
 * significantly more log volume when enabled for every SW RPC.
 *
 * Idempotent per SW: the wrapper checks a marker before re-installing, so
 * callers can safely re-invoke after SW restart without double-wrapping.
 */
export async function attachServiceWorkerFetchCapture(
  serviceWorker: Worker,
  walletLabel: 'A' | 'B',
  timeline: TimelineRecorder
): Promise<void> {
  // Inside the guard, like the evaluate below. Attaching to a worker that has
  // ALREADY gone (extension service workers are recycled aggressively, and a
  // spec that kills the browser destroys them outright) throws a Playwright
  // protocol error, and because callers invoke this fire-and-forget that
  // becomes an unhandled rejection Playwright charges to whichever test is
  // running. Losing capture on a dead worker is fine; failing the test for it
  // is not.
  //
  // NOT the "Object with guid handle@… was not bound in the connection" failure
  // an earlier version of this comment named, which is a different mechanism
  // this `try` could not have caught anyway: it is raised out of band while the
  // client validates a reply naming a handle, and the only call below is an
  // `evaluate`, whose reply carries a serialized value and no handle. See
  // `suspendScreenCapture` in `screen-capture.ts` for the real one.
  try {
    serviceWorker.on('console', msg => {
      const text = msg.text();
      if (!text.startsWith(SW_FETCH_LOG_PREFIX)) return;
      try {
        const parsed = JSON.parse(text.slice(SW_FETCH_LOG_PREFIX.length));
        const status: number = parsed.status ?? 0;
        const err: string | undefined = parsed.err;
        // Gated the same way as the page-side decode above. The producer only ever
        // sets `reqBody` for a transport SendNote today, but `decodeSendNoteBody`
        // accepts any message shaped like one, so without this gate widening the
        // producer would start fabricating `sentNotes` on unrelated traffic.
        const sentNotes =
          parsed.category === 'transport' && isSendNoteUrl(String(parsed.url ?? ''))
            ? decodeSendNoteBase64(parsed.reqBody)
            : [];
        if (process.env.FETCH_FAULT_DEBUG && parsed.category === 'rpc') {
          // eslint-disable-next-line no-console
          console.log(
            `[net-obs] rpc ${parsed.method} status=${status} err=${(err ?? '').slice(0, 40)} realm=${String(parsed.realm).split('/').pop()}`
          );
        }
        timeline.emit({
          category: 'network_request',
          severity: status >= 400 || err ? 'error' : 'info',
          wallet: walletLabel,
          message:
            `${parsed.method} ${parsed.url} -> ${status}` +
            (parsed.durationMs != null ? ` (${parsed.durationMs}ms)` : '') +
            (err ? ` ERR ${err.slice(0, 120)}` : ''),
          data: {
            url: parsed.url,
            method: parsed.method,
            status,
            durationMs: parsed.durationMs,
            err,
            networkCategory: parsed.category,
            ...(sentNotes.length > 0 ? { sentNotes } : {}),
            source: 'service_worker'
          }
        });
      } catch {
        // malformed log line — ignore
      }
    });
  } catch (err) {
    timeline.emit({
      category: 'test_lifecycle',
      severity: 'warn',
      wallet: walletLabel,
      message: `[SW-NET] console listener attach failed: ${err instanceof Error ? err.message : String(err)}`
    });
    return;
  }

  try {
    await serviceWorker.evaluate(installFetchInstrumentation, SW_FETCH_LOG_PREFIX);
  } catch (err) {
    timeline.emit({
      category: 'test_lifecycle',
      severity: 'warn',
      wallet: walletLabel,
      message: `[SW-NET] fetch wrapper install failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

/**
 * Page-spawned worker capture. The Miden SDK spawns a dedicated web worker
 * (`web-client-methods-worker.js`) where the compiled-Rust client runs the
 * bulk of its RPCs — prover, sync, submit, etc. Those fetches happen in the
 * worker's own context and are NOT visible to:
 *   - the SW-scoped wrapper (different global)
 *   - context.on('requestfinished') page-scoped events
 *   - context.on('requestfinished') SW-scoped events (we dedupe those via
 *     request.serviceWorker())
 *
 * Solution: the same fetch-wrapper pattern, but installed via the worker's
 * own evaluate(). A console listener on the worker target demuxes the
 * sentinel lines into network_request events. Applied to every worker
 * spawned by the page (current + future).
 */
export function attachPageWorkersCapture(page: Page, walletLabel: 'A' | 'B', timeline: TimelineRecorder): void {
  // `.catch`, not bare `void`: these are deliberately not awaited, so without a
  // rejection handler a worker that dies mid-attach surfaces as an unhandled
  // rejection and Playwright fails whichever test happens to be running. The
  // callee guards its own Playwright calls; this is the backstop for anything
  // it can't (a worker destroyed between `page.workers()` and the attach).
  const attach = (worker: Worker): void => {
    attachServiceWorkerFetchCapture(worker, walletLabel, timeline).catch(() => {});
  };
  for (const worker of page.workers()) {
    attach(worker);
  }
  page.on('worker', attach);
}
