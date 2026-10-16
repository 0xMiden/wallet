import { GUARDIAN_ERROR_CODES } from '@openzeppelin/guardian-client';

import type { ITransactionStage, ITransactionType } from 'lib/miden/db/types';
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

const FAILURE_REASONS = [
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

export interface TransactionFailure {
  type: ITransactionType;
  stage?: ITransactionStage;
  reason?: TransactionFailureReason;
  error?: unknown;
  delegateTransaction?: boolean;
  outcome?: 'failed' | 'unconfirmed';
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
const HOT_KEY_CODES = [
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
function rejectionIdentity(error: unknown): string | undefined {
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
        return `guardian_http_${http}; guardian code ${listedCode(code, GUARDIAN_ERROR_CODES)}`;
      }
    } catch {
      // A throwing accessor costs this link, not the report.
    }
  }
  return undefined;
}

function failureIdentity(error: unknown): string {
  // Ahead of the text arms: a Guardian refusal's message carries the server's own text, which can read as any of them.
  const rejection = rejectionIdentity(error);
  if (rejection !== undefined) return rejection;
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const code = /assertion failed with error code:\s*(\d{1,20})(?!\d)/.exec(message)?.[1];
  if (code !== undefined) {
    // Only identities in the shipped public protocol sources survive. Arbitrary numbers can be user data.
    return Object.prototype.hasOwnProperty.call(assertions, code)
      ? assertions[code as keyof typeof assertions]
      : 'kernel_assertion_unknown';
  }
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
        ? failureIdentity(failure.error)
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
