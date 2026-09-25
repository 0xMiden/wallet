import { canonicalSpendingLimitIdentity } from './identity';

export interface SpendingLimitDraft {
  accountId: string;
  limit?: bigint;
}

export interface SerializedSpendingLimitDraft {
  accountId: string;
  limit?: string;
}

export interface SpendingLimitConfiguration {
  accountId: string;
  limit: bigint;
  revision: string;
  createdAt: number;
  updatedAt: number;
}

/** IndexedDB shape. Decimal strings avoid browser-specific bigint serialization. */
export interface PersistedSpendingLimit {
  accountId: string;
  limit: string;
  revision: string;
  createdAt: number;
  updatedAt: number;
}

export interface SpendingLimitBreach {
  spent: bigint;
  proposedTotal: bigint;
  limit: bigint;
  overBy: bigint;
  /** Null when the proposed transaction alone is larger than the cap. */
  resetAt: number | null;
}

export interface SpendingLimitAssessment {
  accountId: string;
  usdAmount: bigint;
  revision: string;
  assessedAt: number;
  breach?: SpendingLimitBreach;
}

export interface SerializedSpendingLimitBreach {
  spent: string;
  proposedTotal: string;
  limit: string;
  overBy: string;
  resetAt: number | null;
}

export interface SerializedSpendingLimitAssessment {
  accountId: string;
  usdAmount: string;
  revision: string;
  assessedAt: number;
  breach?: SerializedSpendingLimitBreach;
}

/**
 * One-time authority for exactly one transaction.
 *
 * Two kinds, because there are two reasons a transaction can be stopped, but both bind to the
 * exact assets and amounts being sent (`spendsDigest`) - what the user actually consented to move
 * - rather than to a dollar figure, which can drift with the market between the challenge and
 * redemption. A `usd` authorization additionally records the dollar figure the user was shown, for
 * display and audit only: nothing matches on it. An `unpriced` one has no figure to record at all,
 * because the transaction's value could not be established. Neither is a cryptographic
 * authorization - both exist to stop a stale, mismatched or reused approval at the trusted wallet
 * boundary.
 */
export type SpendingLimitAuthorization =
  | {
      kind: 'usd';
      id: string;
      accountId: string;
      usdAmount: bigint;
      spendsDigest: string;
      revision: string;
      issuedAt: number;
      expiresAt: number;
    }
  | {
      kind: 'unpriced';
      id: string;
      accountId: string;
      spendsDigest: string;
      revision: string;
      issuedAt: number;
      expiresAt: number;
    };

/** Canonical, order-independent identity of what a transaction sends. */
export const spendsDigest = (spends: readonly { faucetId: string; amount: bigint }[]): string =>
  spends
    .map(spend => `${canonicalSpendingLimitIdentity(spend.faucetId)}:${spend.amount.toString()}`)
    .sort()
    .join('|');

/** A fail-closed signal for corrupt configuration, history, or storage reads. */
export class SpendingLimitPolicyUnavailableError extends Error {
  readonly code = 'SPENDING_LIMIT_POLICY_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'SpendingLimitPolicyUnavailableError';
  }
}

export class SpendingLimitAuthorizationRequiredError extends Error {
  readonly code = 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED';

  constructor(readonly assessment: SpendingLimitAssessment) {
    super('A fresh authentication is required to exceed the configured spending limit');
    this.name = 'SpendingLimitAuthorizationRequiredError';
  }
}

/**
 * A covered asset whose dollar value cannot be established right now.
 *
 * Distinct from `SpendingLimitPolicyUnavailableError`: nothing is corrupt, the wallet simply
 * cannot prove the cap is respected. Wallet-owned flows offer one exact step-up; dApp paths refuse.
 */
export class SpendingLimitPriceUnavailableError extends Error {
  readonly code = 'SPENDING_LIMIT_PRICE_UNAVAILABLE';

  constructor(readonly symbol: string) {
    super(`No current price is available for ${symbol}`);
    this.name = 'SpendingLimitPriceUnavailableError';
  }
}

