import {
  SpendingLimitAssessment,
  SpendingLimitBreach,
  SpendingLimitConfiguration,
  SpendingLimitPeriod,
  SpendingLimitPolicyUnavailableError,
  parsePersistedSpendingLimit,
  toPersistedSpendingLimit
} from './types';
import { ITransaction, ITransactionStatus, ITransactionType } from '../db/types';

const DAY_SECONDS = 24 * 60 * 60;
const WEEK_SECONDS = 7 * DAY_SECONDS;

const OUTGOING_TYPES: ReadonlySet<ITransactionType> = new Set(['send', 'swap', 'bridged-send', 'earn-deposit']);
// Failed rows stay reserved because a local failure can happen after submission;
// reconciliation, not optimistic exclusion, is the safe authority on whether value moved.
const INCLUDED_STATUSES: ReadonlySet<ITransactionStatus> = new Set([
  ITransactionStatus.Queued,
  ITransactionStatus.GeneratingTransaction,
  ITransactionStatus.Completed,
  ITransactionStatus.Failed
]);

export interface ProposedSpend {
  accountId: string;
  faucetId: string;
  amount: bigint;
  now: number;
}

interface SpendEntry {
  amount: bigint;
  initiatedAt: number;
}

interface WindowDefinition {
  period: SpendingLimitPeriod;
  seconds: number;
  limit: bigint;
}

const unavailable = (reason: string): SpendingLimitPolicyUnavailableError =>
  new SpendingLimitPolicyUnavailableError(`Spending limit policy is unavailable: ${reason}`);

const validatedConfig = (config: SpendingLimitConfiguration): SpendingLimitConfiguration => {
  // Reuse the persistence codec so in-memory and reloaded policy reject the same malformed state.
  const persisted = toPersistedSpendingLimit(config);
  if (persisted === undefined) throw unavailable('no period is configured');
  return parsePersistedSpendingLimit(persisted);
};

const validateProposal = (config: SpendingLimitConfiguration, proposal: ProposedSpend): void => {
  if (proposal.accountId !== config.accountId || proposal.faucetId !== config.faucetId) {
    throw unavailable('proposal identity does not match configuration');
  }
  if (typeof proposal.amount !== 'bigint' || proposal.amount < 0n) throw unavailable('proposed amount is invalid');
  if (!Number.isSafeInteger(proposal.now) || proposal.now < 0) throw unavailable('assessment time is invalid');
};

const matchingSpendEntries = (
  rows: readonly ITransaction[],
  config: SpendingLimitConfiguration,
  now: number
): SpendEntry[] => {
  const entries: SpendEntry[] = [];
  for (const row of rows) {
    if (row.accountId !== config.accountId || row.faucetId !== config.faucetId) continue;
    if (!OUTGOING_TYPES.has(row.type) || row.restoredFromBackup === true) continue;
    if (!INCLUDED_STATUSES.has(row.status)) throw unavailable('matching transaction status is invalid');
    if (typeof row.amount !== 'bigint' || row.amount < 0n) throw unavailable('matching transaction amount is invalid');
    if (!Number.isSafeInteger(row.initiatedAt) || row.initiatedAt < 0 || row.initiatedAt > now) {
      throw unavailable('matching transaction timestamp is invalid');
    }
    entries.push({ amount: row.amount, initiatedAt: row.initiatedAt });
  }
  return entries.sort((left, right) => left.initiatedAt - right.initiatedAt);
};

const resetAfterEnoughSpendExpires = (
  entries: readonly SpendEntry[],
  proposedAmount: bigint,
  limit: bigint,
  windowSeconds: number
): number | null => {
  const spent = entries.reduce((total, entry) => total + entry.amount, 0n);
  const requiredExpiry = spent + proposedAmount - limit;
  if (requiredExpiry > spent) return null;

  let expired = 0n;
  for (let index = 0; index < entries.length; ) {
    const initiatedAt = entries[index]!.initiatedAt;
    // Same-second rows leave the rolling window together. Check after the group
    // so resetAt never promises capacity before all value at that timestamp expires.
    while (index < entries.length && entries[index]!.initiatedAt === initiatedAt) {
      expired += entries[index]!.amount;
      index += 1;
    }
    if (expired >= requiredExpiry) return initiatedAt + windowSeconds;
  }
  return null;
};

const assessWindow = (
  definition: WindowDefinition,
  entries: readonly SpendEntry[],
  proposal: ProposedSpend
): SpendingLimitBreach | undefined => {
  // The exact boundary is expired, matching a rolling window of (now - duration, now].
  const included = entries.filter(entry => entry.initiatedAt > proposal.now - definition.seconds);
  const spent = included.reduce((total, entry) => total + entry.amount, 0n);
  const proposedTotal = spent + proposal.amount;
  if (proposedTotal <= definition.limit) return undefined;
  return {
    period: definition.period,
    spent,
    proposedTotal,
    limit: definition.limit,
    overBy: proposedTotal - definition.limit,
    resetAt: resetAfterEnoughSpendExpires(included, proposal.amount, definition.limit, definition.seconds)
  };
};

export const assessSpendingLimit = (
  sourceConfig: SpendingLimitConfiguration,
  rows: readonly ITransaction[],
  proposal: ProposedSpend
): SpendingLimitAssessment => {
  const config = validatedConfig(sourceConfig);
  validateProposal(config, proposal);
  const entries = matchingSpendEntries(rows, config, proposal.now);
  const windows: WindowDefinition[] = [];
  if (config.dailyLimit !== undefined) windows.push({ period: '24h', seconds: DAY_SECONDS, limit: config.dailyLimit });
  if (config.weeklyLimit !== undefined)
    windows.push({ period: '7d', seconds: WEEK_SECONDS, limit: config.weeklyLimit });

  const breaches = windows.flatMap(window => {
    const breach = assessWindow(window, entries, proposal);
    return breach === undefined ? [] : [breach];
  });
  return {
    accountId: proposal.accountId,
    faucetId: proposal.faucetId,
    amount: proposal.amount,
    revision: config.revision,
    assessedAt: proposal.now,
    breaches
  };
};
