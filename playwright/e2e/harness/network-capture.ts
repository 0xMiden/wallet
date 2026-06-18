import type { BrowserContext, Page, Request, Response as PwResponse, Worker } from '@playwright/test';

import type { TimelineRecorder } from './timeline-recorder';
import type { NetworkCategory } from './types';

const ENDPOINT_PATTERNS: Record<NetworkCategory, RegExp> = {
  rpc: /rpc\.(testnet|devnet)\.miden\.io|localhost:57291/,
  transport: /transport\.miden\.io|localhost:57292/,
  prover: /tx-prover\.(testnet|devnet)\.miden\.io|localhost:50051/,
  other: /.*/
};

/** Prefix used by the SW fetch wrapper so the console stream can be demuxed. */
export const SW_FETCH_LOG_PREFIX = '[E2E_NET] ';

function classifyUrl(url: string): NetworkCategory {
  for (const [category, pattern] of Object.entries(ENDPOINT_PATTERNS)) {
    if (category !== 'other' && pattern.test(url)) {
      return category as NetworkCategory;
    }
  }
  return 'other';
}

function isMidenRelated(url: string): boolean {
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
    if (request.serviceWorker()) return; // handled by attachServiceWorkerFetchCapture
    const url = request.url();
    if (!isMidenRelated(url)) return;

    const category = classifyUrl(url);
    const response = await request.response();
    const status = response?.status() ?? 0;
    const responseBody = response ? truncate((await safeResponseText(response)) ?? '', 4096) : undefined;

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
        timing: request.timing(),
        source: 'page'
      }
    });
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
  serviceWorker.on('console', msg => {
    const text = msg.text();
    if (!text.startsWith(SW_FETCH_LOG_PREFIX)) return;
    try {
      const parsed = JSON.parse(text.slice(SW_FETCH_LOG_PREFIX.length));
      const status: number = parsed.status ?? 0;
      const err: string | undefined = parsed.err;
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
          source: 'service_worker'
        }
      });
    } catch {
      // malformed log line — ignore
    }
  });

  try {
    await serviceWorker.evaluate(prefix => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = globalThis as any;
      if (g.__e2e_fetch_wrapped) return;
      g.__e2e_fetch_wrapped = true;

      const origFetch: typeof fetch = g.fetch.bind(g);
      const HOST_PATTERN =
        /rpc\.(testnet|devnet)\.miden\.io|tx-prover\.(testnet|devnet)\.miden\.io|transport\.miden\.io|localhost:(57291|57292|50051)/;

      function classify(url: string): string {
        if (/rpc\.(testnet|devnet)\.miden\.io|localhost:57291/.test(url)) return 'rpc';
        if (/tx-prover\.(testnet|devnet)\.miden\.io|localhost:50051/.test(url)) return 'prover';
        if (/transport\.miden\.io|localhost:57292/.test(url)) return 'transport';
        return 'other';
      }

      g.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method || (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET');
        if (!HOST_PATTERN.test(url)) return origFetch(input, init);

        const category = classify(url);
        const start = performance.now();
        try {
          const res = await origFetch(input, init);
          const durationMs = Math.round(performance.now() - start);
          console.log(prefix + JSON.stringify({ url, method, status: res.status, durationMs, category }));
          return res;
        } catch (err) {
          const durationMs = Math.round(performance.now() - start);
          const errStr = err instanceof Error ? err.message : String(err);
          console.log(prefix + JSON.stringify({ url, method, status: 0, durationMs, category, err: errStr }));
          throw err;
        }
      };
    }, SW_FETCH_LOG_PREFIX);
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
  for (const worker of page.workers()) {
    void attachServiceWorkerFetchCapture(worker, walletLabel, timeline);
  }
  page.on('worker', worker => {
    void attachServiceWorkerFetchCapture(worker, walletLabel, timeline);
  });
}