/**
 * Recognise that refusal from either side of the intercom boundary.
 *
 * `instanceof` holds only inside the realm that threw. A frontend flow catching this error caught
 * it after serialization, where the prototype is gone and only the fields survive - which is why
 * `spendingLimitAssessmentFromError` beside this reads `code` rather than testing the class.
 */
export const isSpendingLimitPriceUnavailable = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'SPENDING_LIMIT_PRICE_UNAVAILABLE';

const CANONICAL_AMOUNT = /^(0|[1-9]\d*)$/;

const unavailable = (reason: string): SpendingLimitPolicyUnavailableError =>
  new SpendingLimitPolicyUnavailableError(`Spending limit policy is unavailable: ${reason}`);

const isRecord = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw unavailable(`${field} is invalid`);
  return value;
};

const timestamp = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw unavailable(`${field} is invalid`);
  return value;
};

const domainAmount = (value: unknown, field: string): bigint | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'bigint' || value < 0n) throw unavailable(`${field} is invalid`);
  return value;
};

const requiredDomainAmount = (value: unknown, field: string): bigint => {
  const amount = domainAmount(value, field);
  if (amount === undefined) throw unavailable(`${field} is invalid`);
  return amount;
};

const persistedAmount = (value: unknown, field: string): bigint | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CANONICAL_AMOUNT.test(value)) throw unavailable(`${field} is invalid`);
  return BigInt(value);
};

const requiredPersistedAmount = (value: unknown, field: string): bigint => {
  const amount = persistedAmount(value, field);
  if (amount === undefined) throw unavailable(`${field} is invalid`);
  return amount;
};

export const parseSerializedSpendingAmount = (value: unknown): bigint =>
  requiredPersistedAmount(value, 'proposal amount');

interface CommonFields {
  accountId: string;
  revision: string;
  createdAt: number;
  updatedAt: number;
}

const commonFields = (value: object): CommonFields => {
  const createdAt = timestamp(Reflect.get(value, 'createdAt'), 'createdAt');
  const updatedAt = timestamp(Reflect.get(value, 'updatedAt'), 'updatedAt');
  if (updatedAt < createdAt) throw unavailable('updatedAt precedes createdAt');
  return {
    accountId: requiredString(Reflect.get(value, 'accountId'), 'accountId'),
    revision: requiredString(Reflect.get(value, 'revision'), 'revision'),
    createdAt,
    updatedAt
  };
};

export const toPersistedSpendingLimit = (value: SpendingLimitConfiguration): PersistedSpendingLimit => {
  const common = commonFields(value);
  const limit = requiredDomainAmount(value.limit, 'limit');
  return { ...common, limit: limit.toString() };
};

export const parsePersistedSpendingLimit = (value: unknown): SpendingLimitConfiguration => {
  if (!isRecord(value)) throw unavailable('record is invalid');
  const common = commonFields(value);
  const limit = requiredPersistedAmount(Reflect.get(value, 'limit'), 'limit');
  return { ...common, limit };
};

export const toSerializedSpendingLimitDraft = (value: SpendingLimitDraft): SerializedSpendingLimitDraft => {
  const accountId = requiredString(value.accountId, 'accountId');
  const limit = domainAmount(value.limit, 'limit');
  return { accountId, ...(limit !== undefined && { limit: limit.toString() }) };
};

export const parseSerializedSpendingLimitDraft = (value: unknown): SpendingLimitDraft => {
  if (!isRecord(value)) throw unavailable('draft is invalid');
  const limit = persistedAmount(Reflect.get(value, 'limit'), 'limit');
  return {
    accountId: requiredString(Reflect.get(value, 'accountId'), 'accountId'),
    ...(limit !== undefined && { limit })
  };
};

