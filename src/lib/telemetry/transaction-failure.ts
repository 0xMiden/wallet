import type { ITransactionStage, ITransactionType } from 'lib/miden/db/types';
import { isDesktop } from 'lib/platform';

import { classifyError } from './classify';
import { resolveTelemetryContext } from './context';
import { captureCrash } from './crash';
import { annotateCrash, snapshotCrashDiagnostics } from './crash-diagnostics';
import assertions from './protocol-assertions.json';
import { operationOfType, stepOfStage } from './transaction-operation';
import packageJson from '../../../package.json';

export interface TransactionFailureDiagnostics {
  authPreparation: 'provided' | 'wallet_enriched' | 'unchanged' | 'failed' | 'unavailable';
  authLayout: 'absent' | 'fee' | 'guardian' | 'other' | 'missing_preimage' | 'unavailable';
  commitmentMatch: 'fee' | 'guardian' | 'neither' | 'unavailable';
  accountAuthCode?: 'current_guardian' | 'unrecognized' | 'unavailable';
}

export interface TransactionFailure {
  type: ITransactionType;
  stage?: ITransactionStage;
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

function failureIdentity(error: unknown): string {
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
    const report = new Error(
      [
        `Transaction ${outcome}: ${operation}; stage ${stage}; realm ${realm}; proving preference ${proving}; platform ${platform}; point ${point}; ${failureIdentity(failure.error)}`,
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
