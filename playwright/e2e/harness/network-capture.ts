import type { BrowserContext, Page, Request, Response as PwResponse, Worker } from '@playwright/test';

import { installFetchInstrumentation, SW_FETCH_LOG_PREFIX } from './fetch-instrumentation';
import type { TimelineRecorder } from './timeline-recorder';
import { decodeSendNoteBase64, decodeSendNoteBody, isSendNoteUrl } from './transport-wire';
import type { NetworkCategory } from './types';

/**
 * How a URL is classified into a network category.
 *
 * The transport arm matches the gRPC SERVICE PATH from its proto
 * (`package miden.note_transport.v1; service NoteTransportService`, the only one
 * SDK 0.17 calls) rather than a host, so capture follows the service wherever it is
 * pointed. It is tested BEFORE rpc because the path is the stronger signal: a node
 * that serves transport beside rpc on one host would otherwise lose every push to `rpc`.
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
  transport: /\/miden\.note_transport\.v1\.NoteTransportService\/|transport\.miden\.io|(localhost|127\.0\.0\.1):57292/,
  rpc: /rpc\.(testnet|devnet)\.miden\.io|(localhost|127\.0\.0\.1):57291/,
  prover: /tx-prover\.(testnet|devnet)\.miden\.io|(localhost|127\.0\.0\.1):5005[12]/,
  other: /.*/
};

export { installFetchInstrumentation, SW_FETCH_LOG_PREFIX } from './fetch-instrumentation';

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
      // push happened but not WHICH note, which is precisely what a
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
        // sets `reqBody` for a transport SendNoteWithProof, but `decodeSendNoteBody`
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
