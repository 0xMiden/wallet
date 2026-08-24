import { TelemetryContext, TelemetryEvent, TelemetryWirePayload } from './types';

/**
 * The complete set of keys that may ever appear on the wire. Exported so the
 * serializer test and the egress guard assert against one source of truth
 * rather than two lists that drift.
 */
export const WIRE_KEYS: readonly string[] = [
  'phase',
  'flow',
  'operation',
  'flowId',
  'runId',
  'result',
  'errorKind',
  'durationMs',
  'step',
  'appVersion',
  'platform'
];

/**
 * Build the outbound payload field by field.
 *
 * This function must never spread. Spreading an event or a context into the
 * payload would let a future field reach the wire without appearing here, which
 * is exactly the failure mode the allowlist exists to prevent.
 */
export function serializeEvent(event: TelemetryEvent, context: TelemetryContext): TelemetryWirePayload {
  const payload: TelemetryWirePayload = {
    phase: event.phase,
    runId: event.runId,
    appVersion: context.appVersion,
    platform: context.platform
  };

  // Named per phase rather than copied from a shared shape, so the two kinds of
  // event cannot borrow each other's fields: a flow has no `operation` and a
  // settled operation has no `flow` or `flowId`, and neither can acquire one by
  // accident here.
  if (event.phase === 'settled') {
    payload.operation = event.operation;
    payload.result = event.result;
    payload.durationMs = Math.round(event.durationMs);
    if (event.errorKind !== undefined) {
      payload.errorKind = event.errorKind;
    }
    if (event.step !== undefined) {
      payload.step = event.step;
    }
    return payload;
  }

  payload.flow = event.flow;
  payload.flowId = event.flowId;

  if (event.phase === 'ended') {
    payload.result = event.result;
    payload.durationMs = Math.round(event.durationMs);
    if (event.errorKind !== undefined) {
      payload.errorKind = event.errorKind;
    }
    if (event.step !== undefined) {
      payload.step = event.step;
    }
  }

  return payload;
}
