import type { SpendingLimitConfiguration, SpendingLimitDraft } from './types';

export type SpendingLimitChangeClassification = 'safe' | 'strict-authentication';

const periodWeakens = (current: bigint | undefined, next: bigint | undefined): boolean => {
  if (current === undefined) return next !== undefined;
  if (next === undefined) return true;
  return next > current;
};

export const classifySpendingLimitChange = (
  current: SpendingLimitConfiguration | undefined,
  next: SpendingLimitDraft
): SpendingLimitChangeClassification => {
  if (current === undefined) {
    return next.dailyLimit === undefined && next.weeklyLimit === undefined ? 'safe' : 'strict-authentication';
  }
  return periodWeakens(current.dailyLimit, next.dailyLimit) || periodWeakens(current.weeklyLimit, next.weeklyLimit)
    ? 'strict-authentication'
    : 'safe';
};
