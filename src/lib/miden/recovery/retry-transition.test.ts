import { matchesRecoveryDebit, resolveRecoveryDebit } from './retry-transition';
import { toSerializable } from './serialization';
import type { RecoveryDebitEntry } from './types';

const old: RecoveryDebitEntry = {
  kind: 'debit',
  id: 'retry',
  accountId: 'account-a',
  initiatedAt: 200000,
  spentUsd: 7n,
  authorizationId: 'used'
};
const pending: RecoveryDebitEntry = {
  ...old,
  initiatedAt: 100000,
  retry: { previous: { initiatedAt: 200000, spentUsd: 7n, authorizationId: 'used' }, queuedSeq: 9 }
};

it('Task4C1 pending retry accepts only its exact old or committed candidate debit', () => {
  expect(matchesRecoveryDebit(pending, old)).toBe(true);
  expect(matchesRecoveryDebit(pending, { ...old, initiatedAt: 100000 })).toBe(true);
  expect(matchesRecoveryDebit(pending, { ...old, initiatedAt: 150000 })).toBe(false);
  expect(matchesRecoveryDebit(pending, { ...old, spentUsd: 8n })).toBe(false);
  expect(matchesRecoveryDebit(pending, { ...old, authorizationId: 'other' })).toBe(false);
});

it('Task4C1 pending retry preserves the original future reservation before candidate commit', () => {
  expect(toSerializable(resolveRecoveryDebit(pending))).toEqual(toSerializable(old));
});

it('Task4C1 committed retry remains charged once and its one-use grant stays consumed', () => {
  const next = { ...pending, retry: undefined };
  expect(resolveRecoveryDebit(next)).toEqual({ ...old, initiatedAt: 100000 });
});
