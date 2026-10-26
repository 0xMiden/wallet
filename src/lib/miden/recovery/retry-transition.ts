import type { RecoveryDebitEntry } from './types';

export function matchesRecoveryDebit(expected: RecoveryDebitEntry, actual: RecoveryDebitEntry): boolean {
  return expected === actual;
}

export function resolveRecoveryDebit(entry: RecoveryDebitEntry): RecoveryDebitEntry {
  return entry;
}
