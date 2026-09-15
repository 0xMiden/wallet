import { assessSpendingLimit } from './policy';
import {
  SpendingLimitAuthorization,
  SpendingLimitAssessment,
  SpendingLimitAuthorizationRequiredError,
  SpendingLimitPolicyUnavailableError,
  parsePersistedSpendingLimit
} from './types';
import { ITransaction } from '../db/types';
import * as Repo from '../repo';

const MAX_AUTHORIZATION_LIFETIME_SECONDS = 2 * 60;

export interface QueueableOutgoingTransaction extends ITransaction {
  amount: bigint;
  faucetId: string;
}

const unavailable = (reason: string): SpendingLimitPolicyUnavailableError =>
  new SpendingLimitPolicyUnavailableError(`Spending limit policy is unavailable: ${reason}`);

const readPolicy = async (accountId: string, faucetId: string) => {
  try {
    return await Repo.spendingLimits.get([accountId, faucetId]);
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

export const assessOutgoingSpendingLimit = async (
  proposal: SpendingLimitProposal
): Promise<SpendingLimitAssessment | undefined> => {
  const persisted = await readPolicy(proposal.accountId, proposal.faucetId);
  if (persisted === undefined) return undefined;
  const config = parsePersistedSpendingLimit(persisted);
  const now = proposal.now ?? Math.floor(Date.now() / 1000);
  return assessSpendingLimit(config, await readHistory(proposal.accountId), { ...proposal, now });
};

const readHistory = async (accountId: string): Promise<ITransaction[]> => {
  try {
    return await Repo.transactions.where('accountId').equals(accountId).toArray();
  } catch {
    throw unavailable('transaction history read failed');
  }
};

const authorizationMatches = async (
  authorization: SpendingLimitAuthorization | undefined,
  transaction: QueueableOutgoingTransaction,
  revision: string,
  now: number
): Promise<boolean> => {
  if (authorization === undefined) return false;
  if (
    authorization.id.trim().length === 0 ||
    authorization.accountId !== transaction.accountId ||
    authorization.faucetId !== transaction.faucetId ||
    authorization.amount !== transaction.amount ||
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
    const assessment = assessSpendingLimit(config, await readHistory(transaction.accountId), {
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
