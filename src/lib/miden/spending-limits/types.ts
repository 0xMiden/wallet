export type SpendingLimitPeriod = '24h' | '7d';

export interface SpendingLimitAssetSnapshot {
  symbol: string;
  decimals: number;
  name?: string;
}

export interface SpendingLimitPeriods {
  dailyLimit?: bigint;
  weeklyLimit?: bigint;
}

export interface SpendingLimitDraft extends SpendingLimitPeriods {
  accountId: string;
  faucetId: string;
  asset: SpendingLimitAssetSnapshot;
}

export interface SerializedSpendingLimitDraft {
  accountId: string;
  faucetId: string;
  dailyLimit?: string;
  weeklyLimit?: string;
  asset: SpendingLimitAssetSnapshot;
}

export interface SpendingLimitConfiguration extends SpendingLimitPeriods {
  accountId: string;
  faucetId: string;
  asset: SpendingLimitAssetSnapshot;
  revision: string;
  createdAt: number;
  updatedAt: number;
}

/** IndexedDB shape. Decimal strings avoid browser-specific bigint serialization. */
export interface PersistedSpendingLimit {
  accountId: string;
  faucetId: string;
  dailyLimit?: string;
  weeklyLimit?: string;
  asset: SpendingLimitAssetSnapshot;
  revision: string;
  createdAt: number;
  updatedAt: number;
}

export interface SpendingLimitBreach {
  period: SpendingLimitPeriod;
  spent: bigint;
  proposedTotal: bigint;
  limit: bigint;
  overBy: bigint;
  /** Null when the proposed transaction alone is larger than the cap. */
  resetAt: number | null;
}

export interface SpendingLimitAssessment {
  accountId: string;
  faucetId: string;
  amount: bigint;
  revision: string;
  assessedAt: number;
  breaches: SpendingLimitBreach[];
}

export interface SerializedSpendingLimitBreach {
  period: SpendingLimitPeriod;
  spent: string;
  proposedTotal: string;
  limit: string;
  overBy: string;
  resetAt: number | null;
}

export interface SerializedSpendingLimitAssessment {
  accountId: string;
  faucetId: string;
  amount: string;
  revision: string;
  assessedAt: number;
  breaches: SerializedSpendingLimitBreach[];
}

export interface SpendingLimitAuthorization {
  id: string;
  accountId: string;
  faucetId: string;
  amount: bigint;
  revision: string;
  issuedAt: number;
  expiresAt: number;
}

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

const CANONICAL_AMOUNT = /^(0|[1-9]\d*)$/;

const unavailable = (reason: string): SpendingLimitPolicyUnavailableError =>
  new SpendingLimitPolicyUnavailableError(`Spending limit policy is unavailable: ${reason}`);

const isRecord = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw unavailable(`${field} is invalid`);
  return value;
};

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  return requiredString(value, field);
};

const timestamp = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw unavailable(`${field} is invalid`);
  return value;
};

const assetSnapshot = (value: unknown): SpendingLimitAssetSnapshot => {
  if (!isRecord(value)) throw unavailable('asset snapshot is invalid');
  const symbol = requiredString(Reflect.get(value, 'symbol'), 'asset symbol');
  const decimals = Reflect.get(value, 'decimals');
  if (typeof decimals !== 'number' || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw unavailable('asset decimals are invalid');
  }
  const name = optionalString(Reflect.get(value, 'name'), 'asset name');
  return { symbol, decimals, ...(name !== undefined && { name }) };
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
  faucetId: string;
  asset: SpendingLimitAssetSnapshot;
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
    faucetId: requiredString(Reflect.get(value, 'faucetId'), 'faucetId'),
    asset: assetSnapshot(Reflect.get(value, 'asset')),
    revision: requiredString(Reflect.get(value, 'revision'), 'revision'),
    createdAt,
    updatedAt
  };
};

export const toPersistedSpendingLimit = (value: SpendingLimitConfiguration): PersistedSpendingLimit | undefined => {
  const common = commonFields(value);
  const dailyLimit = domainAmount(value.dailyLimit, 'dailyLimit');
  const weeklyLimit = domainAmount(value.weeklyLimit, 'weeklyLimit');
  if (dailyLimit === undefined && weeklyLimit === undefined) return undefined;
  return {
    ...common,
    ...(dailyLimit !== undefined && { dailyLimit: dailyLimit.toString() }),
    ...(weeklyLimit !== undefined && { weeklyLimit: weeklyLimit.toString() })
  };
};

export const parsePersistedSpendingLimit = (value: unknown): SpendingLimitConfiguration => {
  if (!isRecord(value)) throw unavailable('record is invalid');
  const common = commonFields(value);
  const dailyLimit = persistedAmount(Reflect.get(value, 'dailyLimit'), 'dailyLimit');
  const weeklyLimit = persistedAmount(Reflect.get(value, 'weeklyLimit'), 'weeklyLimit');
  if (dailyLimit === undefined && weeklyLimit === undefined) throw unavailable('no period is configured');
  return {
    ...common,
    ...(dailyLimit !== undefined && { dailyLimit }),
    ...(weeklyLimit !== undefined && { weeklyLimit })
  };
};

export const toSerializedSpendingLimitDraft = (value: SpendingLimitDraft): SerializedSpendingLimitDraft => {
  const accountId = requiredString(value.accountId, 'accountId');
  const faucetId = requiredString(value.faucetId, 'faucetId');
  const asset = assetSnapshot(value.asset);
  const dailyLimit = domainAmount(value.dailyLimit, 'dailyLimit');
  const weeklyLimit = domainAmount(value.weeklyLimit, 'weeklyLimit');
  return {
    accountId,
    faucetId,
    asset,
    ...(dailyLimit !== undefined && { dailyLimit: dailyLimit.toString() }),
    ...(weeklyLimit !== undefined && { weeklyLimit: weeklyLimit.toString() })
  };
};

