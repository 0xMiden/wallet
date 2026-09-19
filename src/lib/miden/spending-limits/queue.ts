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
 * Rechecks policy, validates one-time authority, and inserts under one Dexie
 * write lock. Splitting any of those steps lets concurrent callers overspend
 * the same remaining allowance or replay one credential challenge.
 */
export const queueOutgoingTransaction = async (
  transaction: QueueableOutgoingTransaction,
  authorization?: SpendingLimitAuthorization,
  now: number = Math.floor(Date.now() / 1000)
): Promise<void> => {
  await Repo.db.transaction('rw', Repo.spendingLimits, Repo.transactions, async () => {
    const persisted = await readPolicy(transaction.accountId, transaction.faucetId);
    if (persisted === undefined) {
      await Repo.transactions.add(transaction);
      return;
    }

    const config = parsePersistedSpendingLimit(persisted);
    const assessment = assessSpendingLimit(config, await readHistory(now), {
      accountId: transaction.accountId,
      faucetId: transaction.faucetId,
      amount: transaction.amount,
      now
    });
    if (assessment.breaches.length === 0) {
      await Repo.transactions.add(transaction);
      return;
    }

    if (
      authorization === undefined ||
      !(await authorizationMatches(authorization, transaction, config.revision, now))
    ) {
      throw new SpendingLimitAuthorizationRequiredError(assessment);
    }
    await Repo.transactions.add({ ...transaction, spendingLimitAuthorizationId: authorization.id });
  });
};

/**
 * Queue a dApp CUSTOM (`execute`) row under the same rules as any other outgoing transaction.
 *
 * A custom request carries opaque bytes, so the value it moves is `spentAssetTotals`, recorded
 * from the approval-time dry run. That makes it several spends at once, one per faucet, which is
 * the only way this differs from `queueOutgoingTransaction`: each is assessed against its own
 * policy, and a request that breaches MORE than one is refused outright rather than authorized,
 * because a single one-time credential can only be bound to one (account, faucet, amount).
 */
export const queueOutgoingCustomTransaction = async (
  transaction: ITransaction & { spentAssetTotals: IConsumedAssetTotal[] },
  authorization?: SpendingLimitAuthorization,
  now: number = Math.floor(Date.now() / 1000)
): Promise<void> => {
  await Repo.db.transaction('rw', Repo.spendingLimits, Repo.transactions, async () => {
    const history = await readHistory(now);
    const breached: { assessment: SpendingLimitAssessment; revision: string; spend: IConsumedAssetTotal }[] = [];

    for (const spend of transaction.spentAssetTotals) {
      const persisted = await readPolicy(transaction.accountId, spend.faucetId);
      if (persisted === undefined) continue;
      const config = parsePersistedSpendingLimit(persisted);
      const assessment = assessSpendingLimit(config, history, {
        accountId: transaction.accountId,
        faucetId: spend.faucetId,
        amount: spend.amount,
        now
      });
      if (assessment.breaches.length > 0) breached.push({ assessment, revision: config.revision, spend });
    }

    if (breached.length === 0) {
      await Repo.transactions.add(transaction);
      return;
    }
    if (breached.length > 1) {
      throw unavailable('a custom transaction cannot exceed more than one spending limit at once');
    }

    const only = breached[0]!;
    const matches = await authorizationMatches(
      authorization,
      { accountId: transaction.accountId, faucetId: only.spend.faucetId, amount: only.spend.amount },
      only.revision,
      now
    );
    if (!matches) throw new SpendingLimitAuthorizationRequiredError(only.assessment);
    await Repo.transactions.add({ ...transaction, spendingLimitAuthorizationId: authorization!.id });
  });
};

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
