import { assessSpendingLimit, MAX_WINDOW_SECONDS } from './policy';
import {
  SpendingLimitAssessment,
  SpendingLimitAuthorization,
  SpendingLimitAuthorizationRequiredError,
  SpendingLimitPolicyUnavailableError,
  SpendingLimitPriceUnavailableError,
  parsePersistedSpendingLimit,
  spendsDigest
} from './types';
import { resolveSpendsUsd } from './valuation';
import { IConsumedAssetTotal, ITransaction } from '../db/types';
import * as Repo from '../repo';
import { canonicalSpendingLimitIdentity, sameSpendingLimitIdentity } from './identity';

const MAX_AUTHORIZATION_LIFETIME_SECONDS = 2 * 60;

export interface QueueableOutgoingTransaction extends ITransaction {
  amount: bigint;
  faucetId: string;
}

const unavailable = (reason: string): SpendingLimitPolicyUnavailableError =>
  new SpendingLimitPolicyUnavailableError(`Spending limit policy is unavailable: ${reason}`);

const readPolicy = async (accountId: string) => {
  try {
    return await Repo.spendingLimits.get(canonicalSpendingLimitIdentity(accountId));
  } catch {
    throw unavailable('configuration storage read failed');
  }
};

export interface SpendingLimitProposal {
  accountId: string;
  spends: readonly IConsumedAssetTotal[];
  now?: number;
}

export interface SpendingLimitAssessmentDetails {
  assessment: SpendingLimitAssessment;
}

/**
 * Preflights a proposed spend for a dApp confirmation sheet.
 *
 * `SpendingLimitPriceUnavailableError` is left to propagate, not caught: the caller needs to tell
 * "no limit configured" (`undefined`) apart from "a limit exists but this cannot be valued", and
 * only the exception carries the second signal.
 */
export const assessOutgoingSpendingLimitDetails = async (
  proposal: SpendingLimitProposal
): Promise<SpendingLimitAssessmentDetails | undefined> => {
  const persisted = await readPolicy(proposal.accountId);
  if (persisted === undefined) return undefined;
  const config = parsePersistedSpendingLimit(persisted);
  const now = proposal.now ?? Math.floor(Date.now() / 1000);
  const usdAmount = await resolveSpendsUsd(proposal.spends, now);
  return {
    assessment: assessSpendingLimit(config, await readHistory(now), {
      accountId: proposal.accountId,
      usdAmount,
      now
    })
  };
};

const readHistory = async (now: number): Promise<ITransaction[]> => {
  try {
    // Equivalent account ids can be stored with or without a routing suffix.
    // The pure policy performs the canonical filter after this atomic read.
    //
    // Bounded by the rolling window through the `initiatedAt` index the schema already declares:
    // an older row is dropped by the policy anyway, so reading the whole table only bought a scan
    // that grows with total history - on the write path, inside the rw lock, deserializing every
    // row's request/result blobs. A future-dated row is still at or above this bound, so the
    // policy's own timestamp handling still sees it.
    return await Repo.transactions
      .where('initiatedAt')
      .aboveOrEqual(now - MAX_WINDOW_SECONDS)
      .toArray();
  } catch {
    throw unavailable('transaction history read failed');
  }
};

const authorizationMatches = async (
  authorization: SpendingLimitAuthorization | undefined,
  expected: { accountId: string; usdAmount?: bigint; spendsDigest?: string },
  revision: string,
  now: number
): Promise<boolean> => {
  if (authorization === undefined) return false;
  if (
    authorization.id.trim().length === 0 ||
    !sameSpendingLimitIdentity(authorization.accountId, expected.accountId) ||
    authorization.revision !== revision ||
    !Number.isSafeInteger(authorization.issuedAt) ||
    !Number.isSafeInteger(authorization.expiresAt) ||
    authorization.issuedAt < 0 ||
    authorization.issuedAt > now ||
    authorization.expiresAt <= now ||
    authorization.expiresAt <= authorization.issuedAt ||
    authorization.expiresAt - authorization.issuedAt > MAX_AUTHORIZATION_LIFETIME_SECONDS
  ) {
    return false;
  }
  if (authorization.kind === 'usd') {
    if (expected.usdAmount === undefined || authorization.usdAmount !== expected.usdAmount) return false;
  } else {
    if (expected.spendsDigest === undefined || authorization.spendsDigest !== expected.spendsDigest) return false;
  }
  const uses = await Repo.transactions.where('spendingLimitAuthorizationId').equals(authorization.id).count();
  return uses === 0;
};

