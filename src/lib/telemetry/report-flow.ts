import { nanoid } from 'nanoid';

import { request } from 'lib/miden/front';
import { WalletMessageType } from 'lib/shared/types';

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
  // Monotonic: a wall-clock adjustment mid-flow must not be able to produce a
  // negative or wildly inflated duration.
  const startedAt = performance.now();
  let settled = false;
  let furthestStep: TelemetryStep | undefined;

  report({ phase: 'started', flow, flowId });

  const end = (result: 'completed' | 'cancelled' | 'errored', errorKind?: TelemetryErrorKind): void => {
    if (settled) return;
    settled = true;
    report({
      phase: 'ended',
      flow,
      flowId,
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
