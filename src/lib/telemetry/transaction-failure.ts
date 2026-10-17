import { GUARDIAN_ERROR_CODES } from '@openzeppelin/guardian-client';

import { isOperationAbortedError } from 'lib/miden/back/offscreen-codec';
import type { ITransactionStage, ITransactionType } from 'lib/miden/db/types';
import { errorMessageParts, isIndefiniteSubmitOutcomeError } from 'lib/miden/sdk/sdk-error-code';
import { isWasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { isDesktop } from 'lib/platform';
import { isHotKeyFailure } from 'lib/secure-hot-key/failure';

import { classifyError } from './classify';
import { resolveTelemetryContext } from './context';
import { captureCrash } from './crash';
import { annotateCrash, errorChain, snapshotCrashDiagnostics } from './crash-diagnostics';
import assertions from './protocol-assertions.json';
import { operationOfType, stepOfStage } from './transaction-operation';
import packageJson from '../../../package.json';

export interface TransactionFailureDiagnostics {
  authPreparation: 'provided' | 'wallet_enriched' | 'unchanged' | 'failed' | 'unavailable';
  authLayout: 'absent' | 'fee' | 'guardian' | 'other' | 'missing_preimage' | 'unavailable';
  commitmentMatch: 'fee' | 'guardian' | 'neither' | 'unavailable';
  accountAuthCode?: 'current_guardian' | 'unrecognized' | 'unavailable';
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
  'kernel_assertion_unknown',
  'kernel_u32_assertion_unknown'
] as const;

export const SUBMIT_GRPC_STATUSES = [
  'unavailable',
  'internal',
  'cancelled',
  'aborted',
  'data_loss',
  'deadline_exceeded',
  'unknown',
  'other'
] as const;

export const SUBMIT_HIDDEN_ANSWERS = ['yes', 'no', 'unavailable'] as const;

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

export interface TransactionFailure {
  type: ITransactionType;
  stage?: ITransactionStage;
  reason?: TransactionFailureReason;
  /** Read only with the `never_committed` reason. */
  neverCommittedRule?: NeverCommittedRule;
  error?: unknown;
  delegateTransaction?: boolean;
  outcome?: 'failed' | 'unconfirmed';
  /** Whether the app was hidden while its submit was in flight; undefined when the platform cannot tell. */
  hiddenDuringSubmit?: boolean;
  point?:
    | 'pipeline'
    | 'earn_settlement'
    | 'bridge_receive_settlement'
    | 'bridge_send_settlement'
    | 'guardian_node_verdict'
    | 'node_verdict';
  diagnostics?: TransactionFailureDiagnostics;
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
      if (isHotKeyFailure(link)) return `hot_key; hot key code ${listedCode(Reflect.get(link, 'code'), HOT_KEY_CODES)}`;
      if (link.name === 'GuardianHttpError') {
        const status: unknown = Reflect.get(link, 'status');
        const http =
          typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
            ? String(status)
            : 'other';
        const code = Reflect.get(link, 'code') ?? Reflect.get(link, 'rawCode');
        const refusal = `guardian_http_${http}; guardian code ${listedCode(code, GUARDIAN_ERROR_CODES)}`;
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
  // Only identities in the shipped public protocol sources survive. Arbitrary numbers can be user data.
  if (Object.prototype.hasOwnProperty.call(assertions, code)) return assertions[code as keyof typeof assertions];
  return assertion === undefined ? 'kernel_u32_assertion_unknown' : 'kernel_assertion_unknown';
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

// Named by class and reason, never by message: the abort's message carries the operation id.
function killIdentity(error: unknown): PipelineKill | undefined {
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
      return offscreen
        ? (OFFSCREEN_ABORTS.get(reason) ?? 'offscreen_aborted_other')
        : (LOCK_EVICTIONS.get(reason) ?? 'wasm_lock_evicted_other');
    } catch {
      // A throwing accessor costs this link, not the report.
    }
  }
  return undefined;
}

// miden-client 0.17.3 `GrpcError` Display, for each status its `is_indeterminate_submission` reads as an unknown outcome.
const SUBMIT_GRPC_TEXT: ReadonlyArray<readonly [(typeof SUBMIT_GRPC_STATUSES)[number], string]> = [
  ['unavailable', 'Miden node is unavailable'],
  ['internal', 'Miden node returned an internal error'],
  ['cancelled', 'operation was cancelled'],
  ['aborted', 'operation was aborted'],
  ['data_loss', 'unrecoverable data loss or corruption'],
  ['deadline_exceeded', 'request to Miden node timed out'],
  ['unknown', 'unknown error: ']
];

const SUBMIT_REQUEST_FAILED = /grpc request failed for submit_proven_(?:transaction|batch): /;

function submitOutcomeIdentity(error: unknown, hiddenDuringSubmit: boolean | undefined): string {
  let status: (typeof SUBMIT_GRPC_STATUSES)[number] = 'other';
  for (const part of errorMessageParts(error)) {
    const request = SUBMIT_REQUEST_FAILED.exec(part);
    if (request === null) continue;
    const kind = part.slice(request.index + request[0].length);
    status = SUBMIT_GRPC_TEXT.find(([, text]) => kind.startsWith(text))?.[0] ?? 'other';
    break;
  }
  const hidden: (typeof SUBMIT_HIDDEN_ANSWERS)[number] =
    hiddenDuringSubmit === undefined ? 'unavailable' : hiddenDuringSubmit ? 'yes' : 'no';
  return `submit_outcome_unknown; grpc ${status}; app hidden during submit ${hidden}`;
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
  if (isIndefiniteSubmitOutcomeError(error)) return submitOutcomeIdentity(error, failure.hiddenDuringSubmit);
  if (protocol !== undefined) return protocol;
  if (/advice stack read failed/i.test(message)) return 'advice_stack_read_failed';
  if (/WebClient terminated/.test(message)) return 'client_terminated';
  if (/failed to execute transaction/i.test(message))
    return `transaction_execution_failed; cause ${executionCause(error)}`;
  return classifyError(error);
}

function softwareVersion(value: string): string {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-rc\.\d{1,3})?$/.test(value) ? value : 'unavailable';
}

