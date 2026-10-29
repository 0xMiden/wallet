import { recoveryDebit, historyWithRecoveryDebits } from '../recovery/financial';
import {
  checkpointFinancialChange,
  verifyFinancialRecovery,
  withFinancialRecoveryLock
} from '../recovery/financial-writer';
import { assertStorageHealthy, getStorageHealth } from '../storage-health';
import { canonicalSpendingLimitIdentity, sameSpendingLimitIdentity } from './identity';
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
    // One read transaction, so the counts and the read below are one snapshot; on the enforcement
    // path it nests inside the caller's rw scope.
    return await Repo.db.transaction('r', Repo.transactions, Repo.recoveryDebits, async () => {
      // A row the index cannot place (missing, NaN, null) and a negative one both fall outside
      // `aboveOrEqual(0)`, so one count finds every row the window read below would never hand the
      // policy's fatal timestamp guard; a non-number key sorts above every number, so it stays in
      // both the count and the window. When any exist, the whole table is read instead (#1007).
      const [total, placed] = await Promise.all([
        Repo.transactions.count(),
        Repo.transactions.where('initiatedAt').aboveOrEqual(0).count()
      ]);
      if (total > placed) return historyWithRecoveryDebits(await Repo.transactions.toArray(), now);
      // Bounded by the rolling window through the `initiatedAt` index the schema already declares:
      // an older row is dropped by the policy anyway, so reading the whole table only bought a scan
      // that grows with total history - on the write path, inside the rw lock, deserializing every
      // row's request/result blobs. A future-dated row is still at or above this bound, so the
      // policy's own timestamp handling still sees it.
      return historyWithRecoveryDebits(
        await Repo.transactions
          .where('initiatedAt')
          .aboveOrEqual(now - MAX_WINDOW_SECONDS)
          .toArray(),
        now
      );
    });
  } catch {
    throw unavailable('transaction history read failed');
  }
};

/**
 * Both authorization kinds bind to the exact spends (`spendsDigest`), not to a dollar figure: the
 * user consented to move THESE assets in THESE amounts, and that consent should survive a price
 * refresh between the challenge and this redemption. A `usd` authorization's `usdAmount` is a
 * record of the figure the user was shown, not part of the match.
 *
 * `kind` still gates: a `usd` authorization was minted against a shown breach (amount, over-by,
 * reset), an `unpriced` one against no numbers at all. Redeeming one as the other would let a
 * "price unavailable, please confirm" authentication silently cover a dollar breach the user was
 * never shown - matching spends is not the same consent as matching spends AND presentation.
 */
const authorizationMatches = async (
  authorization: SpendingLimitAuthorization | undefined,
  expected: { accountId: string; spendsDigest: string; kind: SpendingLimitAuthorization['kind'] },
  revision: string,
  now: number
): Promise<boolean> => {
  if (authorization === undefined || authorization.kind !== expected.kind) return false;
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
    authorization.expiresAt - authorization.issuedAt > MAX_AUTHORIZATION_LIFETIME_SECONDS ||
    authorization.spendsDigest !== expected.spendsDigest
  ) {
    return false;
  }
  const uses =
    (await Repo.transactions.where('spendingLimitAuthorizationId').equals(authorization.id).count()) +
    (await Repo.recoveryDebits.where('authorizationId').equals(authorization.id).count());
  return uses === 0;
};

/** Resolves outside the write lock; a missing price can be authorized during admission. */
export const resolveOutgoingSpendUsd = async (
  spends: readonly IConsumedAssetTotal[],
  now: number = Math.floor(Date.now() / 1000)
): Promise<bigint | SpendingLimitPriceUnavailableError> => {
  try {
    return await resolveSpendsUsd(spends, now);
  } catch (error) {
    if (!(error instanceof SpendingLimitPriceUnavailableError)) throw error;
    return error;
  }
};

/**
 * Rechecks policy, assesses, and stamps a row inside the caller's existing rw transaction over
 * Repo.spendingLimits and Repo.transactions. The caller adds the returned row in that same scope,
 * keeping admission atomic with any note dedup and preventing concurrent overspend or credential replay.
 * An undefined price is allowed only while the locked policy read confirms no cap exists.
 */
