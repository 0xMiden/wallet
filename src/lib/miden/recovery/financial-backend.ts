import type { RecoveryDebitEntry, RecoveryPolicyEntry } from './types';

type FinancialRecoveryBackend = (
  accountId: string,
  entry: RecoveryDebitEntry | RecoveryPolicyEntry | undefined,
  expectedEpoch: number
) => Promise<void>;
let backend: FinancialRecoveryBackend | undefined;

export function installFinancialRecoveryBackend(checkpoint: FinancialRecoveryBackend): void {
  backend = checkpoint;
}

export function getFinancialRecoveryBackend(): FinancialRecoveryBackend | undefined {
  return backend;
}
