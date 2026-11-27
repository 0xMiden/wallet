import {
  isDiscoveryFeature,
  isProgressionStep,
  TELEMETRY_DISCOVERY_ACTIONS,
  TELEMETRY_ID_PATTERN,
  TELEMETRY_NAV_SOURCES,
  TELEMETRY_SCREENS,
  TELEMETRY_STEP_ACTIONS,
  TELEMETRY_SURFACES,
  TelemetryContext,
  TelemetryEvent,
  TelemetryWirePayload
} from './types';

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
  'stepAction',
  'screen',
  'navSource',
  'surface',
  'order',
  'complete',
  'feature',
  'entryPoint',
  'discoveryAction',
  'appVersion',
  'platform',
  'network'
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
    platform: context.platform,
    network: context.network
  };

  if (event.phase === 'discovery') {
    if (
      isDiscoveryFeature(event.entryPoint, event.feature) &&
      TELEMETRY_DISCOVERY_ACTIONS.includes(event.discoveryAction) &&
      TELEMETRY_SURFACES.includes(event.surface) &&
      typeof event.runId === 'string' &&
      /^[A-Za-z0-9_-]{21}$/.test(event.runId)
    ) {
      payload.feature = event.feature;
      payload.entryPoint = event.entryPoint;
      payload.discoveryAction = event.discoveryAction;
      payload.surface = event.surface;
    }
    return payload;
  }

  if (event.phase === 'visit') {
    // Every value is a prop the event name or the dashboard groups by, and the offscreen forward is untyped at the
    // wire, so each is checked against its closed list. An unknown one leaves `screen` unset, which the sink refuses
    // as an unnameable event, rather than shipping a string nobody allowlisted.
    const known =
      TELEMETRY_SCREENS.includes(event.screen) &&
      TELEMETRY_NAV_SOURCES.includes(event.source) &&
      TELEMETRY_SURFACES.includes(event.surface) &&
      Number.isFinite(event.order) &&
      Number.isFinite(event.visibleMs);
    if (known) payload.screen = event.screen;
    payload.navSource = event.source;
    payload.surface = event.surface;
    payload.order = Math.round(event.order);
    payload.durationMs = Math.round(event.visibleMs);
    payload.complete = event.complete === true;
    return payload;
  }

  if (event.phase === 'step') {
    if (
      isProgressionStep(event.flow, event.step) &&
      TELEMETRY_STEP_ACTIONS.includes(event.stepAction) &&
      typeof event.flowId === 'string' &&
      TELEMETRY_ID_PATTERN.test(event.flowId) &&
      typeof event.runId === 'string' &&
      TELEMETRY_ID_PATTERN.test(event.runId) &&
      Number.isFinite(event.order) &&
      event.order >= 1 &&
      Number.isFinite(event.visibleMs) &&
      event.visibleMs >= 0
    ) {
      payload.flow = event.flow;
      payload.flowId = event.flowId;
      payload.step = event.step;
      payload.stepAction = event.stepAction;
      payload.order = Math.round(event.order);
      payload.durationMs = Math.round(event.visibleMs);
      payload.complete = event.complete === true;
    }
    return payload;
  }

  // Named per phase rather than copied from a shared shape, so the two kinds of
  // event cannot borrow each other's fields: a flow has no `operation` and a
  // settled operation has no `flow` or `flowId`, and neither can acquire one by
  // accident here.
  if (event.phase === 'settled') {
    payload.operation = event.operation;
    payload.result = event.result;
    // Optional here and only here: some outcomes have no honest interval to
    // report, and an absent field reads as absent where a zero would average.
    if (event.durationMs !== undefined) {
      payload.durationMs = Math.round(event.durationMs);
    }
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
