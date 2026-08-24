import { TelemetryContext, TelemetryEvent, TelemetryWirePayload } from './types';

/**
 * The complete set of keys that may ever appear on the wire. Exported so the
 * serializer test and the egress guard assert against one source of truth
 * rather than two lists that drift.
 */
export const WIRE_KEYS: readonly string[] = [
  'phase',
  'flow',
  'flowId',
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
    flow: event.flow,
    flowId: event.flowId,
    appVersion: context.appVersion,
    platform: context.platform
  };

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
