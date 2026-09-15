import { SendTransaction } from '../db/types';
import { spendingLimits, transactions } from '../repo';
import { NoteTypeEnum } from '../types';
import { assessOutgoingSpendingLimit, assessOutgoingSpendingLimitDetails, queueOutgoingTransaction } from './queue';
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
    await queueOutgoingTransaction(outgoing(20n, 'candidate'), undefined, NOW);

    await expect(transactions.get('candidate')).resolves.toBeDefined();
  });

  it('queues below the configured limit without an authorization', async () => {
    await spendingLimits.put(config());

    await queueOutgoingTransaction(outgoing(100n, 'candidate'), undefined, NOW);

    expect(await transactions.get('candidate')).not.toHaveProperty('spendingLimitAuthorizationId');
  });

  it('rejects an over-limit transaction with a structured breach and no inserted row', async () => {
    await spendingLimits.put(config());
    await transactions.add(outgoing(90n, 'existing'));

    await expect(queueOutgoingTransaction(outgoing(20n, 'candidate'), undefined, NOW)).rejects.toMatchObject({
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

    await expect(queueOutgoingTransaction(outgoing(20n, 'candidate'), undefined, NOW)).rejects.toThrow(
      /policy is unavailable/i
    );
    await expect(transactions.get('candidate')).resolves.toBeUndefined();
  });

  it('turns a policy storage read failure into a fail-closed policy error', async () => {
    const read = jest.spyOn(spendingLimits, 'get').mockRejectedValueOnce(new Error('storage offline'));

    try {
      await expect(queueOutgoingTransaction(outgoing(20n, 'candidate'), undefined, NOW)).rejects.toThrow(
        /policy is unavailable/i
      );
      await expect(transactions.get('candidate')).resolves.toBeUndefined();
    } finally {
      read.mockRestore();
    }
  });

  it('turns a history read failure into a fail-closed policy error', async () => {
    await spendingLimits.put(config());
    const read = jest.spyOn(transactions, 'where').mockImplementationOnce(() => {
      throw new Error('history offline');
    });

    try {
      await expect(queueOutgoingTransaction(outgoing(20n, 'candidate'), undefined, NOW)).rejects.toThrow(
        /policy is unavailable/i
      );
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
      queueOutgoingTransaction(outgoing(20n, 'candidate'), authorization(overrides), NOW)
    ).rejects.toBeInstanceOf(SpendingLimitAuthorizationRequiredError);
    await expect(transactions.get('candidate')).resolves.toBeUndefined();
  });

  it('consumes one exact authorization on the inserted row', async () => {
    await spendingLimits.put(config());
    await transactions.add(outgoing(90n, 'existing'));

    await queueOutgoingTransaction(outgoing(20n, 'candidate'), authorization(), NOW);

    await expect(transactions.get('candidate')).resolves.toMatchObject({
      spendingLimitAuthorizationId: 'authorization-1'
    });
  });

  it('rejects replay of an authorization already attached to a row', async () => {
    await spendingLimits.put(config());
    await transactions.add(outgoing(90n, 'existing'));
    await queueOutgoingTransaction(outgoing(20n, 'first'), authorization(), NOW);

    await expect(queueOutgoingTransaction(outgoing(20n, 'replay'), authorization(), NOW)).rejects.toBeInstanceOf(
      SpendingLimitAuthorizationRequiredError
    );
    await expect(transactions.get('replay')).resolves.toBeUndefined();
  });

  it('serializes concurrent insertions so both cannot consume the same remaining allowance', async () => {
    await spendingLimits.put(config());

    const results = await Promise.allSettled([
      queueOutgoingTransaction(outgoing(60n, 'first'), undefined, NOW),
      queueOutgoingTransaction(outgoing(60n, 'second'), undefined, NOW)
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await transactions.count()).toBe(1);
  });

  it('rechecks a previously allowed preflight after a preceding insertion wins the race', async () => {
    await spendingLimits.put(config());
    await queueOutgoingTransaction(outgoing(60n, 'first'), undefined, NOW);

    await expect(queueOutgoingTransaction(outgoing(60n, 'raced'), undefined, NOW)).rejects.toMatchObject({
      assessment: { breaches: [{ spent: 60n, proposedTotal: 120n, limit: 100n }] }
    });
    await expect(transactions.get('raced')).resolves.toBeUndefined();
  });
});
