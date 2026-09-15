import { SpendingLimitPolicyUnavailableError, parsePersistedSpendingLimit, toPersistedSpendingLimit } from './types';

describe('spending-limit persistence types', () => {
  const configured = {
    accountId: 'account-a',
    faucetId: 'faucet-a',
    dailyLimit: 123456789012345678901234567890n,
    weeklyLimit: 999999999999999999999999999999n,
    asset: { symbol: 'MIDEN', decimals: 8, name: 'Miden' },
    revision: 'revision-1',
    createdAt: 100,
    updatedAt: 200
  };

  it('round-trips limits through canonical decimal strings without losing bigint precision', () => {
    const persisted = toPersistedSpendingLimit(configured);

    expect(persisted).toEqual({
      ...configured,
      dailyLimit: '123456789012345678901234567890',
      weeklyLimit: '999999999999999999999999999999'
    });
    expect(parsePersistedSpendingLimit(persisted)).toEqual(configured);
  });

  it('returns no record when neither rolling period is configured', () => {
    expect(toPersistedSpendingLimit({ ...configured, dailyLimit: undefined, weeklyLimit: undefined })).toBeUndefined();
  });

  it.each([
    ['negative daily domain amount', { ...configured, dailyLimit: -1n }],
    ['negative weekly domain amount', { ...configured, weeklyLimit: -1n }],
    ['missing account id', { ...configured, accountId: '' }],
    ['missing faucet id', { ...configured, faucetId: '' }],
    ['missing revision', { ...configured, revision: '' }],
    ['invalid decimals', { ...configured, asset: { symbol: 'MIDEN', decimals: -1 } }],
    ['invalid timestamp order', { ...configured, createdAt: 201, updatedAt: 200 }]
  ])('rejects %s', (_label, value) => {
    expect(() => toPersistedSpendingLimit(value)).toThrow(SpendingLimitPolicyUnavailableError);
  });

  it.each([
    ['non-canonical leading zero', { ...configured, dailyLimit: '01', weeklyLimit: undefined }],
    ['negative persisted amount', { ...configured, dailyLimit: '-1', weeklyLimit: undefined }],
    ['missing periods', { ...configured, dailyLimit: undefined, weeklyLimit: undefined }],
    ['number instead of decimal string', { ...configured, dailyLimit: 1, weeklyLimit: undefined }],
    ['missing asset snapshot', { ...configured, dailyLimit: '1', weeklyLimit: undefined, asset: undefined }],
    ['malformed record', null]
  ])('rejects %s', (_label, value) => {
    expect(() => parsePersistedSpendingLimit(value)).toThrow(SpendingLimitPolicyUnavailableError);
  });

  it('defines a stable unavailable-policy error code', () => {
    const error = new SpendingLimitPolicyUnavailableError('broken policy');

    expect(error.name).toBe('SpendingLimitPolicyUnavailableError');
    expect(error.code).toBe('SPENDING_LIMIT_POLICY_UNAVAILABLE');
    expect(error.message).toBe('broken policy');
  });
});
