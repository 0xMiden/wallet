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
  | 'swap'
  | 'earn'
  | 'dapp_connect'
  | 'dapp_tx'
  | 'guardian_rotate'
  | 'note_handle'
  | 'activity_view';

export type TelemetryResult = 'completed' | 'cancelled' | 'errored';

/**
 * The furthest screen a flow reached, reported on `ended`.
 *
 * Without this, a multi-step flow is unanalysable: an abandoned send and an
 * abandoned swap both arrive as one `flow_started` with no indication of where
 * the user stopped, so "where do people get stuck" — the question this telemetry
 * exists to answer — cannot be asked of the data at all. With it, the
 * distribution of `step` across cancelled flows IS the drop-off funnel.
 *
 * One union shared by every flow rather than one per flow, because the receiving
 * side groups by `flow` anyway and a discriminated pair would make the wire
 * payload's type depend on the flow — which is exactly the kind of open shape
 * this module refuses. Names are screen identities, never user data.
 */
export type TelemetryStep =
  // send
  | 'select_recipient'
  | 'select_amount'
  | 'select_route'
  // send / swap / earn / bridge shared terminal step
  | 'review'
  | 'submitting'
  // swap
  | 'swap_amounts'
  // onboarding — named exhaustively, because first-run drop-off is the single
  // most actionable funnel the wallet has and a partial map would leave the
  // gaps invisible rather than merely unnamed
  | 'choose_protection'
  | 'setup_passcode'
  | 'setup_biometric'
  | 'set_password'
  | 'recovery_method'
  | 'choose_guardian'
  | 'enter_phrase'
  // dApp approval
  | 'awaiting_approval';

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
  /**
   * Furthest step reached. Absent for single-screen flows, which have no step
   * worth naming, and for a flow abandoned before it recorded one.
   */
  step?: TelemetryStep;
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
  step?: TelemetryStep;
  appVersion: string;
  platform: TelemetryPlatform;
}
