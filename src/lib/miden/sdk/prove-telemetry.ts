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
 * Since the SDK gained an observation sink, the prove step no longer has to be
 * timed by inference: `lib/telemetry/sdk-observer` hands this module the SDK's
 * own measurement of `proveTransaction` via {@link recordSdkProveStep}, and it
 * lands on the entry as `proveStepMs`. The wallet's own wall-clock number stays
 * the headline figure — it is what the user waited — but the difference between
 * the two is exactly the question #466 asks: was the 25 seconds the prove, or
 * everything around it?
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
  /**
   * The SDK's own measurement of the prove step alone, summed over the attempt
   * (two on a delegate→local fallback). Absent when the prove did not run
   * through the SDK client — the offscreen document proves on its own client in
   * its own realm — and absent when no observation could be attributed.
   */
  proveStepMs?: number;
  /** at least one SDK-measured prove step ended in an error */
  proveStepFailed?: boolean;
}

const ring: ProveTelemetryEntry[] = [];

export interface ProveSample {
  path: ProveTelemetryEntry['path'];
  durationMs: number;
  fellBack: boolean;
  remoteDurationMs?: number;
  failed?: boolean;
}

/** What one SDK-observed prove step contributes. Numbers and a flag, nothing else. */
export interface SdkProveStep {
  durationMs: number;
  failed: boolean;
}

/**
 * One wallet prove attempt, open for as long as `proveWithFallback` is running
 * it, collecting whatever prove steps the SDK reports meanwhile.
 */
export interface ProveAttempt {
  /** Close the attempt and write its entry, enriched with what it collected. */
  record(sample: ProveSample): ProveTelemetryEntry | undefined;
  /** Close the attempt without writing an entry. Idempotent. */
  end(): void;
}

interface OpenAttempt {
  stepMs: number;
  steps: number;
  failed: boolean;
}

/**
 * Attempts currently running. Normally exactly one: the WASM call chain
 * serializes local proving, and the user drives one transaction at a time.
 */
const openAttempts = new Set<OpenAttempt>();

/**
 * Take one SDK prove-step observation, from `lib/telemetry/sdk-observer`.
 *
 * Attributed only when exactly one attempt is open. With none open the step
 * belongs to nothing this module measures (a guardian pipeline prove, say);
 * with several open there is no way to tell whose it is, and a number filed
 * under the wrong prove is worse for #466 than no number at all.
 */
export function recordSdkProveStep(step: SdkProveStep): void {
  if (openAttempts.size !== 1) return;
  for (const attempt of openAttempts) {
    if (!Number.isFinite(step.durationMs)) continue;
    attempt.stepMs += step.durationMs;
    attempt.steps++;
    if (step.failed) attempt.failed = true;
  }
}

/** Open an attempt. The caller must `end()` it, whether or not it records. */
export function beginProveAttempt(): ProveAttempt {
  const state: OpenAttempt = { stepMs: 0, steps: 0, failed: false };
  openAttempts.add(state);
  const end = (): void => {
    openAttempts.delete(state);
  };
  return {
    record: sample => {
      end();
      return record(sample, state);
    },
    end
  };
}

/**
 * Record one prove's timing. Never throws and never affects the prove — the
 * whole body is wrapped, since it runs on the hot proving path (a stray throw
 * here would otherwise be misread by `proveWithFallback`'s try/catch as a prove
 * failure). Returns the stored entry, or undefined if recording was skipped.
 */
export function recordProveTelemetry(sample: ProveSample): ProveTelemetryEntry | undefined {
  return record(sample, undefined);
}

function record(sample: ProveSample, attempt: OpenAttempt | undefined): ProveTelemetryEntry | undefined {
  try {
    const observed = attempt !== undefined && attempt.steps > 0 ? attempt : undefined;
    const entry: ProveTelemetryEntry = {
      ts: Date.now(),
      path: sample.path,
      durationMs: Math.round(sample.durationMs),
      fellBack: sample.fellBack,
      ...(sample.remoteDurationMs !== undefined ? { remoteDurationMs: Math.round(sample.remoteDurationMs) } : {}),
      ...(sample.failed ? { failed: true } : {}),
      ...(observed !== undefined ? { proveStepMs: Math.round(observed.stepMs) } : {}),
      ...(observed?.failed === true ? { proveStepFailed: true } : {}),
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
          (entry.proveStepMs !== undefined ? ` proveStepMs=${entry.proveStepMs}` : '') +
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

/** Test-only: clear the ring and any attempt a previous test left open. */
export function __resetProveTelemetryForTest(): void {
  ring.length = 0;
  openAttempts.clear();
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
