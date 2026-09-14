import type { IEarnDepositExtraInputs, IEarnWithdrawExtraInputs, ITransaction } from 'lib/miden/db/types';

export interface ExpectedEarnDepositIntent {
  owner: string;
  nonce: string;
}

export interface ExpectedEarnWithdrawIntent {
  owner: string | undefined;
  attemptId: string;
  nonce?: string;
}

export const intentKey = (owner: string, nonce: string): string => `${owner.toLowerCase()}:${nonce}`;
export const earnDepositPollKey = (owner: string, nonce: string): string => `earn-deposit:${intentKey(owner, nonce)}`;
export const earnWithdrawPollKey = (owner: string, nonce: string): string => `earn-withdraw:${intentKey(owner, nonce)}`;
export const effectiveWithdrawAttemptId = (txId: string, submissionAttemptId?: string): string =>
  submissionAttemptId ?? txId;

export function matchesEarnDepositIntent(row: ITransaction, expected: ExpectedEarnDepositIntent): boolean {
  const inputs: IEarnDepositExtraInputs | undefined = row.extraInputs;
  return (
    row.type === 'earn-deposit' &&
    typeof inputs?.evmRecipient === 'string' &&
    intentKey(inputs.evmRecipient, inputs.intentNonce ?? '') === intentKey(expected.owner, expected.nonce)
  );
}

export function matchesEarnWithdrawIntent(row: ITransaction, expected: ExpectedEarnWithdrawIntent): boolean {
  const inputs: IEarnWithdrawExtraInputs | undefined = row.extraInputs;
  return (
    row.type === 'earn-withdraw' &&
    inputs !== undefined &&
    (inputs.evmOwner === expected.owner ||
      (typeof inputs.evmOwner === 'string' &&
        typeof expected.owner === 'string' &&
        inputs.evmOwner.toLowerCase() === expected.owner.toLowerCase())) &&
    effectiveWithdrawAttemptId(row.id, inputs.submissionAttemptId) === expected.attemptId &&
    (!inputs.withdrawIntentNonce || !expected.nonce || inputs.withdrawIntentNonce === expected.nonce)
  );
}

export function isEarnWithdrawalStale(row: ITransaction, nowMs = Date.now()): boolean {
  const inputs: IEarnWithdrawExtraInputs | undefined = row.extraInputs;
  const startedAt = inputs?.attemptStartedAt ?? row.initiatedAt;
  return startedAt < Math.floor((nowMs - 7 * 24 * 60 * 60 * 1000) / 1000);
}
