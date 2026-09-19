import { SendTransaction, Transaction } from '../db/types';
import { spendingLimits, transactions } from '../repo';
import { NoteTypeEnum } from '../types';
import {
  assessOutgoingSpendingLimit,
  assessOutgoingSpendingLimitDetails,
  queueOutgoingTransaction,
  spendsOf
} from './queue';
import { PersistedSpendingLimit, SpendingLimitAuthorization, SpendingLimitAuthorizationRequiredError } from './types';

const NOW = 2_000_000;

const config = (overrides: Partial<PersistedSpendingLimit> = {}): PersistedSpendingLimit => ({
  accountId: 'account-a',
  faucetId: 'faucet-a',
  dailyLimit: '100',
  asset: { symbol: 'MIDEN', decimals: 8 },
  revision: 'revision-1',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
});

const outgoing = (amount: bigint, id: string): SendTransaction => {
  const transaction = new SendTransaction('account-a', amount, 'account-b', 'faucet-a', NoteTypeEnum.Public);
  transaction.id = id;
  transaction.initiatedAt = NOW;
  return transaction;
};

const authorization = (overrides: Partial<SpendingLimitAuthorization> = {}): SpendingLimitAuthorization => ({
  id: 'authorization-1',
  accountId: 'account-a',
  faucetId: 'faucet-a',
  amount: 20n,
  revision: 'revision-1',
  issuedAt: NOW - 1,
  expiresAt: NOW + 119,
  ...overrides
});