const parseBreach = (value: unknown, parseAmount: (value: unknown, field: string) => bigint): SpendingLimitBreach => {
  if (!isRecord(value)) throw unavailable('breach is invalid');
  const reset = Reflect.get(value, 'resetAt');
  const resetAt = reset === null ? null : timestamp(reset, 'breach resetAt');
  return {
    spent: parseAmount(Reflect.get(value, 'spent'), 'breach spent'),
    proposedTotal: parseAmount(Reflect.get(value, 'proposedTotal'), 'breach proposedTotal'),
    limit: parseAmount(Reflect.get(value, 'limit'), 'breach limit'),
    overBy: parseAmount(Reflect.get(value, 'overBy'), 'breach overBy'),
    resetAt
  };
};

const validateAssessment = (assessment: SpendingLimitAssessment): SpendingLimitAssessment => {
  const breach = assessment.breach;
  if (breach === undefined) return assessment;
  if (
    breach.proposedTotal !== breach.spent + assessment.usdAmount ||
    breach.proposedTotal <= breach.limit ||
    breach.overBy !== breach.proposedTotal - breach.limit ||
    (breach.resetAt !== null && breach.resetAt <= assessment.assessedAt)
  ) {
    throw unavailable('breach values are inconsistent');
  }
  return assessment;
};

export const parseSpendingLimitAssessment = (value: unknown): SpendingLimitAssessment => {
  if (!isRecord(value)) throw unavailable('assessment is invalid');
  const breachValue = Reflect.get(value, 'breach');
  const breach = breachValue === undefined ? undefined : parseBreach(breachValue, requiredDomainAmount);
  return validateAssessment({
    accountId: requiredString(Reflect.get(value, 'accountId'), 'accountId'),
    usdAmount: requiredDomainAmount(Reflect.get(value, 'usdAmount'), 'usdAmount'),
    revision: requiredString(Reflect.get(value, 'revision'), 'revision'),
    assessedAt: timestamp(Reflect.get(value, 'assessedAt'), 'assessedAt'),
    ...(breach !== undefined && { breach })
  });
};

export const toSerializedSpendingLimitAssessment = (
  value: SpendingLimitAssessment
): SerializedSpendingLimitAssessment => {
  const assessment = parseSpendingLimitAssessment(value);
  return {
    accountId: assessment.accountId,
    usdAmount: assessment.usdAmount.toString(),
    revision: assessment.revision,
    assessedAt: assessment.assessedAt,
    ...(assessment.breach !== undefined && {
      breach: {
        spent: assessment.breach.spent.toString(),
        proposedTotal: assessment.breach.proposedTotal.toString(),
        limit: assessment.breach.limit.toString(),
        overBy: assessment.breach.overBy.toString(),
        resetAt: assessment.breach.resetAt
      }
    })
  };
};

export const parseSerializedSpendingLimitAssessment = (value: unknown): SpendingLimitAssessment => {
  if (!isRecord(value)) throw unavailable('assessment is invalid');
  const breachValue = Reflect.get(value, 'breach');
  const breach = breachValue === undefined ? undefined : parseBreach(breachValue, requiredPersistedAmount);
  return validateAssessment({
    accountId: requiredString(Reflect.get(value, 'accountId'), 'accountId'),
    usdAmount: requiredPersistedAmount(Reflect.get(value, 'usdAmount'), 'usdAmount'),
    revision: requiredString(Reflect.get(value, 'revision'), 'revision'),
    assessedAt: timestamp(Reflect.get(value, 'assessedAt'), 'assessedAt'),
    ...(breach !== undefined && { breach })
  });
};

export const spendingLimitAssessmentFromError = (error: unknown): SpendingLimitAssessment | undefined => {
  if (!isRecord(error) || Reflect.get(error, 'code') !== 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED') return undefined;
  const assessment = Reflect.get(error, 'assessment');
  try {
    return parseSpendingLimitAssessment(assessment);
  } catch {
    // A domain assessment carries bigints; one that crossed the intercom port has been through
    // `toSerializedSpendingLimitAssessment` and carries decimal strings instead - the same shape
    // `parseSerializedSpendingLimitAssessment` already reads for a persisted record.
    try {
      return parseSerializedSpendingLimitAssessment(assessment);
    } catch {
      return undefined;
    }
  }
};
