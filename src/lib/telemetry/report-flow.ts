import { nanoid } from 'nanoid';

import { request } from 'lib/miden/front';
import { WalletMessageType } from 'lib/shared/types';

import { touchRun } from './run';
import { TelemetryErrorKind, TelemetryEvent, TelemetryFlow, TelemetryStep } from './types';

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

// Re-exported rather than moved outright: `classifyError` is half of the public
// API of this module — every `fail(classifyError(e))` call site pairs them — and
// it lives in `./classify` only so the service worker can reach it without
// loading React through this file's intercom import.
export { classifyError } from './classify';
