import { createSpendingLimitAuthorization } from './authorization';
import { SpendingLimitAssessment } from './types';

const assessment = {
  accountId: 'account-a',
  faucetId: 'faucet-a',
  amount: 20n,
  revision: 'revision-1',
  assessedAt: 100,
  breaches: [{ period: '24h' as const, spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 }]
};

describe('createSpendingLimitAuthorization', () => {
  it('binds a short-lived authorization to the exact assessed proposal', () => {
    expect(createSpendingLimitAuthorization(assessment, 120, () => 'authorization-1')).toEqual({
      id: 'authorization-1',
      accountId: 'account-a',
      faucetId: 'faucet-a',
      amount: 20n,
      revision: 'revision-1',
      issuedAt: 120,
      expiresAt: 240
    });
  });

  const invalidCases: Array<[string, number, () => string, SpendingLimitAssessment?]> = [
    ['empty id', 120, (): string => '', undefined],
    ['time before assessment', 99, (): string => 'authorization-1', undefined],
    ['non-integer time', 120.5, (): string => 'authorization-1', undefined],
    ['assessment without a breach', 120, (): string => 'authorization-1', { ...assessment, breaches: [] }]
  ];

  it.each(invalidCases)('fails closed for %s', (_label, now, makeId, candidate) => {
    expect(() => createSpendingLimitAuthorization(candidate ?? assessment, now, makeId)).toThrow(
      /spending limit policy is unavailable/i
    );
  });
});
