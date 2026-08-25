import type { Page } from '@playwright/test';

/**
 * Report what the OFFSCREEN realm has been doing when proving — the one realm the
 * harness cannot observe directly, and the one every wallet write runs in.
 *
 * With `MIDEN_USE_OFFSCREEN_CLIENT` on (the service worker's default), a consume or
 * send is dispatched whole-operation into `offscreen.html` and executes, proves and
 * submits there. The fixtures attach console capture to pages, to the service worker
 * and to page-spawned web workers; an offscreen document is none of those. It is a
 * hidden target, absent from `context.pages()`, and Playwright exposes no handle to
 * it — so its console, and with it every `[prove-timing]` marker narrating a write's
 * progress, went to a listener that does not exist. A write that never returned left
 * no trace anywhere in the artifacts (#718).
 *
 * The way in is `chrome.storage.local`, which the offscreen document and the service
 * worker share. `prove-telemetry.ts` already merges its ring there under one key,
 * tagging each entry with the realm that recorded it, precisely so a prove's duration
 * can be attributed across realms. The service worker IS reachable from Playwright,
 * so reading that key from the worker yields the offscreen realm's own measurements
 * without any new wallet-side plumbing.
 *
 * WHAT THIS CAN AND CANNOT SEE. Telemetry is recorded when a prove SETTLES, so a
 * prove that is still hanging contributes nothing — its absence is the signal. What
 * the settled entries answer is the question that actually distinguishes the failure
 * modes: whether proving is reaching the remote prover at all (`path`), whether the
 * remote leg is failing into a local re-prove (`fellBack`, `remoteDurationMs`), and
 * whether multi-threaded WASM is even available (`crossOriginIsolated` — false forces
 * the far slower single-threaded path).
 *
 * Best-effort throughout: this is diagnostics, and instrumentation must never be the
 * reason a spec fails.
 */

/** Mirrors `ProveTelemetryEntry` in `src/lib/miden/sdk/prove-telemetry.ts`. */
export interface ProveTelemetryEntry {
  ts: number;
  path: 'delegate' | 'local' | 'native-mobile';
  durationMs: number;
  fellBack: boolean;
  remoteDurationMs?: number;
  crossOriginIsolated: boolean;
  slow: boolean;
  failed?: boolean;
  realm?: 'offscreen' | 'inline';
}

const STORAGE_KEY = 'miden_prove_telemetry';

/**
 * Read the merged prove-telemetry ring via the extension's service worker.
 *
 * Returns an empty array when there is no service worker, when the key has not been
 * written yet (no prove has settled), or on any failure.
 */
export async function readProveTelemetry(page: Page): Promise<ProveTelemetryEntry[]> {
  try {
    const worker = page.context().serviceWorkers()[0];
    if (!worker) return [];
    const entries = await worker.evaluate(async (key: string) => {
      const chromeApi = (globalThis as unknown as { chrome?: { storage?: { local?: { get?: unknown } } } }).chrome;
      const local = chromeApi?.storage?.local as { get?: (k: string) => Promise<Record<string, unknown>> } | undefined;
      if (!local?.get) return [];
      const raw = (await local.get(key))?.[key];
      return Array.isArray(raw) ? raw : [];
    }, STORAGE_KEY);
    return entries as ProveTelemetryEntry[];
  } catch {
    return [];
  }
}

/** One entry rendered as a single readable line. */
function formatEntry(e: ProveTelemetryEntry): string {
  const parts = [
    `path=${e.path}`,
    `${Math.round(e.durationMs)}ms`,
    `realm=${e.realm ?? '?'}`,
    `fellBack=${e.fellBack}`,
    e.remoteDurationMs !== undefined ? `remoteMs=${Math.round(e.remoteDurationMs)}` : '',
    `mtWasm=${e.crossOriginIsolated}`,
    e.failed ? 'FAILED' : ''
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * Print what proving has actually been doing to the test's stdout.
 *
 * `console.log` on purpose rather than the timeline alone: it streams into the live
 * job log, so a stalled claim can be diagnosed WHILE the run is going rather than
 * from artifacts half an hour later.
 */
export async function dumpProveTelemetry(page: Page, context: string): Promise<void> {
  const entries = await readProveTelemetry(page);
  if (entries.length === 0) {
    // Not "no data" so much as "no prove has finished" — which, during a stalled
    // claim, is itself the finding worth seeing.
    // eslint-disable-next-line no-console
    console.log(`[prove-telemetry] ${context}: no settled proves recorded`);
    return;
  }
  const tail = entries.slice(-6);
  // eslint-disable-next-line no-console
  console.log(`[prove-telemetry] ${context}: ${entries.length} settled prove(s), last ${tail.length}:`);
  for (const entry of tail) {
    // eslint-disable-next-line no-console
    console.log(`[prove-telemetry]   ${formatEntry(entry)}`);
  }
}
