import type { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

import {
  unobservedTransactionExecution,
  type TransactionExecutionDiagnostics
} from 'lib/telemetry/transaction-execution-diagnostics';

import { customRequestAuthDiagnostics } from './custom-request-diagnostics';

/** Observe only the borrowed request already built for this attempt; no preparation or account reads. */
export function observeTransactionExecutionRequest(
  request: TransactionRequest,
  route: TransactionExecutionDiagnostics['executionRoute']
): TransactionExecutionDiagnostics {
  const facts = unobservedTransactionExecution(route);
  try {
    Object.assign(
      facts,
      customRequestAuthDiagnostics(request, state => {
        if (state === 'read_failed') facts.authObservation = 'read_failed';
        else {
          facts.authArgPresence = state;
          facts.authObservation = 'observed';
        }
      })
    );
  } catch {
    facts.authObservation = 'read_failed';
  }
  return facts;
}
