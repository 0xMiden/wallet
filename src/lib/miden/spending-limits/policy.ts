import { sameSpendingLimitIdentity } from './identity';
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

/**
 * The widest rolling window the policy can assess, so the oldest row that can change a verdict.
 * Exported because the history read is bounded by it: anything older is excluded here anyway.
 */
export const MAX_WINDOW_SECONDS = WEEK_SECONDS;

const OUTGOING_TYPES: ReadonlySet<ITransactionType> = new Set([
  'send',
  'swap',
  'bridged-send',
  'earn-deposit',
  // A dApp custom request moves value too. It carries opaque request bytes and so has no
  // top-level faucet or amount; `spentAssetTotals` is what makes it countable. An older execute
  // row without those totals contributes nothing, which is what it did before.
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
  if (
    !sameSpendingLimitIdentity(proposal.accountId, config.accountId) ||
    !sameSpendingLimitIdentity(proposal.faucetId, config.faucetId)
  ) {
    throw unavailable('proposal identity does not match configuration');
  }
  if (typeof proposal.amount !== 'bigint' || proposal.amount < 0n) throw unavailable('proposed amount is invalid');
  if (!Number.isSafeInteger(proposal.now) || proposal.now < 0) throw unavailable('assessment time is invalid');
};

/**
 * Whether `row` moves value under `faucetId`, and how much.
 *
 * The two answers are kept apart on purpose. "This row is about another asset" is a skip, while
 * "this row is about this asset but states no usable amount" must stay FATAL - collapsing them
 * into one `undefined` silently drops a row that could be hiding spend. `amount` is `unknown`
 * because it comes back from storage, so the caller's `typeof !== 'bigint'` guard is what
 * actually validates it, not the declared row type.
 */
const rowSpendUnderFaucet = (row: ITransaction, faucetId: string): { amount: unknown } | undefined => {
  // An execute row's value is opaque in `requestBytes`, so the approval-time dry run records it
  // per faucet instead. Checked first: such a row has no top-level faucet to match on.
  if (row.spentAssetTotals !== undefined) {
    // SUM every matching entry, never take the first. The producer folds per faucet before this is
    // written, so a duplicate should not exist - but this reads rows persisted by earlier builds,
    // and by any future producer that forgets to fold. Taking the first match would silently drop
    // the rest of that faucet's value out of the rolling total.
    const matching = row.spentAssetTotals.filter(entry => sameSpendingLimitIdentity(entry.faucetId, faucetId));
    if (matching.length === 0) return undefined;
    if (matching.some(entry => typeof entry.amount !== 'bigint')) return { amount: undefined };
    return { amount: matching.reduce((total, entry) => total + entry.amount, 0n) };
  }
  if (row.faucetId === undefined || !sameSpendingLimitIdentity(row.faucetId, faucetId)) return undefined;
  return { amount: row.amount };
};

const matchingSpendEntries = (
  rows: readonly ITransaction[],
  config: SpendingLimitConfiguration,
  now: number
): SpendEntry[] => {
  const entries: SpendEntry[] = [];
  for (const row of rows) {
    if (!sameSpendingLimitIdentity(row.accountId, config.accountId)) continue;
    if (!OUTGOING_TYPES.has(row.type) || row.restoredFromBackup === true) continue;
    const spend = rowSpendUnderFaucet(row, config.faucetId);
    if (spend === undefined) continue;
    // A row that cannot be placed in time cannot be judged in or out of the window, so it stays
    // fatal. Everything below this line is about rows whose timestamp we can trust.
    if (!Number.isSafeInteger(row.initiatedAt) || row.initiatedAt < 0) {
      throw unavailable('matching transaction timestamp is invalid');
    }
    // Fail closed on data that could HIDE spend, not on data that cannot affect the result. A row
    // older than the widest window contributes to no assessment, so a malformed status or amount
    // on it must not make the account permanently unspendable.
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
