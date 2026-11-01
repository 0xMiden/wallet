import type { RecoveryDebitEntry } from './types';

function equal(left: RecoveryDebitEntry, right: RecoveryDebitEntry): boolean {
  return (
    left.id === right.id &&
    left.accountId === right.accountId &&
    left.initiatedAt === right.initiatedAt &&
    left.spentUsd === right.spentUsd &&
    left.authorizationId === right.authorizationId
  );
}

export function matchesRecoveryDebit(expected: RecoveryDebitEntry, actual: RecoveryDebitEntry): boolean {
  return (
    equal(expected, actual) ||
    (expected.retry !== undefined &&
      equal(
        {
          kind: 'debit',
          id: expected.id,
          accountId: expected.accountId,
          ...expected.retry.previous
        },
        actual
      ))
  );
}

export function resolveRecoveryDebit(entry: RecoveryDebitEntry): RecoveryDebitEntry {
  const { retry, ...candidate } = entry;
  return retry && retry.previous.initiatedAt > candidate.initiatedAt
    ? { kind: 'debit', id: entry.id, accountId: entry.accountId, ...retry.previous }
    : candidate;
}
