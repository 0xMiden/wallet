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

const persistedAmount = (value: unknown, field: string): bigint | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CANONICAL_AMOUNT.test(value)) throw unavailable(`${field} is invalid`);
  return BigInt(value);
};

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