describe('queueOutgoingTransaction', () => {
  it('enforces a bare-account policy when the outgoing row uses its composite form', async () => {
    await spendingLimits.put(config());
    const candidate = outgoing(101n, 'candidate');
    candidate.accountId = 'account-a_route';

    await expect(queueOutgoingTransaction(candidate, spendsOf(candidate), undefined, NOW)).rejects.toBeInstanceOf(
      SpendingLimitAuthorizationRequiredError
    );
    await expect(transactions.get('candidate')).resolves.toBeUndefined();
  });

  it('counts history written under an equivalent composite account identity', async () => {
    await spendingLimits.put(config());
    const existing = outgoing(90n, 'existing');
    existing.accountId = 'account-a_route';
    await transactions.add(existing);

    await expect(
      queueOutgoingTransaction(outgoing(20n, 'candidate'), spendsOf(outgoing(20n, 'candidate')), undefined, NOW)
    ).rejects.toMatchObject({
      assessment: { breaches: [{ spent: 90n, proposedTotal: 110n, limit: 100n }] }
    });
    await expect(transactions.get('candidate')).resolves.toBeUndefined();
  });

  it('preflights the current policy and history without inserting a row', async () => {
    await spendingLimits.put(config());
    await transactions.add(outgoing(90n, 'existing'));

    await expect(
      assessOutgoingSpendingLimit({ accountId: 'account-a', faucetId: 'faucet-a', amount: 20n, now: NOW })
    ).resolves.toMatchObject({
      amount: 20n,
      revision: 'revision-1',
      breaches: [{ period: '24h', overBy: 10n }]
    });
    await expect(transactions.count()).resolves.toBe(1);
  });

  it('returns no preflight assessment when no policy is configured', async () => {
    await expect(
      assessOutgoingSpendingLimit({ accountId: 'account-a', faucetId: 'faucet-a', amount: 20n, now: NOW })
    ).resolves.toBeUndefined();
  });

  it('returns the persisted asset snapshot with dApp preflight details', async () => {
    await spendingLimits.put(config());
    await transactions.add(outgoing(90n, 'existing'));

    await expect(
      assessOutgoingSpendingLimitDetails({ accountId: 'account-a', faucetId: 'faucet-a', amount: 20n, now: NOW })
    ).resolves.toMatchObject({
      asset: { symbol: 'MIDEN', decimals: 8 },
      assessment: { amount: 20n, revision: 'revision-1', breaches: [{ overBy: 10n }] }
    });
  });

  it('queues when no spending limit is configured', async () => {
    await queueOutgoingTransaction(outgoing(20n, 'candidate'), spendsOf(outgoing(20n, 'candidate')), undefined, NOW);

    await expect(transactions.get('candidate')).resolves.toBeDefined();
  });

  it('queues below the configured limit without an authorization', async () => {
    await spendingLimits.put(config());

    await queueOutgoingTransaction(outgoing(100n, 'candidate'), spendsOf(outgoing(100n, 'candidate')), undefined, NOW);

    // Assert the row exists BEFORE asserting its shape: `.not.toHaveProperty` on an absent row
    // resolves undefined and passes, which is the same result as the insert never happening. This
    // is also the only test of the exact boundary proposedTotal === limit.
    await expect(transactions.get('candidate')).resolves.toMatchObject({ amount: 100n });
    expect(await transactions.get('candidate')).not.toHaveProperty('spendingLimitAuthorizationId');
  });

  it('rejects an over-limit transaction with a structured breach and no inserted row', async () => {
    await spendingLimits.put(config());
    await transactions.add(outgoing(90n, 'existing'));

    await expect(
      queueOutgoingTransaction(outgoing(20n, 'candidate'), spendsOf(outgoing(20n, 'candidate')), undefined, NOW)
    ).rejects.toMatchObject({
      code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
      assessment: {
        accountId: 'account-a',
        faucetId: 'faucet-a',
        amount: 20n,
        breaches: [{ period: '24h', spent: 90n, proposedTotal: 110n, limit: 100n }]
      }
    });
    await expect(transactions.get('candidate')).resolves.toBeUndefined();
  });

  it('fails closed when a matching policy record is malformed', async () => {
    await spendingLimits.put(config({ dailyLimit: '01' }));

    await expect(
      queueOutgoingTransaction(outgoing(20n, 'candidate'), spendsOf(outgoing(20n, 'candidate')), undefined, NOW)
    ).rejects.toThrow(/policy is unavailable/i);
    await expect(transactions.get('candidate')).resolves.toBeUndefined();
  });

  it('turns a policy storage read failure into a fail-closed policy error', async () => {
    const read = jest.spyOn(spendingLimits, 'get').mockRejectedValueOnce(new Error('storage offline'));

    try {
      await expect(
        queueOutgoingTransaction(outgoing(20n, 'candidate'), spendsOf(outgoing(20n, 'candidate')), undefined, NOW)
      ).rejects.toThrow(/policy is unavailable/i);
      await expect(transactions.get('candidate')).resolves.toBeUndefined();
    } finally {
      read.mockRestore();
    }
  });

  it('reads history through the initiatedAt index rather than the whole table', async () => {
    await spendingLimits.put(config());
    const where = jest.spyOn(transactions, 'where');

    try {
      await queueOutgoingTransaction(outgoing(20n, 'candidate'), spendsOf(outgoing(20n, 'candidate')), undefined, NOW);
      // The scan runs inside the rw lock on `transactions`, so an unbounded read is backpressure
      // on the write path that grows with total wallet history. Only the widest window matters.
      expect(where).toHaveBeenCalledWith('initiatedAt');
    } finally {
      where.mockRestore();
    }
  });

  it('turns a history read failure into a fail-closed policy error', async () => {
    await spendingLimits.put(config());
    // Targets `where`, not `toArray`: the history read is a bounded range scan over the
    // `initiatedAt` index, so a spy on the table's own toArray no longer intercepts it and this
    // fail-closed contract would pass while testing nothing.
    const read = jest.spyOn(transactions, 'where').mockImplementationOnce(() => {
      throw new Error('history offline');
    });

    try {
      await expect(
        queueOutgoingTransaction(outgoing(20n, 'candidate'), spendsOf(outgoing(20n, 'candidate')), undefined, NOW)
      ).rejects.toThrow(/policy is unavailable/i);
      await expect(transactions.get('candidate')).resolves.toBeUndefined();
    } finally {
      read.mockRestore();
    }
  });

  it.each([
    ['account mismatch', { accountId: 'account-b' }],
    ['faucet mismatch', { faucetId: 'faucet-b' }],
    ['amount mismatch', { amount: 21n }],
    ['stale revision', { revision: 'revision-old' }],
    ['expired', { expiresAt: NOW }],
    ['issued in the future', { issuedAt: NOW + 1, expiresAt: NOW + 2 }],
    ['lifetime over two minutes', { issuedAt: NOW - 1, expiresAt: NOW + 120 }],
    ['missing id', { id: '' }]
  ])('rejects an over-limit transaction with %s authorization', async (_label, overrides) => {
    await spendingLimits.put(config());
    await transactions.add(outgoing(90n, 'existing'));

    await expect(
      queueOutgoingTransaction(
        outgoing(20n, 'candidate'),
        spendsOf(outgoing(20n, 'candidate')),
        authorization(overrides),
        NOW
      )
    ).rejects.toBeInstanceOf(SpendingLimitAuthorizationRequiredError);
    await expect(transactions.get('candidate')).resolves.toBeUndefined();
  });

  it('consumes one exact authorization on the inserted row', async () => {
    await spendingLimits.put(config());
    await transactions.add(outgoing(90n, 'existing'));

    await queueOutgoingTransaction(
      outgoing(20n, 'candidate'),
      spendsOf(outgoing(20n, 'candidate')),
      authorization(),
      NOW
    );

    await expect(transactions.get('candidate')).resolves.toMatchObject({
      spendingLimitAuthorizationId: 'authorization-1'
    });
  });

  it('rejects replay of an authorization already attached to a row', async () => {
    await spendingLimits.put(config());
    await transactions.add(outgoing(90n, 'existing'));
    await queueOutgoingTransaction(outgoing(20n, 'first'), spendsOf(outgoing(20n, 'first')), authorization(), NOW);

    await expect(
      queueOutgoingTransaction(outgoing(20n, 'replay'), spendsOf(outgoing(20n, 'replay')), authorization(), NOW)
    ).rejects.toBeInstanceOf(SpendingLimitAuthorizationRequiredError);
    await expect(transactions.get('replay')).resolves.toBeUndefined();
  });

  it('serializes concurrent insertions so both cannot consume the same remaining allowance', async () => {
    await spendingLimits.put(config());

    const results = await Promise.allSettled([
      queueOutgoingTransaction(outgoing(60n, 'first'), spendsOf(outgoing(60n, 'first')), undefined, NOW),
      queueOutgoingTransaction(outgoing(60n, 'second'), spendsOf(outgoing(60n, 'second')), undefined, NOW)
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await transactions.count()).toBe(1);
  });

  it('rechecks a previously allowed preflight after a preceding insertion wins the race', async () => {
    await spendingLimits.put(config());
    await queueOutgoingTransaction(outgoing(60n, 'first'), spendsOf(outgoing(60n, 'first')), undefined, NOW);

    await expect(
      queueOutgoingTransaction(outgoing(60n, 'raced'), spendsOf(outgoing(60n, 'raced')), undefined, NOW)
    ).rejects.toMatchObject({
      assessment: { breaches: [{ spent: 60n, proposedTotal: 120n, limit: 100n }] }
    });
    await expect(transactions.get('raced')).resolves.toBeUndefined();
  });
});

describe('queueOutgoingTransaction with a multi-asset spend list', () => {
  const custom = (totals: { faucetId: string; amount: bigint }[]) => {
    const transaction = new Transaction('account-a', new Uint8Array([1]), undefined, undefined, undefined, totals);
    transaction.id = 'candidate';
    transaction.initiatedAt = NOW;
    return { ...transaction, spentAssetTotals: totals };
  };

  it('queues a custom transaction whose simulated spend is under the limit', async () => {
    await spendingLimits.put(config());

    await queueOutgoingTransaction(
      custom([{ faucetId: 'faucet-a', amount: 100n }]),
      [{ faucetId: 'faucet-a', amount: 100n }],
      undefined,
      NOW
    );

    await expect(transactions.get('candidate')).resolves.toMatchObject({ spentAssetTotals: [{ amount: 100n }] });
  });

  it('refuses an over-limit custom transaction that carries no authorization', async () => {
    await spendingLimits.put(config());

    await expect(
      queueOutgoingTransaction(
        custom([{ faucetId: 'faucet-a', amount: 101n }]),
        [{ faucetId: 'faucet-a', amount: 101n }],
        undefined,
        NOW
      )
    ).rejects.toBeInstanceOf(SpendingLimitAuthorizationRequiredError);
    await expect(transactions.get('candidate')).resolves.toBeUndefined();
  });

  it('admits an over-limit custom transaction bound to a matching authorization', async () => {
    await spendingLimits.put(config());

    await queueOutgoingTransaction(
      custom([{ faucetId: 'faucet-a', amount: 101n }]),
      [{ faucetId: 'faucet-a', amount: 101n }],
      authorization({ amount: 101n }),
      NOW
    );

    await expect(transactions.get('candidate')).resolves.toMatchObject({
      spendingLimitAuthorizationId: 'authorization-1'
    });
  });

  it('refuses outright when two faucets breach at once', async () => {
    await spendingLimits.put(config());
    await spendingLimits.put(config({ faucetId: 'faucet-b' }));

    // One one-time credential binds to exactly one (account, faucet, amount), so two breaches
    // cannot be authorized in a single step and the request is refused rather than half-allowed.
    await expect(
      queueOutgoingTransaction(
        custom([
          { faucetId: 'faucet-a', amount: 101n },
          { faucetId: 'faucet-b', amount: 101n }
        ]),
        [
          { faucetId: 'faucet-a', amount: 101n },
          { faucetId: 'faucet-b', amount: 101n }
        ],
        authorization({ amount: 101n }),
        NOW
      )
    ).rejects.toThrow(/more than one spending limit/i);
    await expect(transactions.get('candidate')).resolves.toBeUndefined();
  });

  it('ignores faucets that have no configured limit', async () => {
    await spendingLimits.put(config());

    await queueOutgoingTransaction(
      custom([{ faucetId: 'faucet-unlimited', amount: 10_000n }]),
      [{ faucetId: 'faucet-unlimited', amount: 10_000n }],
      undefined,
      NOW
    );

    await expect(transactions.get('candidate')).resolves.toBeDefined();
  });
});
