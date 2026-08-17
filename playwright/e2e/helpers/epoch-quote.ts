/**
 * Diagnostics for the Epoch forward-quote used by the Fast bridge route.
 *
 * WHY
 *
 * The bridge specs used to gate on `toContainText('$')` against the Fast route
 * card. That is an assertion on the pixel that REPORTS the quote, not on the
 * quote, and it conflates three unrelated failures — no token loaded, no amount
 * parsed, or the quote service returning nothing — because `fastFeeUsd`
 * (SendManager.tsx) is `undefined` in all three and `Route.tsx` paints the same
 * "—" for each. It also passes on a wrong answer: `$0.00` contains a `$`.
 *
 * When it broke for real, the failure read `Expected substring: "$" / Received
 * "Fast—~30 sec"` and a 60s timeout — which says nothing about the cause and cost
 * a long manual investigation to attribute.
 *
 * This module captures the two things that actually explain it:
 *   1. `__TEST_EPOCH_QUOTE__` — the hook's own state, including the `error` string
 *      `useEpochQuote` records and the product never surfaces.
 *   2. The real HTTP exchange with the Epoch host — status and response body —
 *      observed from the page, so a 5xx/404/schema change names itself.
 */
import type { Page } from '@playwright/test';

/** Hosts whose traffic is the forward quote. Kept broad — subdomains vary by env. */
const EPOCH_HOST_RE = /epochprotocol\.xyz/i;

export interface EpochQuoteState {
  enabled?: boolean;
  loading?: boolean;
  amount?: string | null;
  symbol?: string | null;
  error?: string | null;
  hasToken?: boolean;
  hasAmount?: boolean;
  fiatPrice?: number | null;
}

export interface EpochExchange {
  url: string;
  status: number;
  ok: boolean;
  body: string;
}

/**
 * Start recording Epoch HTTP exchanges on this page. Call once before driving the
 * bridge flow; the returned array fills in as requests complete.
 *
 * Response bodies are truncated — a quote payload is small, and an HTML error page
 * from a proxy is not worth 200KB in the log.
 */
export function captureEpochTraffic(page: Page): EpochExchange[] {
  const seen: EpochExchange[] = [];
  page.on('response', res => {
    const url = res.url();
    if (!EPOCH_HOST_RE.test(url)) return;
    void res
      .text()
      .then(body => {
        seen.push({ url, status: res.status(), ok: res.ok(), body: body.slice(0, 600) });
      })
      .catch(() => {
        seen.push({ url, status: res.status(), ok: res.ok(), body: '<body unavailable>' });
      });
  });
  return seen;
}

/** Read the E2E-only quote-state mirror (undefined when the build lacks the hook). */
export async function readQuoteState(page: Page): Promise<EpochQuoteState | undefined> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).__TEST_EPOCH_QUOTE__ as EpochQuoteState | undefined;
  });
}

/**
 * Wait for the Fast-route forward quote to RESOLVE, and fail with the cause.
 *
 * Success requires a real quote amount — not merely that a `$` rendered — so a
 * `$0.00` produced by a missing fiat price no longer counts as a working quote.
 *
 * On timeout the thrown error names which of the three preconditions failed and,
 * when the quote itself was attempted, includes the hook's error string and the
 * last Epoch HTTP status/body. That turns "a character never appeared" into
 * "the quote service answered 503" without a manual investigation.
 */
export async function waitForFastQuote(
  page: Page,
  traffic: EpochExchange[],
  opts: { timeoutMs?: number } = {}
): Promise<EpochQuoteState> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let state: EpochQuoteState | undefined;

  while (Date.now() < deadline) {
    state = await readQuoteState(page);
    if (state?.amount != null && String(state.amount).length > 0) return state;
    // A captured error is terminal — the hook does not retry on its own, so
    // waiting out the remaining budget only delays an identical failure.
    if (state?.error) break;
    await page.waitForTimeout(1_000);
  }

  throw new Error(buildQuoteFailure(state, traffic, timeoutMs));
}

/** Compose the human explanation. Exported so a spec can attach it to a soft failure. */
export function buildQuoteFailure(
  state: EpochQuoteState | undefined,
  traffic: EpochExchange[],
  timeoutMs: number
): string {
  const lines: string[] = [];
  lines.push(`Epoch forward quote did not resolve within ${timeoutMs}ms.`);

  if (!state) {
    lines.push(
      '  quote state: UNAVAILABLE — window.__TEST_EPOCH_QUOTE__ is not set.',
      '  That means the build lacks the E2E quote hook (MIDEN_E2E_TEST not "true" at build time),',
      '  or the send flow never mounted SendManager. This is a harness/build problem, not a service one.'
    );
  } else {
    lines.push(
      `  route is bridge (quote enabled): ${state.enabled}`,
      `  token loaded: ${state.hasToken}   amount parsed: ${state.hasAmount}   fiatPrice: ${state.fiatPrice ?? 'null'}`,
      `  quote loading: ${state.loading}   amount: ${state.amount ?? 'null'}   symbol: ${state.symbol ?? 'null'}`,
      `  quote error: ${state.error ?? 'none'}`
    );
    // Name the precondition that failed, so the reader does not have to infer it.
    if (state.enabled === false) {
      lines.push('  → CAUSE: the route was not treated as a bridge, so no quote was ever requested.');
    } else if (!state.hasToken) {
      lines.push('  → CAUSE: no token selected/loaded — the quote could not be requested.');
    } else if (!state.hasAmount) {
      lines.push('  → CAUSE: the amount did not parse — the quote could not be requested.');
    } else if (state.error) {
      lines.push(`  → CAUSE: the quote request FAILED: ${state.error}`);
    } else if (state.loading) {
      lines.push('  → CAUSE: the quote request never settled (still loading at the deadline).');
    }
  }

  if (traffic.length === 0) {
    lines.push('  Epoch HTTP: no requests to epochprotocol.xyz were observed from the page.');
  } else {
    lines.push('  Epoch HTTP (most recent last):');
    for (const x of traffic.slice(-4)) {
      lines.push(`    ${x.status} ${x.ok ? 'OK ' : 'ERR'} ${x.url}`);
      if (!x.ok || x.body) lines.push(`      body: ${x.body.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }

  return lines.join('\n');
}