export const parseSerializedSpendingLimitDraft = (value: unknown): SpendingLimitDraft => {
  if (!isRecord(value)) throw unavailable('draft is invalid');
  const dailyLimit = persistedAmount(Reflect.get(value, 'dailyLimit'), 'dailyLimit');
  const weeklyLimit = persistedAmount(Reflect.get(value, 'weeklyLimit'), 'weeklyLimit');
  return {
    accountId: requiredString(Reflect.get(value, 'accountId'), 'accountId'),
    faucetId: requiredString(Reflect.get(value, 'faucetId'), 'faucetId'),
    asset: assetSnapshot(Reflect.get(value, 'asset')),
    ...(dailyLimit !== undefined && { dailyLimit }),
    ...(weeklyLimit !== undefined && { weeklyLimit })
  };
};

const parseBreach = (value: unknown, parseAmount: (value: unknown, field: string) => bigint): SpendingLimitBreach => {
  if (!isRecord(value)) throw unavailable('breach is invalid');
  const period = Reflect.get(value, 'period');
  if (period !== '24h' && period !== '7d') throw unavailable('breach period is invalid');
  const reset = Reflect.get(value, 'resetAt');
  const resetAt = reset === null ? null : timestamp(reset, 'breach resetAt');
  return {
    period,
    spent: parseAmount(Reflect.get(value, 'spent'), 'breach spent'),
    proposedTotal: parseAmount(Reflect.get(value, 'proposedTotal'), 'breach proposedTotal'),
    limit: parseAmount(Reflect.get(value, 'limit'), 'breach limit'),
    overBy: parseAmount(Reflect.get(value, 'overBy'), 'breach overBy'),
    resetAt
  };
};

const validateAssessment = (assessment: SpendingLimitAssessment): SpendingLimitAssessment => {
  if (assessment.breaches.length > 2) throw unavailable('too many breach periods');
  const periods = new Set<SpendingLimitPeriod>();
  for (const breach of assessment.breaches) {
    if (
      periods.has(breach.period) ||
      breach.proposedTotal !== breach.spent + assessment.amount ||
      breach.proposedTotal <= breach.limit ||
      breach.overBy !== breach.proposedTotal - breach.limit ||
      (breach.resetAt !== null && breach.resetAt <= assessment.assessedAt)
    ) {
      throw unavailable('breach values are inconsistent');
    }
    periods.add(breach.period);
  }
  if (assessment.breaches.length === 2 && assessment.breaches[0]?.period !== '24h') {
    throw unavailable('breach periods are out of order');
  }
  return assessment;
};

export const parseSpendingLimitAssessment = (value: unknown): SpendingLimitAssessment => {
  if (!isRecord(value)) throw unavailable('assessment is invalid');
  const breaches = Reflect.get(value, 'breaches');
  if (!Array.isArray(breaches)) throw unavailable('assessment breaches are invalid');
  return validateAssessment({
    accountId: requiredString(Reflect.get(value, 'accountId'), 'accountId'),
    faucetId: requiredString(Reflect.get(value, 'faucetId'), 'faucetId'),
    amount: requiredDomainAmount(Reflect.get(value, 'amount'), 'amount'),
    revision: requiredString(Reflect.get(value, 'revision'), 'revision'),
    assessedAt: timestamp(Reflect.get(value, 'assessedAt'), 'assessedAt'),
    breaches: breaches.map(breach => parseBreach(breach, requiredDomainAmount))
  });
};

export const toSerializedSpendingLimitAssessment = (
  value: SpendingLimitAssessment
): SerializedSpendingLimitAssessment => {
  const assessment = parseSpendingLimitAssessment(value);
  return {
    ...assessment,
    amount: assessment.amount.toString(),
    breaches: assessment.breaches.map(breach => ({
      period: breach.period,
      spent: breach.spent.toString(),
      proposedTotal: breach.proposedTotal.toString(),
      limit: breach.limit.toString(),
      overBy: breach.overBy.toString(),
      resetAt: breach.resetAt
    }))
  };
};

export const parseSerializedSpendingLimitAssessment = (value: unknown): SpendingLimitAssessment => {
  if (!isRecord(value)) throw unavailable('assessment is invalid');
  const breaches = Reflect.get(value, 'breaches');
  if (!Array.isArray(breaches)) throw unavailable('assessment breaches are invalid');
  return validateAssessment({
    accountId: requiredString(Reflect.get(value, 'accountId'), 'accountId'),
    faucetId: requiredString(Reflect.get(value, 'faucetId'), 'faucetId'),
    amount: requiredPersistedAmount(Reflect.get(value, 'amount'), 'amount'),
    revision: requiredString(Reflect.get(value, 'revision'), 'revision'),
    assessedAt: timestamp(Reflect.get(value, 'assessedAt'), 'assessedAt'),
    breaches: breaches.map(breach => parseBreach(breach, requiredPersistedAmount))
  });
};

export const spendingLimitAssessmentFromError = (error: unknown): SpendingLimitAssessment | undefined => {
  if (!isRecord(error) || Reflect.get(error, 'code') !== 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED') return undefined;
  try {
    return parseSpendingLimitAssessment(Reflect.get(error, 'assessment'));
  } catch {
    return undefined;
  }
};