/**
 * Rechecks policy, values the spend, assesses, and inserts under one Dexie write lock.
 * Splitting any of those steps lets concurrent callers overspend the same remaining allowance or
 * replay one credential challenge.
 *
 * `spends` is what the row moves, per faucet. Ordinary outgoing transactions name one asset and
 * pass a single entry; a dApp custom request states its value only through the approval-time dry
 * run and can name several, so the list is the general shape and one entry is the common case.
 */
export const queueOutgoingTransaction = async (
  transaction: ITransaction,
  spends: readonly IConsumedAssetTotal[],
  authorization?: SpendingLimitAuthorization,
  now: number = Math.floor(Date.now() / 1000)
): Promise<void> => {
  // An account with no cap must pay for neither a price lookup nor a window scan. This read is a
  // fast path only; the authoritative one happens inside the write transaction below.
  if ((await readPolicy(transaction.accountId)) === undefined) {
    await Repo.transactions.add(transaction);
    return;
  }

  // Outside the lock on purpose: resolution can reach the network, and a Dexie write transaction
  // that awaits a fetch is a write lock held across an unbounded wait.
  let spentUsd: bigint | undefined;
  let priceFailure: SpendingLimitPriceUnavailableError | undefined;
  try {
    spentUsd = await resolveSpendsUsd(spends, now);
  } catch (error) {
    if (!(error instanceof SpendingLimitPriceUnavailableError)) throw error;
    priceFailure = error;
  }

  await Repo.db.transaction('rw', Repo.spendingLimits, Repo.transactions, async () => {
    const persisted = await readPolicy(transaction.accountId);
    if (persisted === undefined) {
      await Repo.transactions.add(transaction);
      return;
    }
    const config = parsePersistedSpendingLimit(persisted);

    if (priceFailure !== undefined) {
      const digest = spendsDigest(spends);
      const matches = await authorizationMatches(
        authorization,
        { accountId: transaction.accountId, spendsDigest: digest },
        config.revision,
        now
      );
      if (!matches) throw priceFailure;
      // No `spentUsd` here: the wallet does not know what this row was worth, and inventing a
      // figure to stamp would be worse than leaving it uncounted by every future assessment.
      await Repo.transactions.add({ ...transaction, spendingLimitAuthorizationId: authorization!.id });
      return;
    }

    const assessment = assessSpendingLimit(config, await readHistory(now), {
      accountId: transaction.accountId,
      usdAmount: spentUsd!,
      now
    });
    const stamped = { ...transaction, spentUsd: spentUsd! };
    if (assessment.breach === undefined) {
      await Repo.transactions.add(stamped);
      return;
    }
    const matches = await authorizationMatches(
      authorization,
      { accountId: transaction.accountId, usdAmount: spentUsd! },
      config.revision,
      now
    );
    if (!matches) throw new SpendingLimitAuthorizationRequiredError(assessment);
    await Repo.transactions.add({ ...stamped, spendingLimitAuthorizationId: authorization!.id });
  });
};

/** The single-asset spend list an ordinary outgoing row states through its own fields. */
export const spendsOf = (transaction: QueueableOutgoingTransaction): IConsumedAssetTotal[] => [
  { faucetId: transaction.faucetId, amount: transaction.amount }
];

/**
 * True when a spending limit is configured for this account.
 *
 * Used where the value of a request cannot be determined: with no limit configured there is
 * nothing to enforce, and with one configured an unassessable request must be refused rather
 * than admitted.
 */
export const hasSpendingLimits = async (accountId: string): Promise<boolean> =>
  (await readPolicy(accountId)) !== undefined;