export function reportTransactionFailure(failure: TransactionFailure): void {
  try {
    const facts = failure.diagnostics;
    const preparation = diagnostic(
      facts?.authPreparation,
      ['provided', 'wallet_enriched', 'unchanged', 'failed', 'unavailable'] as const,
      'unavailable'
    );
    const layout = diagnostic(
      facts?.authLayout,
      ['absent', 'fee', 'guardian', 'other', 'missing_preimage', 'unavailable'] as const,
      'unavailable'
    );
    const match = diagnostic(
      facts?.commitmentMatch,
      ['fee', 'guardian', 'neither', 'unavailable'] as const,
      'unavailable'
    );
    const accountCode = diagnostic(
      facts?.accountAuthCode,
      ['current_guardian', 'unrecognized', 'unavailable'] as const,
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
    const stage = typeof step === 'string' ? step : 'unknown';
    const signingStep = SIGNING_STEP_BY_STAGE.get(failure.stage);
    const outcome = failure.outcome === 'unconfirmed' ? 'unconfirmed' : 'failed';
    const point = diagnostic(
      failure.point,
      [
        'pipeline',
        'earn_settlement',
        'bridge_receive_settlement',
        'bridge_send_settlement',
        'guardian_node_verdict',
        'node_verdict'
      ] as const,
      'pipeline'
    );
    const message =
      typeof failure.error === 'string' ? failure.error : failure.error instanceof Error ? failure.error.message : '';
    const realm =
      /Offscreen call '(?:newTransaction|sendTransaction|consumeNoteId|swapTransaction|faucetTransaction|guardianPipeline)' failed:/.test(
        message
      )
        ? 'offscreen'
        : 'unknown';
    const proving =
      failure.delegateTransaction === true ? 'delegated' : failure.delegateTransaction === false ? 'local' : 'unknown';
    const platform = isDesktop() ? 'desktop' : resolveTelemetryContext().platform;
    const reason =
      failure.reason === undefined ? undefined : diagnostic<string>(failure.reason, FAILURE_REASONS, 'other');
    const identity =
      reason === undefined
        ? failureIdentity(failure)
        : reason === 'never_committed' && failure.neverCommittedRule !== undefined
          ? `${reason}; rule ${diagnostic<string>(failure.neverCommittedRule, NEVER_COMMITTED_RULES, 'other')}`
          : reason;
    const report = new Error(
      [
        `Transaction ${outcome}: ${operation}; stage ${stage}${signingStep === undefined ? '' : `; signing step ${signingStep}`}; realm ${realm}; proving preference ${proving}; platform ${platform}; point ${point}; ${identity}`,
        `authentication preparation ${preparation}; layout ${layout}; commitment match ${match}; account code ${accountCode}`,
        `SDK ${softwareVersion(packageJson.dependencies['@miden-sdk/miden-sdk'])}; Guardian client ${softwareVersion(packageJson.dependencies['@openzeppelin/miden-multisig-client'])}`
      ].join('. ')
    );
    report.name = 'WalletTransactionFailure';
    // This stack would name the reporter, not the failed execution, and can include private file paths.
    report.stack = undefined;
    annotateCrash(report, snapshotCrashDiagnostics(failure.error));
    // An unknown outcome waits for the node's verdict, which is reported again as an error if it never landed.
    captureCrash(report, 'manual', {
      initializeIfNeeded: true,
      level: outcome === 'unconfirmed' ? 'warning' : 'error'
    });
  } catch {
    // Reporting must never change the transaction outcome.
  }
}
