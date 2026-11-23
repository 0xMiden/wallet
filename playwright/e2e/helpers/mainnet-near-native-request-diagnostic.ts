import { TRANSACTION_STAGES } from '../../../src/lib/miden/db/types';
import type { TransactionRowSnapshot } from './history';

const statuses = ['queued', 'generating', 'completed', 'failed', 'unconfirmed'] as const;
const outcomes: ReadonlyMap<string, string> = new Map([
  ['Actual native send request timed out', 'request-timeout'],
  ['Native send authorization aborted or expired', 'expired-or-aborted'],
  ['Native send request scope changed', 'scope-changed'],
  ['Native send authorization is already used or blocked', 'used-or-blocked']
]);

export function nearNativeRequestDiagnostic(
  error: unknown,
  row: Pick<TransactionRowSnapshot, 'status' | 'stage' | 'rawError' | 'error'> | null | undefined
) {
  const rowStage = TRANSACTION_STAGES.find(stage => stage === row?.stage) ?? 'unknown';
  const rejection = [row?.rawError, row?.error].some(message =>
    message?.includes('Actual native send bytes differ from the exact authorized request')
  )
    ? 'request-mismatch'
    : 'unknown';
  return {
    stage: 'native-request',
    outcome: error instanceof Error ? (outcomes.get(error.message) ?? 'unknown') : 'unknown',
    rowStatus: row === null ? 'missing' : (statuses[row?.status ?? -1] ?? 'unknown'),
    rowStage,
    rejection
  };
}
