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
  'note_invalid'
] as const;

/** A failure the wallet itself decided, named by the caller because its stored text is never sent. */
export type TransactionFailureReason = (typeof FAILURE_REASONS)[number];

/** Identities the reporter names itself, beside the reasons, refusals and protocol identities. */
export const REPORTED_IDENTITIES = ['submit_outcome_unknown'] as const;

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

export interface TransactionFailure {
  type: ITransactionType;
  stage?: ITransactionStage;
  reason?: TransactionFailureReason;
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

function protocolIdentity(message: string): string | undefined {
  const code = /assertion failed with error code:\s*(\d{1,20})(?!\d)/.exec(message)?.[1];
  if (code === undefined) return undefined;
  // Only identities in the shipped public protocol sources survive. Arbitrary numbers can be user data.
  return Object.prototype.hasOwnProperty.call(assertions, code)
    ? assertions[code as keyof typeof assertions]
    : 'kernel_assertion_unknown';
}

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
  const hidden = hiddenDuringSubmit === undefined ? 'unavailable' : hiddenDuringSubmit ? 'yes' : 'no';
  return `submit_outcome_unknown; grpc ${status}; app hidden during submit ${hidden}`;
}

function failureIdentity(failure: TransactionFailure): string {
  const { error } = failure;
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const protocol = protocolIdentity(message);
  // Ahead of the text arms: a Guardian refusal's message carries the server's own text, which can read as any of them.
  const rejection = rejectionIdentity(error, protocol);
  if (rejection !== undefined) return rejection;
  const kill = killIdentity(error);
  if (kill !== undefined) return kill;
  if (isIndefiniteSubmitOutcomeError(error)) return submitOutcomeIdentity(error, failure.hiddenDuringSubmit);
  if (protocol !== undefined) return protocol;
  if (/advice stack read failed/i.test(message)) return 'advice_stack_read_failed';
  if (/WebClient terminated/.test(message)) return 'client_terminated';
  if (/failed to execute transaction/i.test(message)) return 'transaction_execution_failed';
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
    const identity =
      failure.reason === undefined
        ? failureIdentity(failure)
        : diagnostic<string>(failure.reason, FAILURE_REASONS, 'other');
    const report = new Error(
      [
        `Transaction ${outcome}: ${operation}; stage ${stage}; realm ${realm}; proving preference ${proving}; platform ${platform}; point ${point}; ${identity}`,
        `authentication preparation ${preparation}; layout ${layout}; commitment match ${match}; account code ${accountCode}`,
        `SDK ${softwareVersion(packageJson.dependencies['@miden-sdk/miden-sdk'])}; Guardian client ${softwareVersion(packageJson.dependencies['@openzeppelin/miden-multisig-client'])}`
      ].join('. ')
    );
    report.name = 'WalletTransactionFailure';
    // This stack would name the reporter, not the failed execution, and can include private file paths.
    report.stack = undefined;
    annotateCrash(report, snapshotCrashDiagnostics(failure.error));
    captureCrash(report, 'manual', { initializeIfNeeded: true });
  } catch {
    // Reporting must never change the transaction outcome.
  }
}
