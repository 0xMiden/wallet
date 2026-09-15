import { assessSpendingLimit } from './policy';
import { SpendingLimitConfiguration, SpendingLimitPolicyUnavailableError } from './types';
import { ITransaction, ITransactionStatus, ITransactionType } from '../db/types';

const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const NOW = 2_000_000;

const config: SpendingLimitConfiguration = {
  accountId: 'account-a',
  faucetId: 'faucet-a',
  dailyLimit: 100n,
  weeklyLimit: 250n,
  asset: { symbol: 'MIDEN', decimals: 8 },
  revision: 'revision-1',
  createdAt: 1,
  updatedAt: 1
};

const row = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'transaction-1',
  type: 'send',
  accountId: config.accountId,
  faucetId: config.faucetId,
  amount: 10n,
  status: ITransactionStatus.Completed,
  initiatedAt: NOW - 1,
  displayIcon: 'SEND',
  ...overrides
});

const malformedRow = (field: string, value: unknown): ITransaction => {
  const transaction = row();
  Reflect.set(transaction, field, value);
  return transaction;
};

describe('assessSpendingLimit', () => {
  it('counts equivalent stored account identities in the same rolling allowance', () => {
    const assessment = assessSpendingLimit(config, [row({ accountId: 'account-a_route', amount: 90n })], {
      accountId: 'account-a',
      faucetId: config.faucetId,
      amount: 11n,
      now: NOW
    });

    expect(assessment.breaches).toEqual([
      { period: '24h', spent: 90n, proposedTotal: 101n, limit: 100n, overBy: 1n, resetAt: NOW - 1 + DAY }
    ]);
  });

  it.each([
    ITransactionStatus.Queued,
    ITransactionStatus.GeneratingTransaction,
    ITransactionStatus.Completed,
    ITransactionStatus.Failed
  ])('reserves matching outgoing rows in status %s', status => {
    const assessment = assessSpendingLimit(config, [row({ status, amount: 90n })], {
      accountId: config.accountId,
      faucetId: config.faucetId,
      amount: 11n,
      now: NOW
    });

    expect(assessment.breaches).toEqual([
      { period: '24h', spent: 90n, proposedTotal: 101n, limit: 100n, overBy: 1n, resetAt: NOW - 1 + DAY }
    ]);
  });

  it.each<ITransactionType>(['send', 'swap', 'bridged-send', 'earn-deposit'])('counts %s as outgoing spend', type => {
    const assessment = assessSpendingLimit(config, [row({ type, amount: 90n })], {
      accountId: config.accountId,
      faucetId: config.faucetId,
      amount: 11n,
      now: NOW
    });

    expect(assessment.breaches.map(breach => breach.period)).toEqual(['24h']);
  });

  it('isolates account and faucet and excludes non-spend, restored, and expired rows', () => {
    const rows = [
      row({ id: 'other-account', accountId: 'account-b', amount: 100n }),
      row({ id: 'other-faucet', faucetId: 'faucet-b', amount: 100n }),
      row({ id: 'consume', type: 'consume', amount: 100n }),
      row({ id: 'receive', type: 'bridged-receive', amount: 100n }),
      row({ id: 'withdraw', type: 'earn-withdraw', amount: 100n }),
      row({ id: 'structural', type: 'replace-hot-key', amount: 100n }),
      row({ id: 'restored', restoredFromBackup: true, amount: 100n }),
      row({ id: 'daily-boundary', initiatedAt: NOW - DAY, amount: 100n }),
      row({ id: 'weekly-boundary', initiatedAt: NOW - WEEK, amount: 100n })
    ];

    const assessment = assessSpendingLimit(config, rows, {
      accountId: config.accountId,
      faucetId: config.faucetId,
      amount: 100n,
      now: NOW
    });

    expect(assessment.breaches).toEqual([]);
  });

  it('reports daily and weekly breaches in deterministic order with the earliest sufficient reset', () => {
    const bothPeriods = { ...config, weeklyLimit: 200n };
    const rows = [
      row({ id: 'old-week', initiatedAt: NOW - 6 * DAY, amount: 80n }),
      row({ id: 'old-day', initiatedAt: NOW - DAY + 10, amount: 30n }),
      row({ id: 'new-day', initiatedAt: NOW - 20, amount: 60n })
    ];

    const assessment = assessSpendingLimit(bothPeriods, rows, {
      accountId: config.accountId,
      faucetId: config.faucetId,
      amount: 50n,
      now: NOW
    });

    expect(assessment).toEqual({
      accountId: config.accountId,
      faucetId: config.faucetId,
      amount: 50n,
      revision: config.revision,
      assessedAt: NOW,
      breaches: [
        { period: '24h', spent: 90n, proposedTotal: 140n, limit: 100n, overBy: 40n, resetAt: NOW - 20 + DAY },
        {
          period: '7d',
          spent: 170n,
          proposedTotal: 220n,
          limit: 200n,
          overBy: 20n,
          resetAt: NOW - 6 * DAY + WEEK
        }
      ]
    });
  });

  it('finds the weekly reset after enough oldest rows expire', () => {
    const weeklyOnly = { ...config, dailyLimit: undefined, weeklyLimit: 100n };
    const assessment = assessSpendingLimit(
      weeklyOnly,
      [
        row({ id: 'oldest', initiatedAt: NOW - 6 * DAY, amount: 20n }),
        row({ id: 'middle', initiatedAt: NOW - 5 * DAY, amount: 30n }),
        row({ id: 'newest', initiatedAt: NOW - DAY, amount: 40n })
      ],
      { accountId: config.accountId, faucetId: config.faucetId, amount: 50n, now: NOW }
    );

    expect(assessment.breaches).toEqual([
      {
        period: '7d',
        spent: 90n,
        proposedTotal: 140n,
        limit: 100n,
        overBy: 40n,
        resetAt: NOW - 5 * DAY + WEEK
      }
    ]);
  });

  it('uses a null reset when the proposed amount alone exceeds the cap', () => {
    const assessment = assessSpendingLimit(config, [row({ amount: 20n })], {
      accountId: config.accountId,
      faucetId: config.faucetId,
      amount: 101n,
      now: NOW
    });

    expect(assessment.breaches[0]?.resetAt).toBeNull();
  });

  it.each([
    ['negative proposed amount', [row()], { amount: -1n, now: NOW }],
    ['non-bigint proposed amount', [row()], { amount: 1 as unknown as bigint, now: NOW }],
    ['negative assessment time', [row()], { amount: 1n, now: -1 }],
    ['fractional assessment time', [row()], { amount: 1n, now: 1.5 }],
    ['future row', [row({ initiatedAt: NOW + 1 })], { amount: 1n, now: NOW }],
    ['negative row amount', [row({ amount: -1n })], { amount: 1n, now: NOW }],
    ['missing row amount', [row({ amount: undefined })], { amount: 1n, now: NOW }],
    ['unknown row status', [malformedRow('status', 99)], { amount: 1n, now: NOW }],
    ['non-integer row timestamp', [row({ initiatedAt: 1.5 })], { amount: 1n, now: NOW }]
  ])('fails closed for a %s', (_label, rows, proposal) => {
    expect(() =>
      assessSpendingLimit(config, rows, {
        accountId: config.accountId,
        faucetId: config.faucetId,
        ...proposal
      })
    ).toThrow(SpendingLimitPolicyUnavailableError);
  });

  it('fails closed when the proposal does not match the configuration identity', () => {
    expect(() =>
      assessSpendingLimit(config, [], {
        accountId: 'account-b',
        faucetId: config.faucetId,
        amount: 1n,
        now: NOW
      })
    ).toThrow(SpendingLimitPolicyUnavailableError);
  });

  it('fails closed when no rolling period is configured', () => {
    expect(() =>
      assessSpendingLimit({ ...config, dailyLimit: undefined, weeklyLimit: undefined }, [], {
        accountId: config.accountId,
        faucetId: config.faucetId,
        amount: 1n,
        now: NOW
      })
    ).toThrow(SpendingLimitPolicyUnavailableError);
  });
});
