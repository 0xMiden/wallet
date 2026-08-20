/**
 * Telemetry domain types.
 *
 * Every field is a closed literal union or a number. There is deliberately no
 * free-form `string` field, no `object` field, and no index signature anywhere
 * in `TelemetryWirePayload`. That is the design's primary privacy guarantee: an
 * address, an amount, a note id, or an `error.message` has no field it could
 * occupy, so it fails `yarn ts` before any test runs.
 *
 * Do not add a `string` field to the wire payload. Add a literal union.
 */

export type TelemetryFlow =
  | 'open'
  | 'unlock'
  | 'create'
  | 'import'
  | 'recover'
  | 'return'
  | 'fund'
  | 'receive_share'
  | 'send'
  | 'note_handle'
  | 'activity_view';

export type TelemetryResult = 'completed' | 'cancelled' | 'errored';

/** Broad categories only. Never a message, code, or detail string. */
export type TelemetryErrorKind =
  | 'network'
  | 'rpc'
  | 'proving'
  | 'validation'
  | 'storage'
  | 'auth'
  | 'timeout'
  | 'unknown';

export type TelemetryPlatform = 'extension' | 'ios' | 'android';

export interface FlowStartedEvent {
  phase: 'started';
  flow: TelemetryFlow;
  /**
   * Ephemeral, in-memory, never persisted. Exists only to join this event to
   * its `ended` counterpart so an unmatched `started` can be read as an
   * abandoned flow. Never reused.
   */
  flowId: string;
}

export interface FlowEndedEvent {
  phase: 'ended';
  flow: TelemetryFlow;
  flowId: string;
  result: TelemetryResult;
  errorKind?: TelemetryErrorKind;
  durationMs: number;
}

export type TelemetryEvent = FlowStartedEvent | FlowEndedEvent;

/** Derived in the background. Callers cannot supply these. */
export interface TelemetryContext {
  appVersion: string;
  platform: TelemetryPlatform;
}

export interface TelemetryWirePayload {
  phase: 'started' | 'ended';
  flow: TelemetryFlow;
  flowId: string;
  result?: TelemetryResult;
  errorKind?: TelemetryErrorKind;
  durationMs?: number;
  appVersion: string;
  platform: TelemetryPlatform;
}
