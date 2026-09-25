import { v4 as uuid } from 'uuid';

import {
  SpendingLimitAssessment,
  SpendingLimitAuthorization,
  SpendingLimitPolicyUnavailableError,
  parseSpendingLimitAssessment,
  spendsDigest
} from './types';

const AUTHORIZATION_LIFETIME_SECONDS = 2 * 60;

/**
 * Binds a short-lived `usd` authorization to the exact spends of a breached assessment - what the
 * user actually consented to move - recording the dollar figure shown but not matching on it.
 */
export const createSpendingLimitAuthorization = (
  assessment: SpendingLimitAssessment,
  spends: readonly { faucetId: string; amount: bigint }[],
  issuedAt: number = Math.floor(Date.now() / 1000),
  makeId: () => string = uuid
): SpendingLimitAuthorization => {
  const validated = parseSpendingLimitAssessment(assessment);
  if (validated.breach === undefined || !Number.isSafeInteger(issuedAt) || issuedAt < validated.assessedAt) {
    throw new SpendingLimitPolicyUnavailableError('Spending limit policy is unavailable: invalid authorization');
  }
  const id = makeId();
  if (id.trim().length === 0) {
    throw new SpendingLimitPolicyUnavailableError('Spending limit policy is unavailable: invalid authorization id');
  }
  return {
    kind: 'usd',
    id,
    accountId: validated.accountId,
    usdAmount: validated.usdAmount,
    spendsDigest: spendsDigest(spends),
    revision: validated.revision,
    issuedAt,
    expiresAt: issuedAt + AUTHORIZATION_LIFETIME_SECONDS
  };
};

/**
 * Binds a short-lived `unpriced` authorization to exactly one set of assets and amounts, for a
 * transaction the wallet could not value at all - there is no dollar figure to bind to instead.
 */
export const createUnpricedSpendingLimitAuthorization = (
  accountId: string,
  spends: readonly { faucetId: string; amount: bigint }[],
  revision: string,
  issuedAt: number = Math.floor(Date.now() / 1000),
  makeId: () => string = uuid
): SpendingLimitAuthorization => {
  if (
    accountId.trim().length === 0 ||
    revision.trim().length === 0 ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt < 0
  ) {
    throw new SpendingLimitPolicyUnavailableError('Spending limit policy is unavailable: invalid authorization');
  }
  const id = makeId();
  if (id.trim().length === 0) {
    throw new SpendingLimitPolicyUnavailableError('Spending limit policy is unavailable: invalid authorization id');
  }
  return {
    kind: 'unpriced',
    id,
    accountId,
    spendsDigest: spendsDigest(spends),
    revision,
    issuedAt,
    expiresAt: issuedAt + AUTHORIZATION_LIFETIME_SECONDS
  };
};
