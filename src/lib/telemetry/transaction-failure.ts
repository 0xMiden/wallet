import { GUARDIAN_ERROR_CODES } from '@openzeppelin/guardian-client';

import { isOperationAbortedError } from 'lib/miden/back/offscreen-codec';
import type { ITransactionStage, ITransactionType } from 'lib/miden/db/types';
import {
  causeChain,
  errorMessageParts,
  isClientTerminatedError,
  isIndefiniteSubmitOutcomeError
} from 'lib/miden/sdk/sdk-error-code';
import { isWasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import {
  QUEUE_SIGHTINGS,
  type QueueAdmissionObservation,
  type QueueSighting
} from 'lib/miden/transaction/queue-admission-diagnostics';
import { isDesktop } from 'lib/platform';
import { isHotKeyFailure } from 'lib/secure-hot-key/failure';
import { isReownIOSCallFailure } from 'lib/walletconnect/native-request-failure';

import {
  type BridgeReceiveFailure,
  bridgeReceiveIdentity,
  bridgeReceiveNativeFailure,
  REOWN_NATIVE_ORIGINS,
  REOWN_WALLET_RESPONSE_CODES,
  REOWN_REQUEST_AGES,
  REOWN_PUBLICATIONS,
  REOWN_BACKGROUND_ANSWERS
} from './bridge-receive-failure';
import { classifyError } from './classify';
import { safeOwnDiagnosticData } from './closed-root-diagnostics';
import { resolveTelemetryContext } from './context';
import { captureCrash } from './crash';
import { annotateCrash, errorChain, snapshotCrashDiagnostics } from './crash-diagnostics';
import { annotateGuardianProving, snapshotGuardianProving } from './guardian-proving-diagnostics';
import { transferOffscreenDeadline } from './offscreen-deadline-diagnostics';
import { annotateProofWaitAvailability, snapshotProofWaitAvailability } from './proof-wait-availability-diagnostics';
import { transferProposalCreateDiagnostics } from './proposal-create-diagnostics';
import assertions from './protocol-assertions.json';
import type { ReapStartRelation } from './reap-start-diagnostics';
import {
  annotateTerminalReport,
  PREFLIGHT_SYNC_REPORTS,
  QUEUE_HIDDEN_BUCKETS,
  type PreflightSyncReport,
  type QueueHiddenBucket
} from './terminal-report-diagnostics';
import {
  AUTH_LAYOUTS,
  COMMITMENT_MATCHES,
  ACCOUNT_AUTH_CODES,
  snapshotTransactionExecution
} from './transaction-execution-diagnostics';
import { operationOfType, stepOfStage, TRANSACTION_OPERATIONS, TRANSACTION_STEPS } from './transaction-operation';
import { TELEMETRY_ERROR_KINDS } from './types';
import packageJson from '../../../package.json';

export { AUTH_LAYOUTS, COMMITMENT_MATCHES, ACCOUNT_AUTH_CODES } from './transaction-execution-diagnostics';

export const AUTH_PREPARATIONS = ['provided', 'wallet_enriched', 'unchanged', 'failed', 'unavailable'] as const;

export interface TransactionFailureDiagnostics {
  authPreparation: (typeof AUTH_PREPARATIONS)[number];
  authLayout: (typeof AUTH_LAYOUTS)[number];
  commitmentMatch: (typeof COMMITMENT_MATCHES)[number];
  accountAuthCode?: (typeof ACCOUNT_AUTH_CODES)[number];
}

export const FAILURE_REASONS = [
  'user_cancelled',
  'interrupted_on_startup',
  'stuck_reaped',
  'queued_expired',
  'rotation_key_pending',
  'rotation_funding_note_unavailable',
  'rotation_funding_not_native',
  'rotation_gate_refusal',
  'consume_not_landed',
  'consume_landed_external',
  'note_invalid',
  'never_committed'
] as const;

/** A failure the wallet itself decided, named by the caller because its stored text is never sent. */
export type TransactionFailureReason = (typeof FAILURE_REASONS)[number];

/** Which check proved a `never_committed` row dead; `mixed` when its attempts were proved dead by different ones. */
export const NEVER_COMMITTED_RULES = ['expired', 'superseded', 'spent_elsewhere', 'mixed'] as const;

export type NeverCommittedRule = (typeof NEVER_COMMITTED_RULES)[number];

/** Identities the reporter names itself, beside the reasons, refusals and protocol identities. */
export const REPORTED_IDENTITIES = [
  'submit_outcome_unknown',
  'submit_rejected',
  'kernel_assertion_outside_shipped_sources',
  'kernel_u32_assertion_outside_shipped_sources',
  'kernel_assertion_without_message',
  'kernel_u32_assertion_without_message',
  'advice_stack_read_failed',
  'client_terminated',
  'transaction_execution_failed',
  'hot_key',
  // Followed by the Guardian's HTTP status: a whole number from 100 to 599, or `other`.
  'guardian_http_'
] as const;

/** Every identity the reporter coins passes through here, so it cannot send one the list, and the policy, lacks. */
const coined = (identity: (typeof REPORTED_IDENTITIES)[number]): string => identity;

export const SUBMIT_GRPC_STATUSES = [
  'unavailable',
  'internal',
  'cancelled',
  'aborted',
  'data_loss',
  'deadline_exceeded',
  'unknown',
  'not_found',
  'invalid_argument',
  'permission_denied',
  'already_exists',
  'resource_exhausted',
  'failed_precondition',
  'out_of_range',
  'unimplemented',
  'unauthenticated',
  'other'
] as const;

// The statuses miden-client 0.17.3's `is_indeterminate_submission` reads as an unknown outcome, and the fallback.
export const SUBMIT_UNKNOWN_OUTCOME_STATUSES = [
  'unavailable',
  'internal',
  'cancelled',
  'aborted',
  'data_loss',
  'deadline_exceeded',
  'unknown',
  'other'
] as const;

export const SUBMIT_ENDPOINTS = [
  'submit_proven_transaction',
  'submit_proven_batch',
  'get_transaction_encryption_key',
  'other'
] as const;

export const SUBMIT_NODE_ERRORS = [
  'internal',
  'expired',
  'state_conflict',
  'capacity_exceeded',
  'missing_fee',
  'consumes_inflight_fee_notes',
  'invalid_fee_asset',
  'batch_id_mismatch',
  'authentication_failed',
  'unknown_code',
  'none',
  'other'
] as const;

export const SUBMIT_HIDDEN_ANSWERS = ['yes', 'no', 'unavailable'] as const;

export const SUBMIT_LEG_BUCKETS: readonly ['under_9s', '9_to_11s', 'over_11s', 'unavailable'] = [
  'under_9s',
  '9_to_11s',
  'over_11s',
  'unavailable'
];

/**
 * How long a transaction waited between its execution and its submit, against the blocks its expiration allows. The
 * wait is converted at an estimated block time, so a bucket only separates a wait that was a fraction of the window
 * from one that used it up.
 */
export const PROOF_WAIT_BUCKETS: readonly ['under_half_window', 'over_half_window', 'past_window', 'unavailable'] = [
  'under_half_window',
  'over_half_window',
  'past_window',
  'unavailable'
];

export const THROWN_CLASSES: readonly [
  'wasm_runtime_error',
  'type_error',
  'range_error',
  'reference_error',
  'syntax_error',
  'error',
  'string',
  'non_error',
  'none'
] = [
  'wasm_runtime_error',
  'type_error',
  'range_error',
  'reference_error',
  'syntax_error',
  'error',
  'string',
  'non_error',
  'none'
];

type ThrownClass = (typeof THROWN_CLASSES)[number];

const THROWN_CLASS_BY_NAME = new Map<unknown, ThrownClass>([
  ['RuntimeError', 'wasm_runtime_error'],
  ['TypeError', 'type_error'],
  ['RangeError', 'range_error'],
  ['ReferenceError', 'reference_error'],
  ['SyntaxError', 'syntax_error']
]);

// The chain the pipeline's kill classifier walks, cut at a length no real error reaches: that walk stops at a kill,
// so a cause accessor that keeps returning new links past one would otherwise hang this report.
const REPORTED_CAUSE_LINKS = 64;

function* reportedCauseChain(error: unknown): Generator<unknown, void, undefined> {
  let links = 0;
  for (const link of causeChain(error)) {
    yield link;
    if (++links === REPORTED_CAUSE_LINKS) return;
  }
}

// The deepest link: a wrapper must not hide the original throw, such as the WASM trap the lock rethrows raw, nor a
// value thrown as a cause.
function thrownClass(error: unknown): ThrownClass {
  let link: unknown;
  for (const cause of reportedCauseChain(error)) if (cause !== undefined && cause !== null) link = cause;
  try {
    if (link instanceof Error) {
      try {
        return THROWN_CLASS_BY_NAME.get(link.name) ?? 'error';
      } catch {
        return 'error';
      }
    }
  } catch {
    // A revoked Proxy throws from instanceof, and a throw out of here would lose the whole report.
    return 'non_error';
  }
  return typeof link === 'string' ? 'string' : link === undefined ? 'none' : 'non_error';
}

export const PIPELINE_KILLS = [
  'offscreen_aborted_deadline',
  'offscreen_aborted_deadline_no_kill',
  'offscreen_aborted_doc_closed',
  'offscreen_aborted_transport',
  'offscreen_aborted_other',
  'wasm_lock_evicted_watchdog',
  'wasm_lock_evicted_realm_error',
  'wasm_lock_evicted_other'
] as const;

type PipelineKill = (typeof PIPELINE_KILLS)[number];

// Facts an offscreen abort carries (miden-client-proxy.ts): whose deadline closed the document, which of its timers
// fired, whether that op was a write, and whether this op's start signal had arrived (a dropped signal reads `no`).
export const OFFSCREEN_DEADLINE_OWNERS = ['own', 'collateral', 'unavailable'] as const;
export const OFFSCREEN_DEADLINE_TIMERS = ['dispatch', 'backstop', 'started', 'resumed', 'unavailable'] as const;
export const OFFSCREEN_DEADLINE_KILLERS = ['write', 'read', 'unavailable'] as const;
export const OFFSCREEN_OP_STARTED = ['yes', 'no', 'unavailable'] as const;

export const EXECUTION_CAUSES = [
  'request_note_consumed',
  'request_note_processing',
  'request_note_unauthenticated',
  'request_duplicate_note',
  'request_empty',
  'request_fee_conversion',
  'request_other',
  'recency_check',
  'account_locked',
  'account_data_not_found',
  'output_mismatch',
  'data_store',
  'store',
  'rpc',
  'fetch_inputs',
  'partial_blockchain_build',
  'block_after_reference',
  'account_not_in_store',
  'block_not_in_store',
  'fetch_asset_witness',
  'foreign_account_not_anchored',
  'note_past_reference_block',
  'kernel_program',
  'summary_block_unknown',
  'summary_expiration_mismatch',
  'summary_commitment_mismatch',
  'signature_failed',
  'executor_other',
  'other'
] as const;

type ExecutionCause = (typeof EXECUTION_CAUSES)[number];

export const SIGNING_STEPS = ['creating_proposal', 'signing_proposal', 'signing_locally'] as const;

export const CONFIRMING_STEPS = [
  'confirming',
  'delivering',
  'registering_guardian',
  'guardian_syncing',
  'guardian_synced'
] as const;

export const CONSUME_ENTRY_POINTS = [
  'auto_consume',
  'claim',
  'claim_all',
  'dapp',
  'bridge_reclaim',
  'swap_settlement',
  'rotation_funding',
  'arcade_gc_purchase'
] as const;

/** What queued a consume row, stamped on the row when it is created. */
export type ConsumeEntryPoint = (typeof CONSUME_ENTRY_POINTS)[number];

export const CONSUME_DEFERRAL_CAUSES = [
  'wallet_locked',
  'preflight_sync_failed',
  'guardian_backpressure',
  'delegated_prover_failed',
  'guardian_rate_limited',
  'guardian_unreachable',
  'guardian_unauthorized'
] as const;

export type ConsumeDeferralCause = (typeof CONSUME_DEFERRAL_CAUSES)[number];

export const CLAIM_FEE_ADMISSIONS = [
  'native_id_unknown',
  'fee_unknown',
  'balance_unknown',
  'ahead_assets_unknown',
  'ahead_native',
  'note_assets_unknown',
  'known_sufficient'
] as const;

export type ClaimFeeAdmission = (typeof CLAIM_FEE_ADMISSIONS)[number];

export const REAP_AGES = ['missing_start', 'past_limit'] as const;

export const REAPED_ATTEMPT_ORIGINS = ['started_here', 'not_started_here'] as const;

export interface ReapSnapshot {
  startRelation?: ReapStartRelation;
  age: (typeof REAP_AGES)[number];
  attempt: (typeof REAPED_ATTEMPT_ORIGINS)[number];
}

/** Which of the startup sweep's rules picked the row: no recorded start, a start before this session, or a start too far ahead. */
export const STARTUP_SELECTIONS = ['missing_start', 'before_session', 'future_stamp'] as const;

/** How long before the sweep the row entered its stored stage. */
export const STORED_STAGE_AGES = ['under_1m', 'under_10m', 'under_1h', 'under_1d', 'over_1d'] as const;

export const QUEUE_AGE_BUCKETS = ['30m_to_1h', '1h_to_6h', '6h_to_24h', 'over_24h', 'unavailable'] as const;
export { QUEUE_SIGHTINGS, PREFLIGHT_SYNC_REPORTS, QUEUE_HIDDEN_BUCKETS };
export type { PreflightSyncReport, QueueHiddenBucket };

export type QueueAgeBucket = (typeof QUEUE_AGE_BUCKETS)[number];

export const SUBMIT_CROSSINGS = ['crossed', 'not_crossed', 'unavailable'] as const;

export const SUBMIT_RECORDS = ['submit_recorded', 'no_submit_recorded'] as const;

export interface StartupSnapshot {
  selection: (typeof STARTUP_SELECTIONS)[number];
  stageAge?: (typeof STORED_STAGE_AGES)[number];
  submit: (typeof SUBMIT_RECORDS)[number];
}

export const FAILURE_POINTS = [
  'pipeline',
  'earn_settlement',
  'bridge_receive_settlement',
  'bridge_send_settlement',
  'guardian_node_verdict',
  'node_verdict'
] as const;

export const FAILURE_OUTCOMES = ['failed', 'unconfirmed'] as const;

export const EXECUTION_REALMS = ['offscreen', 'unknown'] as const;

export const PROVING_PREFERENCES = ['delegated', 'local', 'unknown'] as const;

export const FAILURE_PLATFORMS = ['desktop', 'extension', 'ios', 'android'] as const;

export interface TransactionFailure {
  type: ITransactionType;
  stage?: ITransactionStage;
  reason?: TransactionFailureReason;
  /** Read only with the `never_committed` reason. */
  neverCommittedRule?: NeverCommittedRule;
  error?: unknown;
  /** The failure that preceded an expired `never_committed` verdict; only its fixed identity is reported. */
  priorError?: unknown;
  priorSubmitContext?: { endpoint: string; status: string; hidden: string; leg: string };
  delegateTransaction?: boolean;
  outcome?: (typeof FAILURE_OUTCOMES)[number];
  entryPoint?: ConsumeEntryPoint;
  lastDeferral?: ConsumeDeferralCause;
  feeAdmission?: ClaimFeeAdmission;
  reap?: ReapSnapshot;
  /** Read only with the `interrupted_on_startup` reason. */
  startup?: StartupSnapshot;
  /** Whether the app was hidden while its submit was in flight; undefined when the platform cannot tell. */
  hiddenDuringSubmit?: boolean;
  /** Age bucket for a row that expired while queued; the timestamp and exact age are never reported. */
  queueAge?: QueueAgeBucket;
  queueAdmissionObservation?: QueueAdmissionObservation;
  /** Strongest look the processing loop recorded for this queued wait. */
  queueSighting?: QueueSighting;
  /** Latest pre-send sync step recorded for this queued wait. */
  preflightSync?: PreflightSyncReport;
  /** Hidden time this process recorded while the row waited. */
  queueHidden?: QueueHiddenBucket;
  /** Whether this attempt's committed evidence shows that it reached the submit call. */
  submitCrossing?: (typeof SUBMIT_CROSSINGS)[number];
  /** Milliseconds from the submit stamp to its return; undefined when the row has no submit stamp. */
  submitLegMs?: number;
  /** Blocks the transaction waited from its execution to its submit, at the estimated block time. */
  proofWaitBlocks?: number;
  /** Blocks from the transaction's reference block to its expiration. */
  expiryWindowBlocks?: number;
  /** This transaction's failure was reported before, so this report is evidence for that one, not a second error. */
  alreadyReported?: boolean;
  point?: (typeof FAILURE_POINTS)[number];
  diagnostics?: TransactionFailureDiagnostics;
  /** A failed inbound bridge's route and what failed it, each read against its closed list. */
  bridgeReceive?: BridgeReceiveFailure;
}

function diagnostic<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

// Every code HotKeyPlugin.kt and HotKeyPlugin.swift reject with.
export const HOT_KEY_CODES = [
  'AUTH_FAILED',
  'AUTH_UNAVAILABLE',
  'BAD_CIPHERTEXT',
  'BIOMETRIC_BUSY',
  'DEVICE_LOCKED',
  'HARDWARE_UNAVAILABLE',
  'INVALID_INPUT',
  'KEY_INVALIDATED',
  'KEY_NOT_FOUND',
  'LEGACY_CIPHER_INIT_FAILED',
  'UNWRAP_FAILED',
  'USER_CANCELLED'
];

const listedCode = (code: unknown, allowed: readonly string[]): string =>
  typeof code === 'string' ? diagnostic(code, allowed, 'other') : 'none';

// Read structurally, never from the text: a rejection's message, body and status text can carry account ids, URLs
// and server internals.
function rejectionIdentity(error: unknown, outer: string | undefined): string | undefined {
  for (const link of errorChain(error)) {
    try {
      if (isHotKeyFailure(link)) {
        return `${coined('hot_key')}; hot key code ${listedCode(Reflect.get(link, 'code'), HOT_KEY_CODES)}`;
      }
      if (link.name === 'GuardianHttpError') {
        const status: unknown = Reflect.get(link, 'status');
        const http =
          typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
            ? String(status)
            : 'other';
        const code = Reflect.get(link, 'code') ?? Reflect.get(link, 'rawCode');
        const refusal = `${coined('guardian_http_')}${http}; guardian code ${listedCode(code, GUARDIAN_ERROR_CODES)}`;
        // A Guardian 5xx can carry a deterministic kernel failure (isGuardianOutage in lib/miden/transaction/constants);
        // only its closed-table identity is added, never the text. It is read from the refusal itself: a wrapper's
        // text may not repeat it, or may carry another failure's code.
        const own: unknown = Reflect.get(link, 'message');
        const protocol = (typeof own === 'string' ? protocolIdentity(own) : undefined) ?? outer;
        return protocol === undefined ? refusal : `${refusal}; ${protocol}`;
      }
    } catch {
      // A throwing accessor costs this link, not the report.
    }
  }
  return undefined;
}

// Each chain link is read only this far: an assertion opens its link's text, and a crafted long message must not cost
// the failure path more. Both patterns are fixed text, so each is linear in what it reads.
const PROTOCOL_TEXT_LIMIT = 4096;
const ASSERTION_CODE = /assertion failed with error code:\s{0,8}(\d{1,20})(?!\d)/;
// VM 0.35 `U32AssertionFailed` puts its code after the check's own text, beside the stack values it refused.
const U32_ASSERTION_CODE =
  /u32 assertion failed: u32assert2 requires both stack values to be valid 32-bit unsigned integers; error code:\s{0,8}(\d{1,20})(?!\d)/;

function protocolIdentity(message: string): string | undefined {
  const text = message.slice(0, PROTOCOL_TEXT_LIMIT);
  const assertion = ASSERTION_CODE.exec(text)?.[1];
  const code = assertion ?? U32_ASSERTION_CODE.exec(text)?.[1];
  if (code === undefined) return undefined;
  // Only identities in the MASM sources of the crates the shipped SDK was built from survive
  // (scripts/generate-protocol-assertions.mjs). Arbitrary numbers can be user data.
  if (Object.prototype.hasOwnProperty.call(assertions, code)) return assertions[code as keyof typeof assertions];
  const u32 = assertion === undefined;
  // An assertion written without a message is assembled with code 0.
  if (code === '0') return coined(u32 ? 'kernel_u32_assertion_without_message' : 'kernel_assertion_without_message');
  return coined(u32 ? 'kernel_u32_assertion_outside_shipped_sources' : 'kernel_assertion_outside_shipped_sources');
}

// The pinned SDK's own Display text (miden-client 0.17.3, miden-tx 0.17.1) under web-sdk 0.17.3's "failed to execute
// transaction" chain, matching only its fixed words. A generic wrapper's name must start a chain link.
const EXECUTION_CAUSE_TEXT: ReadonlyArray<readonly [Exclude<ExecutionCause, 'other'>, RegExp]> = [
  ['request_note_consumed', /note with details commitment \S+ has already been consumed/g],
  ['request_note_processing', /note with details commitment \S+ is being consumed by pending transaction/g],
  ['request_note_unauthenticated', /note \S+ cannot be used as an authenticated input/g],
  ['request_duplicate_note', /duplicate input note: note \S+ was added more than once/g],
  ['request_empty', /empty transaction: the request has no input notes and no account state changes/g],
  [
    'request_fee_conversion',
    /the request declares a fee conversion salt but the account's auth component|component reuses the fee conversion salt as a replay guard/g
  ],
  ['request_other', /(?:^|: )invalid transaction request(?=:|$)/g],
  ['recency_check', /(?:^|: )transaction failed a recency check:/g],
  ['account_locked', /account \S+ is locked because the local state may be out of date with the network/g],
  ['account_data_not_found', /account data wasn't found for account id/g],
  ['output_mismatch', /(?:^|: )transaction output mismatch: expected output notes with recipient digests/g],
  ['data_store', /(?:^|: )data store error(?=:|$)/g],
  ['store', /(?:^|: )storage error(?=:|$)/g],
  ['rpc', /(?:^|: )RPC error(?=:|$)/g],
  ['fetch_inputs', /failed to fetch transaction inputs from the data store/g],
  ['partial_blockchain_build', /(?:^|: )error creating PartialBlockchain from internal data(?=:|$)/g],
  ['block_after_reference', /requested block \d+ is after transaction reference block \d+/g],
  ['account_not_in_store', /account with id \S+ not found in data store/g],
  ['block_not_in_store', /block with number \d+ not found in data store/g],
  [
    'fetch_asset_witness',
    /failed to fetch asset witnesses from the data store|failed to get vault asset witness from data store/g
  ],
  ['foreign_account_not_anchored', /foreign account inputs for ID \S+ are not anchored on reference block/g],
  ['note_past_reference_block', /input note \S+ was created in a block past the transaction reference block number/g],
  ['kernel_program', /failed to execute transaction kernel program/g],
  ['summary_block_unknown', /transaction summary binds block \d+, which the transaction does not authenticate/g],
  [
    'summary_expiration_mismatch',
    /transaction summary binds expiration delta \d+ but the transaction's expiration delta is/g
  ],
  ['summary_commitment_mismatch', /transaction returned unauthorized event but a commitment did not match/g],
  ['signature_failed', /failed to generate signature/g],
  ['executor_other', /(?:^|: )transaction execution failed(?=:|$)/g]
];

// What follows these variants in their link is their payload, a node's or a store's own words, never an SDK cause.
const OPAQUE_CAUSE_TEXT = EXECUTION_CAUSE_TEXT.filter(([cause]) => ['rpc', 'store', 'data_store'].includes(cause)).map(
  ([, pattern]) => pattern
);

// The deepest match names the cause: each chain link is the reason for the one before it.
function executionCause(error: unknown): ExecutionCause {
  let found: { cause: ExecutionCause; part: number; at: number } | undefined;
  for (const [index, part] of errorMessageParts(error).entries()) {
    const opaqueAt = Math.min(
      part.length,
      ...OPAQUE_CAUSE_TEXT.map(pattern => part.search(pattern)).filter(at => at !== -1)
    );
    for (const [cause, pattern] of EXECUTION_CAUSE_TEXT) {
      for (const match of part.matchAll(pattern)) {
        if (match.index > opaqueAt) break;
        if (found === undefined || index > found.part || (index === found.part && match.index > found.at)) {
          found = { cause, part: index, at: match.index };
        }
      }
    }
  }
  return found?.cause ?? 'other';
}

// The three stages `stepOfStage` folds into `signing`: a proposal that cannot be built and a co-sign that fails on
// re-execution are different faults.
const SIGNING_STEP_BY_STAGE = new Map<unknown, (typeof SIGNING_STEPS)[number]>([
  ['creating-proposal', 'creating_proposal'],
  ['signing-proposal', 'signing_proposal'],
  ['signing-locally', 'signing_locally']
]);

// The post-submit stages `stepOfStage` folds into `confirming`. `guardian_syncing` is not only a failed sync: a sync
// that throws is caught and leaves this stage on the row while the completion runs, so a completion failure after a
// failed sync reads `guardian_syncing` too. `guardian_synced` is stamped only after a sync that succeeded.
const CONFIRMING_STEP_BY_STAGE = new Map<unknown, (typeof CONFIRMING_STEPS)[number]>([
  ['confirming', 'confirming'],
  ['delivering', 'delivering'],
  ['registering-guardian', 'registering_guardian'],
  ['guardian-syncing', 'guardian_syncing'],
  ['guardian-synced', 'guardian_synced']
]);

// The reasons miden-client-proxy.ts aborts an offscreen operation with, and wasm-client-poison.ts's eviction mechanisms.
// Maps, not objects: a reason is read off a thrown value, and an object lookup would answer for `constructor`.
const OFFSCREEN_ABORTS = new Map<unknown, PipelineKill>([
  ['deadline', 'offscreen_aborted_deadline'],
  ['deadline-no-kill', 'offscreen_aborted_deadline_no_kill'],
  ['doc-closed', 'offscreen_aborted_doc_closed'],
  ['transport', 'offscreen_aborted_transport']
]);
const LOCK_EVICTIONS = new Map<unknown, PipelineKill>([
  ['watchdog', 'wasm_lock_evicted_watchdog'],
  ['realm-error', 'wasm_lock_evicted_realm_error']
]);

function closedFact<T extends string>(read: () => unknown, values: readonly T[], fallback: T): T {
  try {
    const value = read();
    return values.find(listed => listed === value) ?? fallback;
  } catch {
    return fallback;
  }
}

// The facts are read field by field off the thrown value, so a value from another realm or a hostile accessor
// degrades each one to `unavailable` rather than dropping the abort's name.
function offscreenAbortFacts(link: unknown, kill: PipelineKill): string {
  const field = (owner: () => unknown, name: string) => () => {
    const value = owner();
    return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
  };
  const facts = field(() => link, 'facts');
  const startedValue = field(facts, 'started');
  const started = closedFact(
    () => {
      const value = startedValue();
      return value === true ? 'yes' : value === false ? 'no' : undefined;
    },
    OFFSCREEN_OP_STARTED,
    'unavailable'
  );
  if (kill !== 'offscreen_aborted_deadline' && kill !== 'offscreen_aborted_deadline_no_kill') {
    return `${kill}; op start reported ${started}`;
  }
  const deadline = field(facts, 'deadline');
  const owner = closedFact(field(deadline, 'owner'), OFFSCREEN_DEADLINE_OWNERS, 'unavailable');
  const timer = closedFact(field(deadline, 'timer'), OFFSCREEN_DEADLINE_TIMERS, 'unavailable');
  const killer = closedFact(field(deadline, 'killer'), OFFSCREEN_DEADLINE_KILLERS, 'unavailable');
  return `${kill}; deadline owner ${owner}; deadline timer ${timer}; deadline op ${killer}; op start reported ${started}`;
}

// Named by class and reason, never by message: the abort's message carries the operation id.
function killIdentity(error: unknown): string | undefined {
  for (const link of errorChain(error)) {
    try {
      const offscreen = isOperationAbortedError(link);
      if (!offscreen && !isWasmClientPoisonedError(link)) continue;
      let reason: unknown;
      try {
        reason = Reflect.get(link, 'reason');
      } catch {
        reason = undefined;
      }
      if (!offscreen) return LOCK_EVICTIONS.get(reason) ?? 'wasm_lock_evicted_other';
      return offscreenAbortFacts(link, OFFSCREEN_ABORTS.get(reason) ?? 'offscreen_aborted_other');
    } catch {
      // A throwing accessor costs this link, not the report.
    }
  }
  return undefined;
}

// miden-client 0.17.3 `GrpcError` Display, whole except `unknown`'s free text, so a node error after it can be read.
const SUBMIT_GRPC_TEXT: ReadonlyArray<readonly [(typeof SUBMIT_GRPC_STATUSES)[number], string]> = [
  ['unavailable', 'Miden node is unavailable; check that the node is running and reachable'],
  ['internal', 'Miden node returned an internal error; this is likely a node-side issue'],
  ['cancelled', 'operation was cancelled'],
  ['aborted', 'operation was aborted'],
  ['data_loss', 'unrecoverable data loss or corruption'],
  ['deadline_exceeded', 'request to Miden node timed out; the node may be under heavy load'],
  ['unknown', 'unknown error: '],
  ['not_found', 'resource not found'],
  ['invalid_argument', 'invalid request parameters'],
  ['permission_denied', 'permission denied'],
  ['already_exists', 'resource already exists'],
  ['resource_exhausted', "request was rate-limited or the node's resources are exhausted; retry after a delay"],
  ['failed_precondition', 'precondition failed'],
  ['out_of_range', 'operation was attempted past the valid range'],
  ['unimplemented', 'the requested method is not implemented by this version of the Miden node'],
  ['unauthenticated', 'request was rejected as unauthenticated; check your credentials and connection settings']
];

// The node's `AddTransactionError` Display (miden-client 0.17.3), which the SDK puts in parentheses after the status.
// Only these fixed words are read: what follows them is the node's own message, which can carry ids and commitments.
const SUBMIT_NODE_TEXT: ReadonlyArray<readonly [(typeof SUBMIT_NODE_ERRORS)[number], string]> = [
  ['internal', 'internal server error'],
  ['expired', 'transaction expired'],
  ['state_conflict', 'transaction conflicts with current state: '],
  ['capacity_exceeded', 'the mempool is at capacity'],
  ['missing_fee', 'transaction does not contain a canonical fee output note'],
  ['consumes_inflight_fee_notes', 'transaction consumes in-flight fee notes'],
  ['invalid_fee_asset', 'transaction fee output note must use only the native asset'],
  ['batch_id_mismatch', 'batch proof ID does not match the batch ID'],
  ['authentication_failed', 'failed to authenticate transaction: '],
  ['unknown_code', 'unknown error code ']
];

const SUBMIT_ENDPOINT_BY_NAME = new Map<unknown, (typeof SUBMIT_ENDPOINTS)[number]>([
  ['submit_proven_transaction', 'submit_proven_transaction'],
  ['submit_proven_batch', 'submit_proven_batch'],
  ['get_transaction_encryption_key', 'get_transaction_encryption_key']
]);

const REQUEST_FAILED = /grpc request failed for ([a-z_]{1,64}): /;
// web-sdk 0.17.3's contexts for its two submit calls: a request that fails under them is part of the submit.
const SUBMIT_CONTEXT = /failed to submit (?:proven transaction|transaction batch)/;

/** The SDK's request failure inside a submit: the submit request itself, or one the submit made first. */
function submitRequestFailure(error: unknown): { endpoint: string; kind: string } | undefined {
  for (const part of errorMessageParts(error)) {
    const link = part.slice(0, PROTOCOL_TEXT_LIMIT);
    const request = REQUEST_FAILED.exec(link);
    const endpoint = request?.[1];
    if (request === null || endpoint === undefined) continue;
    if (!SUBMIT_CONTEXT.test(link) && endpoint !== 'submit_proven_transaction' && endpoint !== 'submit_proven_batch') {
      continue;
    }
    return { endpoint, kind: link.slice(request.index + request[0].length) };
  }
  return undefined;
}

const grpcStatusOf = (kind: string | undefined) =>
  kind === undefined ? undefined : SUBMIT_GRPC_TEXT.find(([, text]) => kind.startsWith(text));

export interface SubmitGrpcFailure {
  endpoint: (typeof SUBMIT_ENDPOINTS)[number];
  status: (typeof SUBMIT_GRPC_STATUSES)[number];
}

/** The endpoint and gRPC status for an SDK request failure inside a submit. */
export function submitGrpcFailure(error: unknown): SubmitGrpcFailure | undefined {
  const refusal = submitRequestFailure(error);
  if (refusal === undefined) return undefined;
  return {
    endpoint: SUBMIT_ENDPOINT_BY_NAME.get(refusal.endpoint) ?? 'other',
    status: grpcStatusOf(refusal.kind)?.[0] ?? 'other'
  };
}

/** The gRPC status of an SDK request failure inside a submit, or undefined when absent. */
export function submitGrpcStatus(error: unknown): (typeof SUBMIT_GRPC_STATUSES)[number] | undefined {
  return submitGrpcFailure(error)?.status;
}

/**
 * Endpoint and gRPC status of an indefinite submit, or undefined when the error is not that outcome. No parsed
 * gRPC request leaves both `unavailable`, so a measured hidden answer and submit leg still attach. A parsed request
 * keeps its endpoint and its status, with `other` when that status is outside the unknown-outcome list.
 */
function indefiniteSubmitOutcome(error: unknown):
  | {
      endpoint: (typeof SUBMIT_ENDPOINTS)[number] | 'unavailable';
      status: (typeof SUBMIT_UNKNOWN_OUTCOME_STATUSES)[number];
    }
  | undefined {
  if (!isIndefiniteSubmitOutcomeError(error)) return undefined;
  const parsed = submitGrpcFailure(error);
  if (parsed === undefined) return { endpoint: 'unavailable', status: 'unavailable' };
  return {
    endpoint: parsed.endpoint,
    status: SUBMIT_UNKNOWN_OUTCOME_STATUSES.find(value => value === parsed.status) ?? 'other'
  };
}

export function captureSubmitContext(error: unknown, hidden: boolean | undefined, legMs: number | undefined) {
  const outcome = indefiniteSubmitOutcome(error);
  if (outcome === undefined) return undefined;
  const { endpoint, status } = outcome;
  const leg =
    legMs === undefined || !Number.isFinite(legMs) || legMs < 0
      ? 'unavailable'
      : legMs < 9000
        ? 'under_9s'
        : legMs <= 11000
          ? '9_to_11s'
          : 'over_11s';
  return { endpoint, status, hidden: hidden === undefined ? 'unavailable' : hidden ? 'yes' : 'no', leg };
}

function submitContextIdentity(hiddenDuringSubmit: boolean | undefined, submitLegMs: number | undefined): string {
  const hidden: (typeof SUBMIT_HIDDEN_ANSWERS)[number] =
    hiddenDuringSubmit === undefined ? 'unavailable' : hiddenDuringSubmit ? 'yes' : 'no';
  let bucket: (typeof SUBMIT_LEG_BUCKETS)[number] = 'unavailable';
  if (submitLegMs !== undefined && Number.isFinite(submitLegMs) && submitLegMs >= 0) {
    bucket = submitLegMs < 9000 ? 'under_9s' : submitLegMs <= 11000 ? '9_to_11s' : 'over_11s';
  }
  return `app hidden during submit ${hidden}; submit leg ${bucket}`;
}

function submitOutcomeIdentity(
  error: unknown,
  hiddenDuringSubmit: boolean | undefined,
  submitLegMs: number | undefined
): string {
  const outcome = indefiniteSubmitOutcome(error) ?? { endpoint: 'unavailable', status: 'unavailable' };
  const endpoint = outcome.endpoint;
  const status = outcome.status;
  return `${coined('submit_outcome_unknown')}; endpoint ${endpoint}; grpc ${status}; ${submitContextIdentity(
    hiddenDuringSubmit,
    submitLegMs
  )}`;
}

function proofWaitBucket(
  waitBlocks: number | undefined,
  windowBlocks: number | undefined
): (typeof PROOF_WAIT_BUCKETS)[number] {
  if (waitBlocks === undefined || windowBlocks === undefined) return 'unavailable';
  if (!Number.isFinite(waitBlocks) || waitBlocks < 0 || !Number.isFinite(windowBlocks) || windowBlocks <= 0) {
    return 'unavailable';
  }
  const used = waitBlocks / windowBlocks;
  return used < 0.5 ? 'under_half_window' : used <= 1 ? 'over_half_window' : 'past_window';
}

function submitRefusalIdentity(refusal: { endpoint: string; kind: string }, failure: TransactionFailure): string {
  const endpoint = SUBMIT_ENDPOINT_BY_NAME.get(refusal.endpoint) ?? 'other';
  const status = grpcStatusOf(refusal.kind);
  let node: (typeof SUBMIT_NODE_ERRORS)[number] = 'none';
  // `unknown` ends in the node's free text, so where a node error would start cannot be told.
  if (status !== undefined && status[0] !== 'unknown') {
    const after = refusal.kind.slice(status[1].length);
    if (after.startsWith(' (')) node = SUBMIT_NODE_TEXT.find(([, text]) => after.startsWith(text, 2))?.[0] ?? 'other';
  }
  const identity = `${coined('submit_rejected')}; endpoint ${endpoint}; grpc ${status?.[0] ?? 'other'}; node ${node}`;
  // Only an expiry has a window to measure the wait against.
  return node === 'expired'
    ? `${identity}; proof wait ${proofWaitBucket(failure.proofWaitBlocks, failure.expiryWindowBlocks)}`
    : identity;
}

function priorIdentity(failure: TransactionFailure): string {
  const context = failure.priorSubmitContext;
  if (
    context &&
    !isIndefiniteSubmitOutcomeError(failure.priorError) &&
    (SUBMIT_ENDPOINTS.some(value => value === context.endpoint) || context.endpoint === 'unavailable') &&
    SUBMIT_UNKNOWN_OUTCOME_STATUSES.some(value => value === context.status) &&
    SUBMIT_HIDDEN_ANSWERS.some(value => value === context.hidden) &&
    SUBMIT_LEG_BUCKETS.some(value => value === context.leg)
  ) {
    return `${coined('submit_outcome_unknown')}; endpoint ${context.endpoint}; grpc ${context.status}; app hidden during submit ${context.hidden}; submit leg ${context.leg}`;
  }
  const outcome = indefiniteSubmitOutcome(failure.priorError);
  if (
    context &&
    outcome &&
    SUBMIT_HIDDEN_ANSWERS.some(value => value === context.hidden) &&
    SUBMIT_LEG_BUCKETS.some(value => value === context.leg) &&
    outcome.endpoint === context.endpoint &&
    outcome.status === context.status
  ) {
    return `${coined('submit_outcome_unknown')}; endpoint ${context.endpoint}; grpc ${context.status}; app hidden during submit ${context.hidden}; submit leg ${context.leg}`;
  }
  return failureIdentity({ type: failure.type, stage: failure.stage, error: failure.priorError });
}

function failureIdentity(failure: TransactionFailure): string {
  const { error } = failure;
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  // Outer link first, so a wrapper's own code keeps precedence over the one its cause carries.
  const protocol = errorMessageParts(error)
    .map(protocolIdentity)
    .find(identity => identity !== undefined);
  // Ahead of the text arms: a Guardian refusal's message carries the server's own text, which can read as any of them.
  const rejection = rejectionIdentity(error, protocol);
  if (rejection !== undefined) return rejection;
  const kill = killIdentity(error);
  if (kill !== undefined) return kill;
  if (isIndefiniteSubmitOutcomeError(error)) {
    return submitOutcomeIdentity(error, failure.hiddenDuringSubmit, failure.submitLegMs);
  }
  const refusal = submitRequestFailure(error);
  if (refusal !== undefined) return submitRefusalIdentity(refusal, failure);
  if (protocol !== undefined) return protocol;
  if (/advice stack read failed/i.test(message)) return coined('advice_stack_read_failed');
  if ([...reportedCauseChain(error)].some(isClientTerminatedError) || /WebClient terminated/.test(message)) {
    return coined('client_terminated');
  }
  if (/failed to execute transaction/i.test(message)) {
    return `${coined('transaction_execution_failed')}; cause ${executionCause(error)}`;
  }
  const category = classifyError(error);
  if (category !== 'unknown') return category;
  const identity = `unknown; thrown ${thrownClass(error)}`;
  return failure.stage === 'submitting'
    ? `${identity}; ${submitContextIdentity(failure.hiddenDuringSubmit, failure.submitLegMs)}`
    : identity;
}

// Every value the report's text interpolates, each of which crash scrubbing reads as one non-wordlist word where it
// stands whole: a published name can read as a recovery phrase, as ERR_INPUT_NOTE_ASSET_INDEX_OUT_OF_BOUNDS holds four
// wordlist words in a row, and a value outside the set joins the label words beside it, as `match fee; account code`.
const CLOSED_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.values(assertions),
  ...REPORTED_IDENTITIES,
  ...FAILURE_REASONS,
  ...NEVER_COMMITTED_RULES,
  ...SUBMIT_GRPC_STATUSES,
  ...SUBMIT_ENDPOINTS,
  ...SUBMIT_NODE_ERRORS,
  ...SUBMIT_HIDDEN_ANSWERS,
  ...SUBMIT_LEG_BUCKETS,
  ...PROOF_WAIT_BUCKETS,
  ...THROWN_CLASSES,
  ...PIPELINE_KILLS,
  ...OFFSCREEN_DEADLINE_OWNERS,
  ...OFFSCREEN_DEADLINE_TIMERS,
  ...OFFSCREEN_DEADLINE_KILLERS,
  ...OFFSCREEN_OP_STARTED,
  ...EXECUTION_CAUSES,
  ...SIGNING_STEPS,
  ...CONFIRMING_STEPS,
  ...CONSUME_ENTRY_POINTS,
  ...CONSUME_DEFERRAL_CAUSES,
  ...CLAIM_FEE_ADMISSIONS,
  ...REAP_AGES,
  ...REAPED_ATTEMPT_ORIGINS,
  ...STARTUP_SELECTIONS,
  ...STORED_STAGE_AGES,
  ...QUEUE_AGE_BUCKETS,
  ...QUEUE_SIGHTINGS,
  ...PREFLIGHT_SYNC_REPORTS,
  ...QUEUE_HIDDEN_BUCKETS,
  ...SUBMIT_CROSSINGS,
  ...SUBMIT_RECORDS,
  'none',
  'unrecorded',
  'unavailable',
  'other',
  ...HOT_KEY_CODES,
  ...GUARDIAN_ERROR_CODES,
  ...TELEMETRY_ERROR_KINDS,
  ...FAILURE_OUTCOMES,
  ...TRANSACTION_OPERATIONS,
  ...TRANSACTION_STEPS,
  ...EXECUTION_REALMS,
  ...PROVING_PREFERENCES,
  ...FAILURE_PLATFORMS,
  ...FAILURE_POINTS,
  ...AUTH_PREPARATIONS,
  ...AUTH_LAYOUTS,
  ...COMMITMENT_MATCHES,
  ...ACCOUNT_AUTH_CODES,
  ...REOWN_NATIVE_ORIGINS,
  ...REOWN_WALLET_RESPONSE_CODES,
  ...REOWN_REQUEST_AGES,
  ...REOWN_PUBLICATIONS,
  ...REOWN_BACKGROUND_ANSWERS,
  'invalid_permissions'
]);

