import { assessSpendingLimit } from './policy';
import { SpendingLimitConfiguration, SpendingLimitPolicyUnavailableError } from './types';
import { ITransaction, ITransactionStatus, ITransactionType } from '../db/types';

const DAY = 86_400;
const ACCOUNT = 'account-a';
const NOW = 2_000_000;

const config = (limit: bigint): SpendingLimitConfiguration => ({
  accountId: ACCOUNT,
  limit,
  revision: 'revision-1',
  createdAt: 1,
  updatedAt: 1
});

const row = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'transaction-1',
  type: 'send',
  accountId: ACCOUNT,
  spentUsd: 10_000_000n,
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

const malformedProposal = <T extends object>(base: T, field: string, value: unknown): T => {
  const proposal = { ...base };
  Reflect.set(proposal, field, value);
  return proposal;
};

describe('assessSpendingLimit', () => {
  it('sums stamped dollar values inside the window', () => {
    const rows = [
      row({ initiatedAt: 1_000, spentUsd: 30_000_000n }),
      row({ initiatedAt: 1_500, spentUsd: 20_000_000n })
    ];

    const assessment = assessSpendingLimit(config(100_000_000n), rows, {
      accountId: ACCOUNT,
      usdAmount: 60_000_000n,
      now: 2_000
    });

    expect(assessment.breach).toMatchObject({ spent: 50_000_000n, proposedTotal: 110_000_000n, overBy: 10_000_000n });
  });

  it('ignores a row that carries no stamped value', () => {
    const rows = [row({ initiatedAt: 1_000, spentUsd: undefined, amount: 999n, faucetId: 'eth' })];

    const assessment = assessSpendingLimit(config(100_000_000n), rows, {
      accountId: ACCOUNT,
      usdAmount: 1n,
      now: 2_000
    });

    expect(assessment.breach).toBeUndefined();
  });

  it('expires a row at the exact 24-hour boundary', () => {
    const rows = [row({ initiatedAt: 1_000, spentUsd: 100_000_000n })];

    const assessment = assessSpendingLimit(config(100_000_000n), rows, {
      accountId: ACCOUNT,
      usdAmount: 1n,
      now: 1_000 + DAY
    });

    expect(assessment.breach).toBeUndefined();
  });

  it('reports when the window frees enough room', () => {
    const rows = [
      row({ id: 'oldest', initiatedAt: NOW - DAY + 100, spentUsd: 20_000_000n }),
      row({ id: 'newest', initiatedAt: NOW - 20, spentUsd: 70_000_000n })
    ];

    const assessment = assessSpendingLimit(config(100_000_000n), rows, {
      accountId: ACCOUNT,
      usdAmount: 30_000_000n,
      now: NOW
    });

    // spent = 90M, proposedTotal = 120M, overBy = 20M. Only the oldest row (20M) needs to expire
    // to free enough room, so resetAt is that row's own initiatedAt + 86400.
    expect(assessment.breach).toMatchObject({
      spent: 90_000_000n,
      proposedTotal: 120_000_000n,
      overBy: 20_000_000n,
      resetAt: NOW - DAY + 100 + DAY
    });
  });

  it('reports no automatic reset when the proposal alone exceeds the cap', () => {
    const rows = [row({ initiatedAt: NOW - 20, spentUsd: 10_000_000n })];

    const assessment = assessSpendingLimit(config(100_000_000n), rows, {
      accountId: ACCOUNT,
      usdAmount: 150_000_000n,
      now: NOW
    });

    expect(assessment.breach?.resetAt).toBeNull();
  });

  it('excludes rows restored from backup', () => {
    const rows = [row({ initiatedAt: NOW - 20, spentUsd: 100_000_000n, restoredFromBackup: true })];

    const assessment = assessSpendingLimit(config(50_000_000n), rows, {
      accountId: ACCOUNT,
      usdAmount: 10_000_000n,
      now: NOW
    });

    expect(assessment.breach).toBeUndefined();
  });

  it.each<ITransactionType>(['send', 'swap', 'bridged-send', 'earn-deposit', 'execute'])(
    'counts %s as outgoing spend',
    type => {
      const rows = [row({ type, initiatedAt: NOW - 20, spentUsd: 90_000_000n })];

      const assessment = assessSpendingLimit(config(100_000_000n), rows, {
        accountId: ACCOUNT,
        usdAmount: 20_000_000n,
        now: NOW
      });

      expect(assessment.breach).toMatchObject({ spent: 90_000_000n, proposedTotal: 110_000_000n });
    }
  );

  it.each<ITransactionType>(['consume', 'earn-withdraw', 'switch-guardian'])(
    'excludes incoming and structural type %s',
    type => {
      const rows = [row({ type, initiatedAt: NOW - 20, spentUsd: 100_000_000n })];

      const assessment = assessSpendingLimit(config(50_000_000n), rows, {
        accountId: ACCOUNT,
        usdAmount: 10_000_000n,
        now: NOW
      });

      expect(assessment.breach).toBeUndefined();
    }
  );

  it.each([
    ITransactionStatus.Queued,
    ITransactionStatus.GeneratingTransaction,
    ITransactionStatus.Completed,
    ITransactionStatus.Failed
  ])('includes a matching row in status %s', status => {
    const rows = [row({ status, initiatedAt: NOW - 20, spentUsd: 90_000_000n })];

    const assessment = assessSpendingLimit(config(100_000_000n), rows, {
      accountId: ACCOUNT,
      usdAmount: 20_000_000n,
      now: NOW
    });

    expect(assessment.breach).toMatchObject({ spent: 90_000_000n, proposedTotal: 110_000_000n });
  });

  it('charges a future-dated row at now', () => {
    const rows = [row({ initiatedAt: NOW + DAY, spentUsd: 90_000_000n })];

    const assessment = assessSpendingLimit(config(100_000_000n), rows, {
      accountId: ACCOUNT,
      usdAmount: 20_000_000n,
      now: NOW
    });

    // Counted, so it still breaches the cap - a clock correction must not buy allowance. `resetAt`
    // is the assertion that can actually fail: charging the row at NOW retires it one day from NOW,
    // whereas leaving the future stamp alone would hold it in the window until NOW + 2 days.
    expect(assessment.breach).toMatchObject({ spent: 90_000_000n, proposedTotal: 110_000_000n, resetAt: NOW + DAY });
  });

  it('throws on a row inside the window whose stamped value is not a bigint', () => {
    const bad = malformedRow('spentUsd', '90000000');
    bad.initiatedAt = NOW - 20;

    expect(() =>
      assessSpendingLimit(config(100_000_000n), [bad], { accountId: ACCOUNT, usdAmount: 1n, now: NOW })
    ).toThrow(SpendingLimitPolicyUnavailableError);
  });

  it('skips a malformed row older than the window', () => {
    const stale = malformedRow('status', 99);
    stale.initiatedAt = NOW - DAY - 1;

    const assessment = assessSpendingLimit(config(100_000_000n), [stale], {
      accountId: ACCOUNT,
      usdAmount: 1n,
      now: NOW
    });

    // One corrupt historical row must not make the account permanently unspendable.
    expect(assessment.breach).toBeUndefined();
  });

  it('counts equivalent stored account identities in the same rolling allowance', () => {
    const rows = [row({ accountId: `${ACCOUNT}_route`, initiatedAt: NOW - 20, spentUsd: 90_000_000n })];

    const assessment = assessSpendingLimit(config(100_000_000n), rows, {
      accountId: ACCOUNT,
      usdAmount: 20_000_000n,
      now: NOW
    });

    expect(assessment.breach).toMatchObject({ spent: 90_000_000n, proposedTotal: 110_000_000n });
  });

  it('fails closed when the proposal account does not match the configuration', () => {
    expect(() =>
      assessSpendingLimit(config(100_000_000n), [], { accountId: 'account-b', usdAmount: 1n, now: NOW })
    ).toThrow(SpendingLimitPolicyUnavailableError);
  });

  it('fails closed for a non-bigint proposed amount', () => {
    const proposal = malformedProposal({ accountId: ACCOUNT, usdAmount: 1n, now: NOW }, 'usdAmount', '1');

    expect(() => assessSpendingLimit(config(100_000_000n), [row()], proposal)).toThrow(
      SpendingLimitPolicyUnavailableError
    );
  });

  it.each<[string, ITransaction[], { usdAmount: bigint; now: number }]>([
    ['negative proposed amount', [row()], { usdAmount: -1n, now: NOW }],
    ['negative assessment time', [row()], { usdAmount: 1n, now: -1 }],
    ['fractional assessment time', [row()], { usdAmount: 1n, now: 1.5 }],
    ['negative row spentUsd', [row({ spentUsd: -1n })], { usdAmount: 1n, now: NOW }],
    ['unknown row status', [malformedRow('status', 99)], { usdAmount: 1n, now: NOW }],
    ['non-integer row timestamp', [row({ initiatedAt: 1.5 })], { usdAmount: 1n, now: NOW }]
  ])('fails closed for a %s', (_label, rows, proposal) => {
    expect(() => assessSpendingLimit(config(100_000_000n), rows, { accountId: ACCOUNT, ...proposal })).toThrow(
      SpendingLimitPolicyUnavailableError
    );
  });

  it('fails closed when the configured limit is negative', () => {
    expect(() => assessSpendingLimit(config(-1n), [], { accountId: ACCOUNT, usdAmount: 1n, now: NOW })).toThrow(
      SpendingLimitPolicyUnavailableError
    );
  });
});
