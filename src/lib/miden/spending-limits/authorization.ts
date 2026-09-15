import { v4 as uuid } from 'uuid';

import {
  SpendingLimitAssessment,
  SpendingLimitAuthorization,
  SpendingLimitPolicyUnavailableError,
  parseSpendingLimitAssessment
} from './types';

const AUTHORIZATION_LIFETIME_SECONDS = 2 * 60;

export const createSpendingLimitAuthorization = (
  assessment: SpendingLimitAssessment,
  issuedAt: number = Math.floor(Date.now() / 1000),
  makeId: () => string = uuid
): SpendingLimitAuthorization => {
  const validated = parseSpendingLimitAssessment(assessment);
  if (
    validated.breaches.length === 0 ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt < validated.assessedAt ||
    makeId === undefined
  ) {
    throw new SpendingLimitPolicyUnavailableError('Spending limit policy is unavailable: invalid authorization');
  }
  const id = makeId();
  if (id.trim().length === 0) {
    throw new SpendingLimitPolicyUnavailableError('Spending limit policy is unavailable: invalid authorization id');
  }
  return {
    id,
    accountId: validated.accountId,
    faucetId: validated.faucetId,
    amount: validated.amount,
    revision: validated.revision,
    issuedAt,
    expiresAt: issuedAt + AUTHORIZATION_LIFETIME_SECONDS
  };
};