function softwareVersion(value: string): string {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-rc\.\d{1,3})?$/.test(value) ? value : 'unavailable';
}

export function reportTransactionFailure(failure: TransactionFailure): void {
  try {
    const facts = failure.diagnostics;
    const execution = snapshotTransactionExecution(failure.error);
    const preparation = diagnostic(facts?.authPreparation, AUTH_PREPARATIONS, 'unavailable');
    const layout = diagnostic(execution?.authLayout ?? facts?.authLayout, AUTH_LAYOUTS, 'unavailable');
    const match = diagnostic(execution?.commitmentMatch ?? facts?.commitmentMatch, COMMITMENT_MATCHES, 'unavailable');
    const accountCode = diagnostic(
      execution?.accountAuthCode ?? facts?.accountAuthCode,
      ACCOUNT_AUTH_CODES,
      'unavailable'
    );
    const type = diagnostic(
      failure.type,
      [
        'send',
        'consume',
        'swap',
        'execute',
        'bridged-send',
        'bridged-receive',
        'earn-deposit',
        'earn-withdraw',
        'switch-guardian',
        'replace-hot-key',
        'update-procedure-threshold'
      ] as const,
      'execute'
    );
    const operation = type === failure.type ? operationOfType(type) : 'tx_other';
    const step = stepOfStage(failure.stage);
    const stepName = typeof step === 'string' ? step : 'unknown';
    const confirmingStep = CONFIRMING_STEP_BY_STAGE.get(failure.stage);
    const stage = confirmingStep === undefined ? stepName : `${stepName}; confirming step ${confirmingStep}`;
    const signingStep = SIGNING_STEP_BY_STAGE.get(failure.stage);
    const outcome: (typeof FAILURE_OUTCOMES)[number] = failure.outcome === 'unconfirmed' ? 'unconfirmed' : 'failed';
    const point = diagnostic(failure.point, FAILURE_POINTS, 'pipeline');
    const message =
      typeof failure.error === 'string' ? failure.error : failure.error instanceof Error ? failure.error.message : '';
    const realm: (typeof EXECUTION_REALMS)[number] =
      /Offscreen call '(?:newTransaction|sendTransaction|consumeNoteId|swapTransaction|faucetTransaction|guardianPipeline)' failed:/.test(
        message
      )
        ? 'offscreen'
        : 'unknown';
    const proving: (typeof PROVING_PREFERENCES)[number] =
      failure.delegateTransaction === true ? 'delegated' : failure.delegateTransaction === false ? 'local' : 'unknown';
    const bridge = failure.bridgeReceive === undefined ? '' : `; ${bridgeReceiveIdentity(failure.bridgeReceive)}`;
    const claim =
      type === 'consume'
        ? [
            `; queued by ${diagnostic<string>(
              failure.entryPoint,
              CONSUME_ENTRY_POINTS,
              failure.entryPoint === undefined ? 'unrecorded' : 'other'
            )}`,
            `; last deferral ${diagnostic<string>(
              failure.lastDeferral,
              CONSUME_DEFERRAL_CAUSES,
              failure.lastDeferral === undefined ? 'none' : 'other'
            )}`,
            `; claim fee admission ${diagnostic<string>(
              failure.feeAdmission,
              CLAIM_FEE_ADMISSIONS,
              failure.feeAdmission === undefined ? 'unrecorded' : 'other'
            )}`
          ].join('')
        : // Any row the loop requeued records its cause; only a recorded one is named, so a report that has none keeps its
          // message and its Sentry group.
          failure.lastDeferral === undefined
          ? ''
          : `; last deferral ${diagnostic<string>(failure.lastDeferral, CONSUME_DEFERRAL_CAUSES, 'other')}`;
    const platform: (typeof FAILURE_PLATFORMS)[number] = isDesktop() ? 'desktop' : resolveTelemetryContext().platform;
    const reason =
      failure.reason === undefined ? undefined : diagnostic<string>(failure.reason, FAILURE_REASONS, 'other');
    const reap =
      reason === 'stuck_reaped'
        ? [
            `; reap age ${diagnostic<string>(failure.reap?.age, REAP_AGES, 'unavailable')}`,
            `; reaped attempt ${diagnostic<string>(failure.reap?.attempt, REAPED_ATTEMPT_ORIGINS, 'unavailable')}`
          ].join('')
        : '';
    const startup =
      reason === 'interrupted_on_startup'
        ? [
            `; startup selection ${diagnostic<string>(failure.startup?.selection, STARTUP_SELECTIONS, 'unavailable')}`,
            `; stored stage age ${diagnostic<string>(failure.startup?.stageAge, STORED_STAGE_AGES, 'unavailable')}`,
            `; submit ${diagnostic<string>(failure.startup?.submit, SUBMIT_RECORDS, 'unavailable')}`
          ].join('')
        : '';
    const queueAge =
      reason === 'queued_expired' && failure.queueAge !== undefined
        ? `; queue age ${diagnostic<string>(failure.queueAge, QUEUE_AGE_BUCKETS, 'unavailable')}`
        : '';
    const queueSighting =
      reason === 'queued_expired'
        ? `; queue sighting ${diagnostic<string>(failure.queueSighting, QUEUE_SIGHTINGS, 'never')}`
        : '';
    const preflightSync =
      reason === 'queued_expired'
        ? `; sync attempt ${diagnostic<string>(failure.preflightSync, PREFLIGHT_SYNC_REPORTS, 'not_entered')}`
        : '';
    const queueHidden =
      reason === 'queued_expired'
        ? `; queue hidden ${diagnostic<string>(failure.queueHidden, QUEUE_HIDDEN_BUCKETS, 'unavailable')}`
        : '';
    const submitCrossing =
      failure.submitCrossing === undefined
        ? ''
        : `; submit crossing ${diagnostic<string>(failure.submitCrossing, SUBMIT_CROSSINGS, 'unavailable')}`;
    let reportedNeverCommittedRule: string | undefined;
    const identity =
      reason === undefined
        ? failureIdentity(failure)
        : reason === 'never_committed' && failure.neverCommittedRule !== undefined
          ? `${reason}; rule ${(reportedNeverCommittedRule = diagnostic<string>(failure.neverCommittedRule, NEVER_COMMITTED_RULES, 'other'))}` +
            (failure.neverCommittedRule !== 'expired' || failure.priorError === undefined
              ? ''
              : `; prior ${priorIdentity(failure)}`) +
            (failure.neverCommittedRule === 'expired'
              ? `; proof wait ${proofWaitBucket(failure.proofWaitBlocks, failure.expiryWindowBlocks)}`
              : '')
          : reason;
    const report = new Error(
      [
        `Transaction ${outcome}: ${operation}; stage ${stage}${signingStep === undefined ? '' : `; signing step ${signingStep}`}; realm ${realm}; proving preference ${proving}; platform ${platform}${claim}${reap}${startup}${queueAge}${queueSighting}${preflightSync}${queueHidden}${submitCrossing}; point ${point}; ${identity}${bridge}`,
        `authentication preparation ${preparation}; layout ${layout}; commitment match ${match}; account code ${accountCode}`,
        `SDK ${softwareVersion(packageJson.dependencies['@miden-sdk/miden-sdk'])}; Guardian client ${softwareVersion(packageJson.dependencies['@openzeppelin/miden-multisig-client'])}`
      ].join('. ')
    );
    report.name = 'WalletTransactionFailure';
    // This stack would name the reporter, not the failed execution, and can include private file paths.
    report.stack = undefined;
    const inherited = snapshotCrashDiagnostics(failure.error);
    delete inherited.reownNativeOrigin;
    delete inherited.reownWalletResponseCode;
    delete inherited.reownRequestAge;
    delete inherited.reownPublished;
    delete inherited.reownBackgrounded;
    delete inherited.proofWaitAvailability;
    annotateCrash(report, inherited);
    if (point === 'node_verdict' && reason === 'never_committed' && reportedNeverCommittedRule === 'expired')
      annotateProofWaitAvailability(report, snapshotProofWaitAvailability(failure));
    if (inherited.proposalStep === 'proposal_create') transferProposalCreateDiagnostics(failure.error, report);
    annotateGuardianProving(report, snapshotGuardianProving(failure.error));
    if (identity.startsWith('offscreen_aborted_deadline;')) transferOffscreenDeadline(failure.error, report);
    annotateTerminalReport(report, {
      queueAdmissionObservation:
        reason === 'queued_expired' ? safeOwnDiagnosticData(failure, 'queueAdmissionObservation') : undefined,
      queueSighting: reason === 'queued_expired' ? safeOwnDiagnosticData(failure, 'queueSighting') : undefined,
      preflightSync: reason === 'queued_expired' ? safeOwnDiagnosticData(failure, 'preflightSync') : undefined,
      queueHidden: reason === 'queued_expired' ? safeOwnDiagnosticData(failure, 'queueHidden') : undefined,
      reapStartRelation:
        reason === 'stuck_reaped'
          ? safeOwnDiagnosticData(safeOwnDiagnosticData(failure, 'reap'), 'startRelation')
          : undefined
    });
    // Each is checked against its closed list there; a value the wallet does not define is dropped.
    const bridgeSource = failure.bridgeReceive;
    if (bridgeSource !== undefined) {
      annotateCrash(report, {
        bridgeBalanceCheck: bridgeSource.balanceCheck,
        bridgeOrphanCheck: bridgeSource.orphanCheck,
        bridgeSourceRoute: bridgeSource.sourceRoute
      });
    }
    const candidate =
      type === 'bridged-receive' && (platform === 'android' || platform === 'ios')
        ? bridgeReceiveNativeFailure(failure.bridgeReceive?.cause)
        : undefined;
    const native =
      platform === 'ios' && candidate !== undefined && !isReownIOSCallFailure(candidate) ? undefined : candidate;
    if (native !== undefined) {
      annotateCrash(report, {
        reownNativeOrigin: native.nativeOrigin,
        reownWalletResponseCode: native.walletResponseCode,
        reownRequestAge: native.requestAge,
        reownPublished: native.published,
        reownBackgrounded: native.backgrounded
      });
    }
    // A queued row with no stage expired untried (the loop's requeues stamp one, and every requeue clears `attemptId`):
    // whatever held the queue has its own report, and each row behind it would otherwise add another error.
    const neverStarted = reason === 'queued_expired' && failure.stage === undefined;
    // An unknown outcome waits for the node's verdict, which is the error if it never landed; a failure already reported
    // already has its error, so a later report on it is evidence for that one.
    captureCrash(report, 'manual', {
      initializeIfNeeded: true,
      level: outcome === 'unconfirmed' || failure.alreadyReported === true || neverStarted ? 'warning' : 'error',
      closedNames: CLOSED_NAMES
    });
  } catch {
    // Reporting must never change the transaction outcome.
  }
}
