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

/**
 * What a `settled` event is about: one operation the wallet carried out on the
 * user's behalf, after the screen that asked for it was done.
 *
 * A separate union from `TelemetryFlow` because these are not things a person
 * did — they are things the wallet did, and they succeed or fail long after the
 * flow that started them reported `completed`. Every send, swap, claim, earn
 * movement, bridge, and guardian operation becomes one of these, which is what
 * makes "did it actually land" answerable at all.
 *
 * Coarser than the transaction types in `ITransactionType` on purpose. These
 * names are a reporting vocabulary, and a new row type appearing in the database
 * should not silently mint a new event name in the dashboard — it maps onto
 * `other` until somebody decides it deserves its own.
 */
export type TelemetryOperation =
  | 'tx_send'
  | 'tx_receive'
  | 'tx_swap'
  | 'tx_earn'
  | 'tx_bridge'
  | 'tx_guardian'
  | 'tx_dapp'
  | 'tx_other'
  // Not a transaction: one prove attempt, whose outcome says whether the
  // delegated prover is healthy and whether the user paid for a fallback.
  | 'prove'
  // Not transactions: an outage of something the wallet depends on. The category
  // is in the name rather than in a field so a dashboard can chart one service
  // without unpacking props. Reported twice — `errored` when the outage begins
  // and `completed` with a duration when it lifts — so an outage the user never
  // saw the end of still reports that it started.
  | 'service_prover'
  | 'service_node'
  | 'service_network';

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
  | 'awaiting_approval'
  // Pipeline stages, for a `settled` operation rather than a screen. Where a
  // transaction died is the difference between "the prover is down" and "the
  // node rejected it", and it is the single most diagnostic fact a failure
  // carries. Mapped from the row's own `stage`, which the pipeline already
  // records for the progress screen — `submitting` above is deliberately the
  // same name, being the same moment seen from the two sides.
  | 'syncing'
  | 'executing'
  | 'proving'
  | 'confirming'
  | 'signing'
  // Which prover produced the proof, for a `prove` operation. `prove_fallback`
  // is the case worth watching: the delegated prover failed, the local one
  // picked it up, the transaction succeeded, and the user waited twice.
  | 'prove_delegate'
  | 'prove_local'
  | 'prove_fallback';

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

/**
 * The identifier shared by every flow in one run of the app.
 *
 * Minted in memory when the app starts and thrown away when it stops. It is
 * what makes a sequence of events readable as something a person did — "opened
 * the wallet, went to swap, gave up at review, sent instead" — which the
 * per-flow id alone can never express, since it is by construction unrelated to
 * every other id.
 *
 * The trade is deliberate and bounded. Within one run, the flows a person
 * performed are linkable to each other; across runs, and across devices,
 * nothing is. It touches no storage, so an app restart mints a fresh one, and
 * it rotates on its own after `RUN_IDLE_ROTATE_MS` so a window left open for a
 * week is not one week-long trail.
 */
export type TelemetryRunId = string;

export interface FlowStartedEvent {
  phase: 'started';
  flow: TelemetryFlow;
  /**
   * Ephemeral, in-memory, never persisted. Exists only to join this event to
   * its `ended` counterpart so an unmatched `started` can be read as an
   * abandoned flow. Never reused.
   */
  flowId: string;
  runId: TelemetryRunId;
}

export interface FlowEndedEvent {
  phase: 'ended';
  flow: TelemetryFlow;
  flowId: string;
  runId: TelemetryRunId;
  result: TelemetryResult;
  errorKind?: TelemetryErrorKind;
  durationMs: number;
  /**
   * Furthest step reached. Absent for single-screen flows, which have no step
   * worth naming, and for a flow abandoned before it recorded one.
   */
  step?: TelemetryStep;
}

/**
 * One operation the wallet finished, reported after the fact.
 *
 * A single event rather than a pair, unlike a flow. A flow is reported twice
 * because the user can walk away from it, and an unmatched `started` is what
 * makes abandonment visible. An operation cannot be abandoned — the wallet
 * either finished it or failed it — so there is nothing for a second event to
 * disambiguate, and minting a `started` for one would add unmatched events to
 * the very population the abandonment signal is computed from.
 *
 * It carries no `flowId` for the same reason: there is no sibling to pair with.
 * Linking a settlement back to the flow that started it would mean writing a
 * telemetry identifier onto the transaction row, and that row is durable storage
 * — which would turn an in-memory id into a persisted one and break the
 * guarantee outright. So the two are joined by time and run, or not at all.
 */
export interface OperationSettledEvent {
  phase: 'settled';
  operation: TelemetryOperation;
  runId: TelemetryRunId;
  /** `completed` or `errored`. An operation is never `cancelled` by the user. */
  result: Exclude<TelemetryResult, 'cancelled'>;
  errorKind?: TelemetryErrorKind;
  /** How long the wallet spent on it, end to end. */
  durationMs: number;
  /** Where it got to: the pipeline stage, or which prover ran. */
  step?: TelemetryStep;
}

export type TelemetryEvent = FlowStartedEvent | FlowEndedEvent | OperationSettledEvent;

/** Derived in the background. Callers cannot supply these. */
export interface TelemetryContext {
  appVersion: string;
  platform: TelemetryPlatform;
}

export interface TelemetryWirePayload {
  phase: 'started' | 'ended' | 'settled';
  /** Present on the two flow phases. Absent on `settled`. */
  flow?: TelemetryFlow;
  /** Present on `settled`. Absent on the two flow phases. */
  operation?: TelemetryOperation;
  /** Pairs the two halves of a flow. A `settled` event has no pair — see above. */
  flowId?: string;
  runId: TelemetryRunId;
  result?: TelemetryResult;
  errorKind?: TelemetryErrorKind;
  durationMs?: number;
  step?: TelemetryStep;
  appVersion: string;
  platform: TelemetryPlatform;
}
