import { sameSpendingLimitIdentity } from './identity';
import {
  SpendingLimitAssessment,
  SpendingLimitBreach,
  SpendingLimitConfiguration,
  SpendingLimitPolicyUnavailableError,
  parsePersistedSpendingLimit,
  toPersistedSpendingLimit
} from './types';
import { ITransaction, ITransactionStatus, ITransactionType } from '../db/types';

const DAY_SECONDS = 24 * 60 * 60;

/** The only rolling window, and so the bound on the history read. */
export const MAX_WINDOW_SECONDS = DAY_SECONDS;

const OUTGOING_TYPES: ReadonlySet<ITransactionType> = new Set([
  'send',
  'swap',
  'bridged-send',
  'earn-deposit',
  // A dApp custom request moves value too. It carries opaque request bytes and so has no
  // top-level faucet or amount; `spentUsd` is what makes it countable, stamped from the
  // approval-time valuation same as every other outgoing type.
  'execute'
]);
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
  usdAmount: bigint;
  now: number;
}

interface SpendEntry {
  amount: bigint;
  initiatedAt: number;
}

const unavailable = (reason: string): SpendingLimitPolicyUnavailableError =>
  new SpendingLimitPolicyUnavailableError(`Spending limit policy is unavailable: ${reason}`);

const validatedConfig = (config: SpendingLimitConfiguration): SpendingLimitConfiguration => {
  // Reuse the persistence codec so in-memory and reloaded policy reject the same malformed state.
  return parsePersistedSpendingLimit(toPersistedSpendingLimit(config));
};

const validateProposal = (config: SpendingLimitConfiguration, proposal: ProposedSpend): void => {
  if (!sameSpendingLimitIdentity(proposal.accountId, config.accountId)) {
    throw unavailable('proposal identity does not match configuration');
  }
  if (typeof proposal.usdAmount !== 'bigint' || proposal.usdAmount < 0n) {
    throw unavailable('proposed amount is invalid');
  }
  if (!Number.isSafeInteger(proposal.now) || proposal.now < 0) throw unavailable('assessment time is invalid');
};

/**
 * What `row` contributed to the cap, in micro-dollars.
 *
 * A row with no stamped value contributes nothing: it predates USD limits, or every asset it moved
 * was one the feed cannot price. A row inside the window whose stamp is present but unusable stays
 * FATAL, for the same reason the per-faucet version did - a malformed value must not silently drop
 * spend out of the total.
 */
const rowSpendUsd = (row: ITransaction): { amount: unknown } | undefined =>
  row.spentUsd === undefined ? undefined : { amount: row.spentUsd };

const matchingSpendEntries = (
  rows: readonly ITransaction[],
  config: SpendingLimitConfiguration,
  now: number
): SpendEntry[] => {
  const entries: SpendEntry[] = [];
  for (const row of rows) {
    if (!sameSpendingLimitIdentity(row.accountId, config.accountId)) continue;
    if (!OUTGOING_TYPES.has(row.type) || row.restoredFromBackup === true) continue;
    const spend = rowSpendUsd(row);
    if (spend === undefined) continue;
    // A row that cannot be placed in time cannot be judged in or out of the window, so it stays
    // fatal. Everything below this line is about rows whose timestamp we can trust.
    if (!Number.isSafeInteger(row.initiatedAt) || row.initiatedAt < 0) {
      throw unavailable('matching transaction timestamp is invalid');
    }
    // Fail closed on data that could HIDE spend, not on data that cannot affect the result. A row
    // older than the window contributes to no assessment, so a malformed status or amount on it
    // must not make the account permanently unspendable.
    if (row.initiatedAt < now - MAX_WINDOW_SECONDS) continue;
    if (!INCLUDED_STATUSES.has(row.status)) throw unavailable('matching transaction status is invalid');
    if (typeof spend.amount !== 'bigint' || spend.amount < 0n)
      throw unavailable('matching transaction amount is invalid');
    // A wall clock set ahead and then corrected leaves rows stamped in the future, and those satisfy
    // every window filter. Counting such a row at `now` keeps its value charged against the user
    // while letting it expire on schedule; refusing to assess at all bought no safety and bricked
    // the account for as long as the skew lasted.
    entries.push({ amount: spend.amount, initiatedAt: Math.min(row.initiatedAt, now) });
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
  limit: bigint,
  windowSeconds: number,
  entries: readonly SpendEntry[],
  proposal: ProposedSpend
): SpendingLimitBreach | undefined => {
  // The exact boundary is expired, matching a rolling window of (now - duration, now].
  const included = entries.filter(entry => entry.initiatedAt > proposal.now - windowSeconds);
  const spent = included.reduce((total, entry) => total + entry.amount, 0n);
  const proposedTotal = spent + proposal.usdAmount;
  if (proposedTotal <= limit) return undefined;
  return {
    spent,
    proposedTotal,
    limit,
    overBy: proposedTotal - limit,
    resetAt: resetAfterEnoughSpendExpires(included, proposal.usdAmount, limit, windowSeconds)
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
  const breach = assessWindow(config.limit, MAX_WINDOW_SECONDS, entries, proposal);
  return {
    accountId: proposal.accountId,
    usdAmount: proposal.usdAmount,
    revision: config.revision,
    assessedAt: proposal.now,
    ...(breach !== undefined && { breach })
  };
};
