import { assessSpendingLimit, MAX_WINDOW_SECONDS } from './policy';
import {
  SpendingLimitAuthorization,
  SpendingLimitAssessment,
  SpendingLimitAssetSnapshot,
  SpendingLimitAuthorizationRequiredError,
  SpendingLimitPolicyUnavailableError,
  parsePersistedSpendingLimit
} from './types';
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

const readPolicy = async (accountId: string, faucetId: string) => {
  try {
    return await Repo.spendingLimits.get([
      canonicalSpendingLimitIdentity(accountId),
      canonicalSpendingLimitIdentity(faucetId)
    ]);
  } catch {
    throw unavailable('configuration storage read failed');
  }
};

export interface SpendingLimitProposal {
  accountId: string;
  faucetId: string;
  amount: bigint;
  now?: number;
}

export interface SpendingLimitAssessmentDetails {
  assessment: SpendingLimitAssessment;
  asset: SpendingLimitAssetSnapshot;
}

export const assessOutgoingSpendingLimitDetails = async (
  proposal: SpendingLimitProposal
): Promise<SpendingLimitAssessmentDetails | undefined> => {
  const persisted = await readPolicy(proposal.accountId, proposal.faucetId);
  if (persisted === undefined) return undefined;
  const config = parsePersistedSpendingLimit(persisted);
  const now = proposal.now ?? Math.floor(Date.now() / 1000);
  return {
    assessment: assessSpendingLimit(config, await readHistory(now), { ...proposal, now }),
    asset: config.asset
  };
};

export const assessOutgoingSpendingLimit = async (
  proposal: SpendingLimitProposal
): Promise<SpendingLimitAssessment | undefined> => (await assessOutgoingSpendingLimitDetails(proposal))?.assessment;

const readHistory = async (now: number): Promise<ITransaction[]> => {
  try {
    // Equivalent account ids can be stored with or without a routing suffix.
    // The pure policy performs the canonical filter after this atomic read.
    //
    // Bounded by the widest window the policy can assess, through the `initiatedAt` index the
    // schema already declares: an older row is dropped by the policy anyway, so reading the whole
    // table only bought a scan that grows with total history - on the write path, inside the rw
    // lock, deserializing every row's request/result blobs. A future-dated row is still at or
    // above this bound, so the policy's own timestamp handling still sees it.
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
  spend: { accountId: string; faucetId: string; amount: bigint },
  revision: string,
  now: number
): Promise<boolean> => {
  if (authorization === undefined) return false;
  if (
    authorization.id.trim().length === 0 ||
    !sameSpendingLimitIdentity(authorization.accountId, spend.accountId) ||
    !sameSpendingLimitIdentity(authorization.faucetId, spend.faucetId) ||
    authorization.amount !== spend.amount ||
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
  const uses = await Repo.transactions.where('spendingLimitAuthorizationId').equals(authorization.id).count();
  return uses === 0;
};

/**
 * Rechecks policy, validates one-time authority, and inserts under one Dexie write lock.
 * Splitting any of those steps lets concurrent callers overspend the same remaining allowance or
 * replay one credential challenge.
 *
 * `spends` is what the row moves, per faucet. Ordinary outgoing transactions name one asset and
 * pass a single entry; a dApp custom request states its value only through the approval-time dry
 * run and can name several, so the list is the general shape and one entry is the common case.
 *
 * The list stays a PARAMETER and is never written onto the row for a single-asset type. The policy
 * checks `row.spentAssetTotals` FIRST and would then ignore the row's own `faucetId`/`amount`, so
 * a send carrying totals would be counted through the wrong branch.
 */
export const queueOutgoingTransaction = async (
  transaction: ITransaction,
  spends: readonly IConsumedAssetTotal[],
  authorization?: SpendingLimitAuthorization,
  now: number = Math.floor(Date.now() / 1000)
): Promise<void> => {
  await Repo.db.transaction('rw', Repo.spendingLimits, Repo.transactions, async () => {
    // Find a policy before reading any history: an account with no limit on any of these faucets
    // must not pay for a window scan inside the write lock on the busiest table.
    const configured: { config: ReturnType<typeof parsePersistedSpendingLimit>; spend: IConsumedAssetTotal }[] = [];
    for (const spend of spends) {
      const persisted = await readPolicy(transaction.accountId, spend.faucetId);
      if (persisted !== undefined) configured.push({ config: parsePersistedSpendingLimit(persisted), spend });
    }
    if (configured.length === 0) {
      await Repo.transactions.add(transaction);
      return;
    }

    const history = await readHistory(now);
    const breached = configured
      .map(({ config, spend }) => ({
        config,
        spend,
        assessment: assessSpendingLimit(config, history, {
          accountId: transaction.accountId,
          faucetId: spend.faucetId,
          amount: spend.amount,
          now
        })
      }))
      .filter(entry => entry.assessment.breaches.length > 0);

    if (breached.length === 0) {
      await Repo.transactions.add(transaction);
      return;
    }
    // One one-time credential binds to exactly one (account, faucet, amount), so two breaches
    // cannot be authorized in a single step. Unreachable for a single-entry list.
    if (breached.length > 1) {
      throw unavailable('a transaction cannot exceed more than one spending limit at once');
    }

    const only = breached[0]!;
    const matches = await authorizationMatches(
      authorization,
      { accountId: transaction.accountId, faucetId: only.spend.faucetId, amount: only.spend.amount },
      only.config.revision,
      now
    );
    if (!matches) throw new SpendingLimitAuthorizationRequiredError(only.assessment);
    await Repo.transactions.add({ ...transaction, spendingLimitAuthorizationId: authorization!.id });
  });
};

/** The single-asset spend list an ordinary outgoing row states through its own fields. */
export const spendsOf = (transaction: QueueableOutgoingTransaction): IConsumedAssetTotal[] => [
  { faucetId: transaction.faucetId, amount: transaction.amount }
];

/**
 * True when ANY spending limit is configured for this account.
 *
 * Used where the value of a request cannot be determined: with no limit configured there is
 * nothing to enforce, and with one configured an unassessable request must be refused rather
 * than admitted.
 */
export const hasSpendingLimits = async (accountId: string): Promise<boolean> => {
  try {
    const count = await Repo.spendingLimits
      .where('accountId')
      .equals(canonicalSpendingLimitIdentity(accountId))
      .count();
    return count > 0;
  } catch {
    throw unavailable('configuration storage read failed');
  }
};
