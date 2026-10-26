import type { SpendingLimitConfiguration, SpendingLimitDraft } from './types';

export type SpendingLimitChangeClassification = 'safe' | 'strict-authentication';

export const classifySpendingLimitChange = (
  current: SpendingLimitConfiguration | undefined,
  next: SpendingLimitDraft
): SpendingLimitChangeClassification => {
  if (current === undefined) return next.limit === undefined ? 'safe' : 'strict-authentication';
  if (next.limit === undefined) return 'strict-authentication';
  return next.limit > current.limit ? 'strict-authentication' : 'safe';
};
