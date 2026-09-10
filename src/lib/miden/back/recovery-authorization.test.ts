import {
  ReplaceHotKeyTransaction,
  SwitchGuardianTransaction,
  UpdateProcedureThresholdTransaction
} from 'lib/miden/db/types';

import {
  authorizeRecovery,
  beginRecoveryAuthorization,
  clearRecoveryAuthorization,
  clearRecoveryAuthorizations,
  getRecoveryAuthorization,
  isRecoveryTransaction
} from './recovery-authorization';

afterEach(() => {
  clearRecoveryAuthorizations();
  jest.useRealTimers();
});

it('binds a key to one transaction and its target', () => {
  const transaction = new SwitchGuardianTransaction('account', 'https://guardian.example', false);
  const other = new SwitchGuardianTransaction('account', 'https://guardian.example', false);
  const secret = new Uint8Array([1, 2, 3]);
  authorizeRecovery(transaction, 'recovery-public-key', secret);
  expect(getRecoveryAuthorization(transaction, 'recovery-public-key')).toBe(secret);
  expect(getRecoveryAuthorization(other, 'recovery-public-key')).toBeUndefined();
  expect(getRecoveryAuthorization(transaction, 'another-key')).toBeUndefined();
  transaction.extraInputs.newGuardianEndpoint = 'https://different.example';
  expect(getRecoveryAuthorization(transaction, 'recovery-public-key')).toBeUndefined();
});

it('clears secret bytes when permission expires', () => {
  jest.useFakeTimers();
  const transaction = new ReplaceHotKeyTransaction('account', false);
  const secret = new Uint8Array([1, 2]);
  authorizeRecovery(transaction, 'key', secret);
  jest.advanceTimersByTime(5 * 60 * 1000);
  expect(getRecoveryAuthorization(transaction, 'key')).toBeUndefined();
  expect([...secret]).toEqual([0, 0]);
});

it('keeps an active key until the pipeline finishes', () => {
  jest.useFakeTimers();
  const transaction = new ReplaceHotKeyTransaction('account', false);
  const secret = new Uint8Array([1, 2]);
  expect(beginRecoveryAuthorization(transaction, 'key')).toBe(false);
  authorizeRecovery(transaction, 'key', secret);
  expect(beginRecoveryAuthorization(transaction, 'key')).toBe(true);
  jest.advanceTimersByTime(6 * 60 * 1000);
  expect(getRecoveryAuthorization(transaction, 'key')).toBe(secret);
  clearRecoveryAuthorization(transaction.id);
  expect(getRecoveryAuthorization(transaction, 'key')).toBeUndefined();
  expect([...secret]).toEqual([0, 0]);
});

it('clears all keys on lock and clears a replaced permission', () => {
  const transaction = new ReplaceHotKeyTransaction('account', false);
  const first = new Uint8Array([1]);
  const second = new Uint8Array([2]);
  authorizeRecovery(transaction, 'key', first);
  authorizeRecovery(transaction, 'key', second);
  expect([...first]).toEqual([0]);
  clearRecoveryAuthorizations();
  clearRecoveryAuthorization(transaction.id);
  expect([...second]).toEqual([0]);
  expect(getRecoveryAuthorization(transaction, 'key')).toBeUndefined();
});

it('supports all three Guardian recovery actions', () => {
  expect(isRecoveryTransaction(new SwitchGuardianTransaction('account', 'https://guardian.example', false))).toBe(true);
  expect(isRecoveryTransaction(new ReplaceHotKeyTransaction('account', false))).toBe(true);
  expect(isRecoveryTransaction(new UpdateProcedureThresholdTransaction('account', 'update_guardian', 2, false))).toBe(
    true
  );
});
