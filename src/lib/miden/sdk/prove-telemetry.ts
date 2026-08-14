import { isMobile } from 'lib/platform';

/**
 * Always-on, lightweight prove-timing telemetry (#466).
 *
 * `recordProveTiming` (miden-client-interface.ts) is E2E-only string logging.
 * This records STRUCTURED per-prove metrics in a small bounded ring (+ a
 * best-effort `chrome.storage.local` copy so a service-worker restart doesn't
 * lose it) so we can see WHY proving occasionally exceeds 20s: which path ran
 * (delegate / local / native), how long it took, and — the prime suspect —
 * whether the delegated remote prover (which has no client-side timeout) stalled
 * and fell back to local, doubling the wall time. A slow prove is also logged so
 * it shows up in ordinary logs without querying the ring.
 *
 * Telemetry must never affect proving: everything here is wrapped/best-effort.
 */

export const SLOW_PROVE_THRESHOLD_MS = 20_000;
const RING_CAPACITY = 50;
const STORAGE_KEY = 'miden_prove_telemetry';

export interface ProveTelemetryEntry {
  /** epoch ms when the prove completed */
  ts: number;
  /** which prover pathway actually produced the proof */
  path: 'delegate' | 'local' | 'native-mobile';
  /** total wall time the user waited for proving (ms, incl. a fallback) */
  durationMs: number;
  /** true when a delegated remote prove failed and we re-proved locally */
  fellBack: boolean;
  /** how long the remote attempt took before it failed (only when fellBack) */
  remoteDurationMs?: number;
  platform: 'mobile' | 'desktop';
  /** MT-WASM needs this; false on a non-isolated context forces slow ST WASM */
  crossOriginIsolated: boolean;
  /** durationMs exceeded SLOW_PROVE_THRESHOLD_MS — the #466 symptom */
  slow: boolean;
  /** the prove ultimately failed (e.g. remote stalled AND the local re-prove threw) */
  failed?: boolean;
}

const ring: ProveTelemetryEntry[] = [];

export interface ProveSample {
  path: ProveTelemetryEntry['path'];
  durationMs: number;
  fellBack: boolean;
  remoteDurationMs?: number;
  failed?: boolean;
}

/**
 * Record one prove's timing. Never throws and never affects the prove — the
 * whole body is wrapped, since it runs on the hot proving path (a stray throw
 * here would otherwise be misread by `proveWithFallback`'s try/catch as a prove
 * failure). Returns the stored entry, or undefined if recording was skipped.
 */
export function recordProveTelemetry(sample: ProveSample): ProveTelemetryEntry | undefined {
  try {
    const entry: ProveTelemetryEntry = {
      ts: Date.now(),
      path: sample.path,
      durationMs: Math.round(sample.durationMs),
      fellBack: sample.fellBack,
      ...(sample.remoteDurationMs !== undefined ? { remoteDurationMs: Math.round(sample.remoteDurationMs) } : {}),
      ...(sample.failed ? { failed: true } : {}),
      platform: isMobile() ? 'mobile' : 'desktop',
      crossOriginIsolated:
        typeof globalThis !== 'undefined' && !!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated,
      slow: sample.durationMs > SLOW_PROVE_THRESHOLD_MS
    };

    ring.push(entry);
    while (ring.length > RING_CAPACITY) ring.shift();

    if (entry.slow) {
      console.warn(
        `[prove-telemetry] slow prove ${entry.durationMs}ms path=${entry.path} fellBack=${entry.fellBack}` +
          (entry.remoteDurationMs !== undefined ? ` remoteMs=${entry.remoteDurationMs}` : '') +
          (entry.failed ? ' FAILED' : '') +
          ` (>${SLOW_PROVE_THRESHOLD_MS}ms — #466)`
      );
    }

    void persist();
    return entry;
  } catch {
    // Telemetry must NEVER break or slow a prove.
    return undefined;
  }
}

/** A snapshot of the in-memory ring (newest last). */
export function getProveTelemetry(): ProveTelemetryEntry[] {
  return [...ring];
}

/** Test-only: clear the ring. */
export function __resetProveTelemetryForTest(): void {
  ring.length = 0;
}

async function persist(): Promise<void> {
  try {
    const c = (globalThis as { chrome?: { storage?: { local?: { set?: (o: object) => Promise<void> } } } }).chrome;
    if (c?.storage?.local?.set) {
      await c.storage.local.set({ [STORAGE_KEY]: ring });
    }
  } catch {
    // best-effort — telemetry must never break or slow a prove.
  }
}