export const admitOutgoingTransaction = async <T extends ITransaction>(
  transaction: T,
  spends: readonly IConsumedAssetTotal[],
  price: bigint | SpendingLimitPriceUnavailableError | undefined,
  authorization?: SpendingLimitAuthorization,
  now: number = Math.floor(Date.now() / 1000)
): Promise<T> => {
  const persisted = await readPolicy(transaction.accountId);
  if (persisted === undefined) return transaction;
  const config = parsePersistedSpendingLimit(persisted);
  if (price === undefined) throw unavailable('spend price was not resolved before admission');

  if (price instanceof SpendingLimitPriceUnavailableError) {
    const matches = await authorizationMatches(
      authorization,
      { accountId: transaction.accountId, spendsDigest: spendsDigest(spends), kind: 'unpriced' },
      config.revision,
      now
    );
    if (!matches) throw price;
    // No `spentUsd` here: the wallet does not know what this row was worth, and inventing a
    // figure to stamp would be worse than leaving it uncounted by every future assessment.
    return { ...transaction, spendingLimitAuthorizationId: authorization!.id };
  }

  const assessment = assessSpendingLimit(config, await readHistory(now), {
    accountId: transaction.accountId,
    usdAmount: price,
    now
  });
  const stamped = { ...transaction, spentUsd: price };
  if (assessment.breach === undefined) return stamped;
  const matches = await authorizationMatches(
    authorization,
    { accountId: transaction.accountId, spendsDigest: spendsDigest(spends), kind: 'usd' },
    config.revision,
    now
  );
  if (!matches) throw new SpendingLimitAuthorizationRequiredError(assessment);
  return { ...stamped, spendingLimitAuthorizationId: authorization!.id };
};

/**
 * Values the spend before locking, then rechecks policy, assesses, and inserts under one Dexie
 * write lock. `spends` is what the row moves, per faucet: one for ordinary outgoing transactions,
 * or several from a dApp custom request's approval-time dry run.
 */
const prepareOutgoingTransaction = async (
  transaction: ITransaction,
  spends: readonly IConsumedAssetTotal[],
  authorization: SpendingLimitAuthorization | undefined,
  now: number,
  beforeInsert: (() => Promise<void>) | undefined,
  insert: (row: ITransaction) => Promise<void>
): Promise<void> => {
  // An account with no cap must pay for neither a price lookup nor a window scan - but the insert
  // itself still has to happen inside a write lock, or a saveSpendingLimit committing between this
  // probe and the add admits a row that is never assessed and never stamped with spentUsd.
  if ((await readPolicy(transaction.accountId)) === undefined) {
    const inserted = await Repo.db.transaction(
      'rw',
      Repo.spendingLimits,
      Repo.transactions,
      Repo.recoveryDebits,
      async () => {
        if ((await readPolicy(transaction.accountId)) !== undefined) return false;
        await beforeInsert?.();
        await insert(transaction);
        return true;
      }
    );
    if (inserted) return;
    // A cap was created between the probe and the lock. Fall through to the full path, which
    // resolves the price outside the lock and assesses under it.
  }

  const price = await resolveOutgoingSpendUsd(spends, now);
  await Repo.db.transaction('rw', Repo.spendingLimits, Repo.transactions, Repo.recoveryDebits, async () => {
    await beforeInsert?.();
    await insert(await admitOutgoingTransaction(transaction, spends, price, authorization, now));
  });
};

export const queueOutgoingTransaction = async (
  transaction: ITransaction,
  spends: readonly IConsumedAssetTotal[],
  authorization?: SpendingLimitAuthorization,
  now: number = Math.floor(Date.now() / 1000),
  beforeInsert?: () => Promise<void>
): Promise<void> =>
  withFinancialRecoveryLock(async () => {
    const epoch = getStorageHealth().epoch;
    await verifyFinancialRecovery(transaction.accountId);
    let planned: ITransaction | undefined;
    await prepareOutgoingTransaction(transaction, spends, authorization, now, beforeInsert, async row => {
      planned = row;
    });
    if (planned === undefined) throw unavailable('queue preparation did not produce a row');
    const row = planned;
    const debit = recoveryDebit(row, transaction.accountId, now);
    if (debit) await checkpointFinancialChange(debit);
    await Repo.db.transaction('rw', Repo.spendingLimits, Repo.transactions, Repo.recoveryDebits, async () => {
      assertStorageHealthy(epoch);
      await beforeInsert?.();
      await Repo.transactions.add(row);
    });
  });

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
