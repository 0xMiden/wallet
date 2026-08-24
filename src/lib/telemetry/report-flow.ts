import { nanoid } from 'nanoid';

import { request } from 'lib/miden/front';
import { WalletMessageType } from 'lib/shared/types';

import { TelemetryErrorKind, TelemetryEvent, TelemetryFlow, TelemetryRunId, TelemetryStep } from './types';

/**
 * How long a run may sit idle before the next event starts a new one.
 *
 * A bound on how much of one person's activity any single id can cover. Half an
 * hour is long enough that stepping away from a half-finished send and coming
 * back still reads as one visit, and short enough that a wallet left open in a
 * background tab overnight does not link tomorrow's activity to today's.
 */
export const RUN_IDLE_ROTATE_MS = 30 * 60 * 1000;

let runId: TelemetryRunId | null = null;
let lastEventAt = 0;

/**
 * Mark activity and return the id for the run it belongs to, rotating first if
 * the run has gone stale.
 *
 * Module scope, which in every context the wallet runs in means the lifetime of
 * one page: the extension's popup, its full-page tab and each dApp prompt window
 * are separate runs, and so is each launch of the mobile app. Nothing is written
 * anywhere, so there is no id to survive a reload — which is the property that
 * keeps this ephemeral rather than a durable install identifier.
 *
 * Every write to `lastEventAt` goes through here. A bare write would re-arm the
 * idle clock without ever testing it, so a run that had already outlived the
 * window would be resurrected instead of retired and the bound below would not
 * hold at all.
 */
function touchRun(): TelemetryRunId {
  const now = Date.now();
  // A backward jump — an NTP correction, say — makes the elapsed time negative
  // and would otherwise suppress rotation indefinitely. Rotating on it errs in
  // the safe direction, since an extra run only ever splits activity apart.
  if (runId === null || now < lastEventAt || now - lastEventAt > RUN_IDLE_ROTATE_MS) {
    runId = nanoid();
  }
  lastEventAt = now;
  return runId;
}

/** Test-only: forget the current run, as a fresh page load would. */
export function __resetRunForTest(): void {
  runId = null;
  lastEventAt = 0;
}

export interface FlowHandle {
  complete(): void;
  cancel(): void;
  fail(kind: TelemetryErrorKind): void;
  /**
   * Record the furthest step reached. Emits nothing on its own — the value rides
   * out on `ended`, so progress costs no extra events and an abandoned flow
   * still reports where it stopped.
   *
   * Monotonic by call order, not by any ranking of the steps: a flow that goes
   * back a screen keeps the furthest step it reported, because for drop-off
   * analysis "got as far as review" is the fact worth keeping.
   */
  step(step: TelemetryStep): void;
}

function report(event: TelemetryEvent): void {
  void (async () => {
    try {
      await request({ type: WalletMessageType.ReportTelemetryEventRequest, event });
    } catch {
      // Telemetry must never surface as a user-visible failure.
    }
  })();
}

/**
 * Begin reporting a flow.
 *
 * Two events are emitted per flow rather than one. A single terminal event
 * would be lost whenever a user force-quits or the popup is dismissed
 * mid-flow — exactly the stuck users this exists to find. With a `started`
 * event already durable, an unmatched `started` IS the abandonment signal,
 * computed on the receiving side.
 *
 * `flowId` is ephemeral: it exists only to pair those two events, is never
 * persisted, and is never reused.
 */
export function beginFlow(flow: TelemetryFlow): FlowHandle {
  const flowId = nanoid();
  // Fixed for the whole flow rather than read again at the end, so a flow that
  // outlives a rotation still reports both of its events under one id and stays
  // pairable.
  const flowRunId = touchRun();
  // Monotonic: a wall-clock adjustment mid-flow must not be able to produce a
  // negative or wildly inflated duration.
  const startedAt = performance.now();
  let settled = false;
  let furthestStep: TelemetryStep | undefined;

  report({ phase: 'started', flow, flowId, runId: flowRunId });

  const end = (result: 'completed' | 'cancelled' | 'errored', errorKind?: TelemetryErrorKind): void => {
    if (settled) return;
    settled = true;
    // Ending counts as activity, so a long deliberation on a review screen keeps
    // the run alive. The event itself still goes out under the id captured at
    // the start, so this cannot split a pair — but if the flow sat open past the
    // idle window, the rotation inside leaves the NEXT flow starting fresh.
    touchRun();
    report({
      phase: 'ended',
      flow,
      flowId,
      runId: flowRunId,
      result,
      durationMs: performance.now() - startedAt,
      ...(errorKind !== undefined ? { errorKind } : {}),
      ...(furthestStep !== undefined ? { step: furthestStep } : {})
    });
  };

  return {
    complete: () => end('completed'),
    cancel: () => end('cancelled'),
    fail: (kind: TelemetryErrorKind) => end('errored', kind),
    // Ignored once settled, like the terminal calls themselves: a screen
    // unmounting after its flow ended must not rewrite where the flow got to.
    step: (step: TelemetryStep) => {
      if (settled) return;
      furthestStep = step;
    }
  };
}

/**
 * Map an error to a broad category. The message is inspected but NEVER
 * returned — the return type is a closed union, so no caught text can reach
 * the wire through this function.
 *
 * The order is deliberate: `timeout` precedes `network` because a timeout
 * message routinely contains both words, and `validation` comes last because
 * `invalid` appears inside many more specific messages.
 */
export function classifyError(error: unknown): TelemetryErrorKind {
  if (!(error instanceof Error)) return 'unknown';
  const message = error.message.toLowerCase();

  if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (message.includes('failed to fetch') || message.includes('network')) return 'network';
  if (message.includes('rpc')) return 'rpc';
  if (message.includes('prov')) return 'proving';
  if (message.includes('quota') || message.includes('store') || message.includes('indexeddb')) return 'storage';
  if (message.includes('password') || message.includes('unauthor') || message.includes('biometric')) return 'auth';
  if (message.includes('invalid') || message.includes('must be') || message.includes('required')) return 'validation';
  return 'unknown';
}
