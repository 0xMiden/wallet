import { createSpendingLimitAuthorization, createUnpricedSpendingLimitAuthorization } from './authorization';
import { SpendingLimitAssessment, spendsDigest } from './types';

const assessment: SpendingLimitAssessment = {
  accountId: 'account-a',
  usdAmount: 20n,
  revision: 'revision-1',
  assessedAt: 100,
  breach: { spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 }
};

describe('createSpendingLimitAuthorization', () => {
  it('binds a short-lived usd authorization to the exact assessed proposal', () => {
    expect(createSpendingLimitAuthorization(assessment, 120, () => 'authorization-1')).toEqual({
      kind: 'usd',
      id: 'authorization-1',
      accountId: 'account-a',
      usdAmount: 20n,
      revision: 'revision-1',
      issuedAt: 120,
      expiresAt: 240
    });
  });

  const invalidCases: Array<[string, number, () => string, SpendingLimitAssessment?]> = [
    ['empty id', 120, (): string => '', undefined],
    ['time before assessment', 99, (): string => 'authorization-1', undefined],
    ['non-integer time', 120.5, (): string => 'authorization-1', undefined],
    ['assessment without a breach', 120, (): string => 'authorization-1', { ...assessment, breach: undefined }]
  ];

  it.each(invalidCases)('fails closed for %s', (_label, now, makeId, candidate) => {
    expect(() => createSpendingLimitAuthorization(candidate ?? assessment, now, makeId)).toThrow(
      /spending limit policy is unavailable/i
    );
  });
});

describe('createUnpricedSpendingLimitAuthorization', () => {
  const spends = [
    { faucetId: 'eth', amount: 1n },
    { faucetId: 'usdc', amount: 2n }
  ];

  it('binds a short-lived unpriced authorization to the exact digest of the given spends', () => {
    expect(
      createUnpricedSpendingLimitAuthorization('account-a', spends, 'revision-1', 120, () => 'authorization-1')
    ).toEqual({
      kind: 'unpriced',
      id: 'authorization-1',
      accountId: 'account-a',
      spendsDigest: spendsDigest(spends),
      revision: 'revision-1',
      issuedAt: 120,
      expiresAt: 240
    });
  });

  it('digests order-independently, so a differently ordered spend list still matches', () => {
    const reordered = [spends[1]!, spends[0]!];

    const authorization = createUnpricedSpendingLimitAuthorization(
      'account-a',
      spends,
      'revision-1',
      120,
      () => 'authorization-1'
    );

    expect(authorization.kind).toBe('unpriced');
    expect(authorization.kind === 'unpriced' && authorization.spendsDigest).toBe(spendsDigest(reordered));
  });

  it.each<[string, string, string, number, () => string]>([
    ['empty id', 'account-a', 'revision-1', 120, () => ''],
    ['empty account id', '', 'revision-1', 120, () => 'authorization-1'],
    ['empty revision', 'account-a', '', 120, () => 'authorization-1'],
    ['non-integer time', 'account-a', 'revision-1', 120.5, () => 'authorization-1'],
    ['negative time', 'account-a', 'revision-1', -1, () => 'authorization-1']
  ])('fails closed for %s', (_label, accountId, revision, issuedAt, makeId) => {
    expect(() => createUnpricedSpendingLimitAuthorization(accountId, spends, revision, issuedAt, makeId)).toThrow(
      /spending limit policy is unavailable/i
    );
  });
});
